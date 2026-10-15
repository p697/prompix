#!/usr/bin/env python3
"""Audit a local Prompix archive/export without uploading or installing it.

Requires macOS signing tools and the selected Xcode's xcrun. Only the report and
temporary files next to it are written. Command output, profile names, account
identifiers and certificate subjects are never included in the report.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile


BUNDLE_ID = 'com.p697.prompix'
LOCALES = ('en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'pt-BR', 'fr', 'de')
RESOURCE_ROOT = 'ios/Prompix/Resources/'
MAX_ZIP_BYTES = 512 * 1024 * 1024
PRIVATE_KEY_PEM = re.compile(rb'-----BEGIN ((?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----\s+[A-Za-z0-9+/=\r\n]{64,}-----END \1-----')


class AuditError(Exception):
    """A deliberately credential-free diagnostic."""


def command(label: str, *args: str, input_data: bytes | None = None) -> bytes:
    try:
        result = subprocess.run(args, input=input_data, capture_output=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        raise AuditError(f'{label}: command unavailable or timed out') from None
    if result.returncode:
        raise AuditError(f'{label}: command failed (exit {result.returncode})')
    return result.stdout


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def application_id_authorized(actual: str, pattern: str) -> bool:
    """Only an exact identifier or a final dot-component wildcard is valid."""
    identifier = r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+'
    if not isinstance(actual, str) or not isinstance(pattern, str):
        return False
    if not re.fullmatch(identifier, actual):
        return False
    if re.fullmatch(identifier, pattern):
        return actual == pattern
    if pattern.endswith('.*') and re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*', pattern[:-2]):
        return actual.startswith(pattern[:-1]) and len(actual) > len(pattern) - 1
    return False


def validated_zip_members(archive: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    """Validate the entire central directory before extracting any member."""
    entries: dict[str, bool] = {}
    members = archive.infolist()
    if not members or len(members) > 10000 or sum(m.file_size for m in members) > MAX_ZIP_BYTES:
        raise AuditError('ZIP is empty or exceeds the local audit size limit')
    for member in members:
        name = member.orig_filename
        parts = name.rstrip('/').split('/')
        kind = stat.S_IFMT(member.external_attr >> 16)
        if (name != member.filename or '\x00' in name or '\\' in name
                or any(part in ('', '.', '..') or ':' in part for part in parts)
                or PurePosixPath(name).is_absolute() or member.flag_bits & 1
                or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
                or (kind == stat.S_IFDIR and not member.is_dir())
                or (kind == stat.S_IFREG and member.is_dir())):
            raise AuditError('ZIP contains an unsafe path, file type or encrypted entry')
        # The destination may use a case-insensitive, Unicode-normalizing volume.
        key = unicodedata.normalize('NFC', '/'.join(parts)).casefold()
        if key in entries:
            raise AuditError('ZIP contains duplicate or filesystem-equivalent paths')
        entries[key] = member.is_dir()
    for key in entries:
        parts = key.split('/')
        if any('/'.join(parts[:index]) in entries and not entries['/'.join(parts[:index])]
               for index in range(1, len(parts))):
            raise AuditError('ZIP contains a file/directory path collision')
    return members


def extract_ipa(ipa: Path, destination: Path) -> Path:
    with zipfile.ZipFile(ipa) as archive:
        members = validated_zip_members(archive)
        top_level = {m.filename.split('/')[0] for m in members}
        if not top_level <= {'Payload', 'SwiftSupport', 'Symbols', 'BCSymbolMaps', 'iTunesMetadata.plist'}:
            raise AuditError('IPA contains unexpected top-level content')
        archive.extractall(destination, members=members)
    payload = destination / 'Payload'
    children = list(payload.iterdir()) if payload.is_dir() else []
    if len(children) != 1 or not children[0].is_dir() or children[0].suffix != '.app':
        raise AuditError('IPA must contain exactly one top-level application')
    return children[0]


def bundle_files(bundle: Path) -> list[Path]:
    if bundle.is_symlink() or not bundle.is_dir():
        raise AuditError('Application bundle must be a real directory')
    files = []
    for directory, dirs, names in os.walk(bundle, followlinks=False):
        for name in dirs + names:
            path = Path(directory) / name
            mode = path.lstat().st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise AuditError('Application bundle contains a symlink or special file')
            lower = name.lower()
            if (lower.endswith(('.xctest', '.xcresult', '.dsym', '.debug.dylib', '.mp4', '.p12', '.pfx', '.p8', '.key', '.pem'))
                    or lower in ('.env', '.git', 'id_rsa', 'id_ed25519')
                    or lower.startswith('.env.') or lower.endswith('.env')
                    or (lower.endswith('.mobileprovision') and path != bundle / 'embedded.mobileprovision')):
                raise AuditError('Application bundle contains test, debug or private signing material')
            if stat.S_ISREG(mode):
                if PRIVATE_KEY_PEM.search(path.read_bytes()):
                    raise AuditError('Application bundle contains private key material')
                files.append(path)
    return files


def resource_inventory(bundle: Path, executable: str) -> dict[str, str]:
    excluded = {executable, 'Info.plist', 'embedded.mobileprovision', '_CodeSignature/CodeResources'}
    return {str(path.relative_to(bundle)): sha256(path) for path in bundle_files(bundle)
            if str(path.relative_to(bundle)) not in excluded}


def matching_bundle_content(archive: Path, exported: Path, executable: str) -> bool:
    return (plistlib.loads((archive / 'Info.plist').read_bytes())
            == plistlib.loads((exported / 'Info.plist').read_bytes())
            and resource_inventory(archive, executable) == resource_inventory(exported, executable))


def utc(value: dt.datetime) -> dt.datetime:
    return value.replace(tzinfo=dt.timezone.utc) if value.tzinfo is None else value.astimezone(dt.timezone.utc)


def certificate_dates(der: bytes) -> tuple[dt.datetime, dt.datetime]:
    output = command('Read certificate validity', 'openssl', 'x509', '-inform', 'DER', '-noout', '-dates', input_data=der)
    dates = dict(line.split('=', 1) for line in output.decode().splitlines())
    return tuple(dt.datetime.strptime(dates[key], '%b %d %H:%M:%S %Y %Z').replace(tzinfo=dt.timezone.utc)
                 for key in ('notBefore', 'notAfter'))


def export_option_checks(options: dict, method: str, requested: dict | None = None) -> dict[str, bool]:
    version_management = options.get('manageAppVersionAndBuildNumber')
    team = options.get('teamID')
    checks = {
        'localExportOnly': options.get('method') == method and options.get('destination') == 'export',
        # Generated debugging options omit this flag even when explicitly false.
        # Require the original supplied options in that case, plus version equality below.
        'noAutomaticVersionMutation': (requested or options).get('manageAppVersionAndBuildNumber') is False and version_management is not True,
        'explicitExportTeam': isinstance(team, str) and bool(re.fullmatch(r'[A-Z0-9]+', team)),
    }
    if requested is not None:
        checks['requestedExportOptionsMatch'] = all(requested.get(key) == options.get(key) for key in ('method', 'destination', 'teamID'))
    if method == 'app-store-connect':
        checks['distributionOptions'] = options.get('uploadSymbols') is True and options.get('testFlightInternalTestingOnly') is False
    return checks


class Auditor:
    def __init__(self, arguments: argparse.Namespace):
        self.args = arguments
        self.stage = 'inputs'
        self.report = {
            'status': 'failed', 'scope': 'Local archive and export audit only; no upload, installation or Apple server validation.',
            'method': arguments.method, 'checks': {}, 'issues': [],
            'uploaded': False, 'deviceInstalled': False, 'appStoreUploadValidated': False,
        }

    def check(self, name: str, passed: bool) -> None:
        self.stage = name
        self.report['checks'][name] = bool(passed)
        if not passed:
            raise AuditError(f'{name}: failed')

    def git(self, *args: str) -> bytes:
        return command('Read source commit', 'git', '-C', str(self.args.repo), *args)

    def source(self, relative: str) -> bytes:
        return self.git('show', f'{self.report["sourceCommit"]}:{relative}')

    def signature(self, app: Path, team: str, temp: Path, role: str, method: str | None = None) -> None:
        self.stage = f'{role}.signature'
        command('Verify strict application signature', 'codesign', '--verify', '--deep', '--strict', str(app))
        self.check(f'{role}.strictSignature', True)
        entitlements = plistlib.loads(command('Read signing entitlements', 'codesign', '-d', '--entitlements', ':-', str(app)))
        profile = plistlib.loads(command('Read provisioning profile', 'security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision')))
        pe = profile['Entitlements']
        now = dt.datetime.now(dt.timezone.utc)
        self.check(f'{role}.profileCurrentlyValid', utc(profile['CreationDate']) <= now < utc(profile['ExpirationDate']))
        if method is None:
            method = 'debugging' if entitlements.get('get-task-allow') is True else 'app-store-connect'
        development = method == 'debugging'
        expected = {'application-identifier', 'com.apple.developer.team-identifier', 'get-task-allow'}
        if not development:
            expected.add('beta-reports-active')
        self.check(f'{role}.onlyExpectedEntitlements', set(entitlements) == expected)
        self.check(f'{role}.debuggingPermission', entitlements.get('get-task-allow') is development and pe.get('get-task-allow') is development)
        self.check(f'{role}.teamAuthorization',
                   entitlements.get('com.apple.developer.team-identifier') == pe.get('com.apple.developer.team-identifier') == team
                   and team in profile.get('TeamIdentifier', []))
        actual = entitlements.get('application-identifier', '')
        pattern = pe.get('application-identifier', '')
        prefixes = profile.get('ApplicationIdentifierPrefix', [])
        self.check(f'{role}.applicationIdentifierAuthorization',
                   any(actual == prefix + '.' + BUNDLE_ID for prefix in prefixes)
                   and application_id_authorized(actual, pattern)
                   and (development or actual == pattern))
        self.check(f'{role}.profileDistributionType',
                   profile.get('ProvisionsAllDevices', False) is False
                   and (bool(profile.get('ProvisionedDevices')) if development else 'ProvisionedDevices' not in profile))
        if not development:
            self.check(f'{role}.betaReporting', entitlements.get('beta-reports-active') is True and pe.get('beta-reports-active') is True)
        prefix = temp / (role + '-certificate-')
        command('Extract public signing certificate', 'codesign', '-d', '--extract-certificates=' + str(prefix), str(app))
        certificate = Path(str(prefix) + '0').read_bytes()
        self.check(f'{role}.certificateAuthorizedByProfile', certificate in profile.get('DeveloperCertificates', []))
        start, end = certificate_dates(certificate)
        self.check(f'{role}.certificateCurrentlyValid', start <= now < end)
        subject = command('Read certificate type', 'openssl', 'x509', '-inform', 'DER', '-noout', '-subject', input_data=certificate).decode()
        self.check(f'{role}.certificateType', ('Apple Development' if development else 'Apple Distribution') in subject)
        self.report.setdefault('signing', {})[role] = {
            'kind': method, 'profileExpires': utc(profile['ExpirationDate']).isoformat(),
            'certificateExpires': end.isoformat(), 'registeredDeviceCount': len(profile.get('ProvisionedDevices', [])),
        }

    def run(self, temp: Path) -> None:
        args = self.args
        self.check('sourceCommitSyntax', re.fullmatch(r'[0-9a-fA-F]{7,40}', args.source_commit) is not None)
        commit = self.git('rev-parse', '--verify', args.source_commit + '^{commit}').decode().strip()
        self.report['sourceCommit'] = commit
        self.stage = 'exportOptions'
        options = plistlib.loads((args.export_dir / 'ExportOptions.plist').read_bytes())
        requested_path = getattr(args, 'export_options', None)
        requested = plistlib.loads(requested_path.read_bytes()) if requested_path else None
        if requested_path:
            self.report['requestedOptionsSHA256'] = hashlib.sha256(requested_path.read_bytes()).hexdigest()
        for name, passed in export_option_checks(options, args.method, requested).items():
            self.check(name, passed)
        team = options['teamID']
        self.stage = 'archiveApplication'
        applications = list((args.archive / 'Products/Applications').glob('*.app'))
        self.check('oneArchivedApplication', len(applications) == 1)
        original = applications[0]
        bundle_files(original)
        self.check('archive.noForbiddenBundleContent', True)
        self.stage = 'exportedIPA'
        ipas = list(args.export_dir.glob('*.ipa'))
        self.check('oneExportedIPA', len(ipas) == 1 and ipas[0].is_file() and not ipas[0].is_symlink())
        ipa = ipas[0]
        self.stage = 'distributionSummary'
        summary = plistlib.loads((args.export_dir / 'DistributionSummary.plist').read_bytes()).get(ipa.name, [])
        self.check('exportSummaryIdentity', len(summary) == 1
                   and summary[0].get('versionNumber') == args.expected_version
                   and summary[0].get('buildNumber') == args.expected_build)
        if args.method == 'app-store-connect':
            self.check('exportSummaryIncludesSymbols', summary[0].get('symbols') is True)
        exported = extract_ipa(ipa, temp / 'unpacked')
        self.check('safeZIPAndOnePayloadApp', True)
        bundle_files(exported)
        self.check('export.noForbiddenBundleContent', True)
        self.report.update({'ipaBytes': ipa.stat().st_size, 'ipaSHA256': sha256(ipa)})
        info = plistlib.loads((original / 'Info.plist').read_bytes())
        self.check('archiveIdentity', info.get('CFBundleIdentifier') == BUNDLE_ID
                   and info.get('CFBundleShortVersionString') == args.expected_version
                   and info.get('CFBundleVersion') == args.expected_build
                   and info.get('DTPlatformName') == 'iphoneos'
                   and info.get('DTSDKName', '').startswith('iphoneos')
                   and info.get('MinimumOSVersion') == '17.0' and info.get('UIDeviceFamily') == [1, 2])
        executable = info.get('CFBundleExecutable', '')
        self.check('safeExecutableName', isinstance(executable, str) and executable == Path(executable).name
                   and executable not in ('', '.', '..') and '\\' not in executable)
        self.report.update({'version': args.expected_version, 'build': args.expected_build,
                            'bundleID': BUNDLE_ID, 'sdk': info['DTSDKName'], 'xcodeBuild': info.get('DTXcodeBuild')})
        self.signature(original, team, temp, 'archive')
        self.signature(exported, team, temp, 'export', args.method)
        self.stage = 'bundleResourceComparison'
        self.check('exportInfoAndResourcesMatchArchive', matching_bundle_content(original, exported, executable))
        dsym = args.archive / 'dSYMs' / (original.name + '.dSYM') / 'Contents/Resources/DWARF' / executable
        def uuids(path: Path) -> list[tuple[str, str]]:
            output = command('Read Mach-O UUID', 'xcrun', 'dwarfdump', '--uuid', str(path)).decode()
            return sorted(re.findall(r'UUID: ([A-Fa-f0-9-]+) \(([^)]+)\)', output))
        self.stage = 'machOUUIDs'
        original_ids = uuids(original / executable)
        self.check('deviceUUIDsMatchExportAndDSYM', bool(original_ids)
                   and all(architecture.startswith('arm64') for _, architecture in original_ids)
                   and original_ids == uuids(exported / executable) == uuids(dsym))
        self.report['machOUUIDs'] = [{'uuid': value, 'architecture': arch} for value, arch in original_ids]
        self.stage = 'sourceResources'
        for filename in ('PrivacyInfo.xcprivacy', 'catalog.json'):
            self.check('sourceIdentity.' + filename, (original / filename).read_bytes() == self.source(RESOURCE_ROOT + filename))
        web_paths = self.git('ls-tree', '-r', '--name-only', '-z', commit, '--', RESOURCE_ROOT + 'WebExamples/').decode().split('\x00')
        source_web = {path.removeprefix(RESOURCE_ROOT): hashlib.sha256(self.source(path)).hexdigest() for path in web_paths if path}
        actual_web = {str(path.relative_to(original)): sha256(path) for path in (original / 'WebExamples').rglob('*') if path.is_file()}
        self.check('webExamplesMatchSource', bool(source_web) and source_web == actual_web)
        privacy = plistlib.loads((original / 'PrivacyInfo.xcprivacy').read_bytes())
        self.check('privacyNoTracking', privacy.get('NSPrivacyTracking') is False and privacy.get('NSPrivacyTrackingDomains') == [])
        self.check('nineCompiledLocalizations', all(any(
            (original / (locale + '.lproj') / name).is_file() and (original / (locale + '.lproj') / name).stat().st_size > 0
            for name in ('Localizable.strings', 'Localizable.stringsdict')) for locale in LOCALES))
        self.report.update({'resourceFileCountCompared': len(resource_inventory(original, executable)),
                            'sourceResourceSHA256': {name: sha256(original / name) for name in ('PrivacyInfo.xcprivacy', 'catalog.json')},
                            'compiledLocales': list(LOCALES), 'status': 'passed'})


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--repo', required=True, type=Path)
    result.add_argument('--source-commit', required=True)
    result.add_argument('--archive', required=True, type=Path)
    result.add_argument('--export-dir', required=True, type=Path)
    result.add_argument('--export-options', type=Path, help='Original options passed to xcodebuild; required when the generated export omits explicit version settings.')
    result.add_argument('--expected-version', required=True)
    result.add_argument('--expected-build', required=True)
    result.add_argument('--method', required=True, choices=('debugging', 'app-store-connect'))
    result.add_argument('--report', required=True, type=Path)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    auditor = Auditor(args)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='.prompix-release-audit-', dir=args.report.parent) as temporary:
            auditor.run(Path(temporary))
    except AuditError as error:
        auditor.report['issues'].append({'stage': auditor.stage, 'message': str(error)})
    except Exception as error:
        # OS/tool errors can include private paths or credential output. Keep a
        # reproducible stage and exception category without copying that data.
        auditor.report['issues'].append({'stage': auditor.stage, 'message': type(error).__name__})
    auditor.report['auditedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=args.report.parent,
                                     prefix='.prompix-audit-report-', delete=False) as stream:
        temporary_report = Path(stream.name)
        json.dump(auditor.report, stream, indent=2)
        stream.write('\n')
    os.replace(temporary_report, args.report)
    print(json.dumps({'status': auditor.report['status'], 'checksCompleted': len(auditor.report['checks']),
                      'issues': auditor.report['issues']}))
    return 0 if auditor.report['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
