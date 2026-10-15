"""Consequential input and resource checks; no signing tools or accounts needed."""

import importlib.util
import contextlib
import io
import json
from pathlib import Path
import plistlib
import stat
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile


SPEC = importlib.util.spec_from_file_location('release_audit', Path(__file__).with_name('audit-ios-release.py'))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class IdentifierTests(unittest.TestCase):
    def test_development_wildcard_cannot_authorize_another_prefix(self):
        self.assertTrue(AUDIT.application_id_authorized('TEAM.com.example.app', 'TEAM.*'))
        self.assertTrue(AUDIT.application_id_authorized('TEAM.com.example.app', 'TEAM.com.example.*'))
        self.assertFalse(AUDIT.application_id_authorized('OTHER.com.example.app', 'TEAM.*'))
        self.assertFalse(AUDIT.application_id_authorized('TEAM.com.exampleevil.app', 'TEAM.com.example.*'))

    def test_exact_store_identifier_does_not_match_sibling_app(self):
        self.assertTrue(AUDIT.application_id_authorized('TEAM.com.example.app', 'TEAM.com.example.app'))
        self.assertFalse(AUDIT.application_id_authorized('TEAM.com.example.other', 'TEAM.com.example.app'))

    def test_only_final_dot_component_wildcard_is_allowed(self):
        for pattern in ('*', '*.com.example.app', 'TEAM.com.*.app', 'TEAM.com.example*', 'TEAM.**', 'TEAM.com.example.[a-z]*'):
            with self.subTest(pattern=pattern):
                self.assertFalse(AUDIT.application_id_authorized('TEAM.com.example.app', pattern))
        self.assertFalse(AUDIT.application_id_authorized('TEAM.*', 'TEAM.*'))
        self.assertFalse(AUDIT.application_id_authorized('TEAM.', 'TEAM.*'))


class ExportOptionTests(unittest.TestCase):
    def test_omitted_generated_flag_requires_matching_explicit_input_options(self):
        generated = {'method': 'debugging', 'destination': 'export', 'teamID': 'TESTTEAM'}
        requested = {**generated, 'manageAppVersionAndBuildNumber': False}
        self.assertTrue(all(AUDIT.export_option_checks(generated, 'debugging', requested).values()))
        self.assertFalse(AUDIT.export_option_checks(generated, 'debugging', {**requested, 'teamID': 'OTHER'})['requestedExportOptionsMatch'])
        self.assertFalse(AUDIT.export_option_checks(generated, 'debugging', {**requested, 'manageAppVersionAndBuildNumber': True})['noAutomaticVersionMutation'])

    def test_development_version_management_must_be_explicitly_disabled(self):
        options = {'method': 'debugging', 'destination': 'export', 'teamID': 'TESTTEAM'}
        self.assertFalse(AUDIT.export_option_checks(options, 'debugging')['noAutomaticVersionMutation'])
        options['manageAppVersionAndBuildNumber'] = False
        self.assertTrue(all(AUDIT.export_option_checks(options, 'debugging').values()))
        options['manageAppVersionAndBuildNumber'] = True
        self.assertFalse(AUDIT.export_option_checks(options, 'debugging')['noAutomaticVersionMutation'])

    def test_store_default_version_management_must_not_pass(self):
        options = {'method': 'app-store-connect', 'destination': 'export', 'teamID': 'TESTTEAM',
                   'uploadSymbols': True, 'testFlightInternalTestingOnly': False}
        self.assertFalse(AUDIT.export_option_checks(options, 'app-store-connect')['noAutomaticVersionMutation'])
        options['manageAppVersionAndBuildNumber'] = False
        self.assertTrue(all(AUDIT.export_option_checks(options, 'app-store-connect').values()))
        options['destination'] = 'upload'
        self.assertFalse(AUDIT.export_option_checks(options, 'app-store-connect')['localExportOnly'])


class ZipTests(unittest.TestCase):
    def archive(self, members):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive, warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            for name, value in members:
                archive.writestr(name, value)
        data.seek(0)
        return zipfile.ZipFile(data)

    def test_normal_ipa_directories_are_accepted(self):
        with self.archive([('Payload/', b''), ('Payload/Example.app/', b''), ('Payload/Example.app/Info.plist', b'plist')]) as archive:
            self.assertEqual(len(AUDIT.validated_zip_members(archive)), 3)

    def test_traversal_and_platform_specific_absolute_paths_are_rejected(self):
        for name in ('../outside', '/outside', 'Payload/../outside', 'Payload/./file', 'Payload//file', 'C:/outside', 'Payload\\outside'):
            with self.subTest(name=name), self.archive([(name, b'bad')]) as archive:
                with self.assertRaises(AUDIT.AuditError):
                    AUDIT.validated_zip_members(archive)

    def test_duplicates_case_unicode_and_parent_file_collisions_are_rejected(self):
        for names in (('Payload/file', 'Payload/file'), ('Payload/File', 'Payload/file'),
                      ('Payload/café', 'Payload/cafe\u0301'), ('Payload', 'Payload/App/file'),
                      ('Payload/dir', 'Payload/dir/')):
            with self.subTest(names=names), self.archive([(name, b'data') for name in names]) as archive:
                with self.assertRaises(AUDIT.AuditError):
                    AUDIT.validated_zip_members(archive)

    def test_symlink_rejected_before_any_extraction(self):
        link = zipfile.ZipInfo('Payload/Example.app/link')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ipa = root / 'bad.ipa'
            with self.archive([('Payload/Example.app/safe', b'safe'), (link, b'../../../outside')]) as archive:
                ipa.write_bytes(archive.fp.getvalue())
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.extract_ipa(ipa, root / 'unpacked')
            self.assertFalse((root / 'unpacked').exists())


class BundleTests(unittest.TestCase):
    def test_private_and_test_artifacts_cannot_hide_in_subdirectories(self):
        for name in ('PlugIns/Tests.xctest/Info.plist', 'Frameworks/App.debug.dylib', 'video.mp4',
                     'config/.env.production', 'config/local.env', 'keys/AuthKey_example.p8',
                     'keys/signing.p12', 'keys/private.pem', 'extra.mobileprovision'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'fixture')
                with self.assertRaises(AUDIT.AuditError):
                    AUDIT.bundle_files(root)

    def test_embedded_profile_is_allowed_but_symlink_is_not(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'embedded.mobileprovision').write_bytes(b'public profile')
            self.assertEqual(len(AUDIT.bundle_files(root)), 1)
            (root / 'alias').symlink_to(root / 'embedded.mobileprovision')
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.bundle_files(root)

    def test_renamed_private_key_is_rejected_without_rejecting_public_certificate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'public.txt').write_bytes(b'-----BEGIN CERTIFICATE-----\n' + b'A' * 64 + b'\n-----END CERTIFICATE-----')
            self.assertEqual(len(AUDIT.bundle_files(root)), 1)
            (root / 'innocent.txt').write_bytes(b'-----BEGIN PRIVATE KEY-----\n' + b'A' * 64 + b'\n-----END PRIVATE KEY-----')
            with self.assertRaises(AUDIT.AuditError):
                AUDIT.bundle_files(root)

    def make_bundle(self, root, binary_info=False):
        root.mkdir()
        (root / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleVersion': '18'}, fmt=plistlib.FMT_BINARY if binary_info else plistlib.FMT_XML))
        (root / 'Prompix').write_bytes(b'executable')
        (root / 'embedded.mobileprovision').write_bytes(b'profile')
        (root / '_CodeSignature').mkdir()
        (root / '_CodeSignature/CodeResources').write_bytes(b'signature')
        (root / 'catalog.json').write_bytes(b'{"prompts": []}')
        return root

    def test_resigning_and_plist_reserialization_are_not_resource_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = self.make_bundle(root / 'original')
            exported = self.make_bundle(root / 'exported', binary_info=True)
            for name in ('Prompix', 'embedded.mobileprovision', '_CodeSignature/CodeResources'):
                (exported / name).write_bytes(b'changed by export')
            self.assertTrue(AUDIT.matching_bundle_content(original, exported, 'Prompix'))

    def test_changed_info_missing_added_and_modified_resources_fail(self):
        for change in ('version', 'missing', 'added', 'modified'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                original = self.make_bundle(root / 'original')
                exported = self.make_bundle(root / 'exported')
                if change == 'version':
                    (exported / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleVersion': '19'}))
                elif change == 'missing':
                    (exported / 'catalog.json').unlink()
                elif change == 'added':
                    (exported / 'unexpected.json').write_bytes(b'{}')
                else:
                    (exported / 'catalog.json').write_bytes(b'{"prompts": [1]}')
                self.assertFalse(AUDIT.matching_bundle_content(original, exported, 'Prompix'))


class FailureReportTests(unittest.TestCase):
    def test_failed_signing_command_does_not_expose_credential_output(self):
        result = mock.Mock(returncode=1, stdout=b'private account name', stderr=b'private certificate name')
        with mock.patch.object(AUDIT.subprocess, 'run', return_value=result):
            with self.assertRaises(AUDIT.AuditError) as caught:
                AUDIT.command('Verify signature', 'codesign', '--verify', 'fixture.app')
        self.assertEqual(str(caught.exception), 'Verify signature: command failed (exit 1)')

    def test_unexpected_failure_still_writes_private_safe_nonzero_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            report = root / 'evidence' / 'report.json'
            args = ['--repo', str(root), '--source-commit', 'abcdef0', '--archive', str(root / 'archive'),
                    '--export-dir', str(root / 'export'), '--expected-version', '0.4.7', '--expected-build', '18',
                    '--method', 'debugging', '--report', str(report)]
            output = io.StringIO()
            with mock.patch.object(AUDIT.Auditor, 'run', side_effect=ValueError('private credential value')):
                with contextlib.redirect_stdout(output):
                    self.assertEqual(AUDIT.main(args), 1)
            result = json.loads(report.read_text())
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['issues'], [{'stage': 'inputs', 'message': 'ValueError'}])
            self.assertNotIn('private credential value', report.read_text() + output.getvalue())
            self.assertEqual(list(report.parent.glob('.prompix-release-audit-*')), [])


if __name__ == '__main__':
    unittest.main()
