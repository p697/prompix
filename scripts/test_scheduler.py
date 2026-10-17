"""Scheduler safety checks use temporary homes; no real npm or launchd calls."""
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import scheduler_runtime as runtime

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-scheduler.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def fixture(path):
    path.mkdir(parents=True, exist_ok=True)
    for name in ['package-lock.json', 'ingest/daily.ts', 'packages/schema/catalog.ts']:
        (path / name).parent.mkdir(parents=True, exist_ok=True)
        (path / name).write_text('fixture')
    (path / 'package.json').write_text(json.dumps({'name': 'prompix', 'private': True}))
    return path.resolve()


class SchedulerTests(unittest.TestCase):
    def test_cli_help_and_invalid_arguments_never_install(self):
        for arguments, code in [(['--help'], 0), (['--unknown-option'], 2)]:
            with self.subTest(arguments=arguments), patch.object(installer, 'install') as install, \
                 redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as result:
                    installer.main(arguments)
                self.assertEqual(result.exception.code, code)
                install.assert_not_called()

    def test_cli_without_arguments_installs_once(self):
        with patch.object(installer, 'install') as install:
            installer.main([])
            install.assert_called_once_with(self.repo, Path.home())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.base = self.home / '.local/share/prompix'
        self.root = runtime.runtime_root(self.base)
        self.old = fixture(self.root / '1700000000')
        self.previous = fixture(self.root / '1800000000')
        self.current = fixture(self.root / '1900000000')
        (self.base / 'runtime').symlink_to(self.current)
        self.repo = Path(__file__).resolve().parent.parent

    def install(self, action=None):
        def copy(_repo, target):
            fixture(target)
        with patch.object(installer, 'copy_runtime', side_effect=copy), \
             patch.object(installer.shutil, 'which', return_value='/fixture/bin/node'), \
             patch.object(installer.subprocess, 'run', side_effect=action) as command:
            installer.install(self.repo, self.home)
        return command

    def test_keep_active_and_explicit_rollback_not_just_two_newest(self):
        future = fixture(self.root / '2000000000')
        with runtime.runtime_guard(self.base, exclusive=True):
            removed = runtime.prune_runtimes(self.base, self.previous)
        self.assertEqual(set(removed), {self.old.name, future.name})
        self.assertTrue(self.current.exists())
        self.assertTrue(self.previous.exists())

    def test_unknown_directories_and_symlinks_are_untouched(self):
        unknown = fixture(self.root / 'unrelated')
        wrong = fixture(self.root / '1600000000')
        (wrong / 'package.json').write_text('{"name":"other","private":true}')
        incomplete = self.root / '1500000000'
        incomplete.mkdir()
        outside = fixture(self.home / 'outside')
        linked = self.root / '1400000000'
        linked.symlink_to(outside)
        # Internal dependency links are unlinked, never traversed by rmtree.
        (self.old / 'node_modules').symlink_to(outside)
        with runtime.runtime_guard(self.base, exclusive=True):
            runtime.prune_runtimes(self.base, self.previous)
        for path in [unknown, wrong, incomplete, linked, outside]:
            self.assertTrue(path.exists())
        self.assertTrue((outside / 'ingest/daily.ts').exists())

    def test_content_lock_even_dangling_symlink_prevents_pruning(self):
        (self.base / 'content').mkdir()
        (self.base / 'content/daily.lock').symlink_to(self.home / 'missing')
        with self.assertRaisesRegex(RuntimeError, 'collection lock'):
            runtime.prune_runtimes(self.base, self.previous)
        self.assertTrue(self.old.exists())

    def test_unrecognized_active_or_rollback_prevents_all_deletion(self):
        (self.base / 'runtime').unlink()
        (self.base / 'runtime').symlink_to(self.home)
        with self.assertRaisesRegex(RuntimeError, 'outside'):
            runtime.prune_runtimes(self.base, self.previous)
        self.assertTrue(self.old.exists())
        (self.base / 'runtime').unlink()
        (self.base / 'runtime').symlink_to(self.current)
        with self.assertRaisesRegex(RuntimeError, 'rollback'):
            runtime.prune_runtimes(self.base, self.home)
        self.assertTrue(self.old.exists())

    def test_symlinked_runtime_root_and_lock_are_rejected(self):
        separate = self.home / 'separate'
        separate.mkdir()
        (separate / 'runtimes').symlink_to(self.root)
        with self.assertRaisesRegex(RuntimeError, 'symlinks'):
            runtime.runtime_root(separate)
        (self.base / 'runtime.lock').symlink_to(self.home / 'untouched')
        with self.assertRaises(OSError):
            with runtime.runtime_guard(self.base, exclusive=True):
                self.fail('Must not acquire a symlinked lock')
        self.assertFalse((self.home / 'untouched').exists())

    def test_collector_guard_blocks_installer_before_copy(self):
        with runtime.runtime_guard(self.base, exclusive=False):
            with patch.object(installer, 'copy_runtime') as copy:
                with self.assertRaisesRegex(RuntimeError, 'running'):
                    installer.install(self.repo, self.home)
                copy.assert_not_called()
        with runtime.runtime_guard(self.base, exclusive=True):
            with self.assertRaisesRegex(RuntimeError, 'running'):
                runtime.run_collection(self.base, '/must-not-run')

    def test_packaged_operational_commands_do_not_depend_on_a_development_worktree(self):
        target = self.home / 'standalone-runtime'
        target.mkdir()
        with patch.object(installer.subprocess, 'run') as command:
            installer.copy_runtime(self.repo, target)
        command.assert_called_once_with(['npm', 'ci'], cwd=target, check=True)
        scripts = json.loads((target / 'package.json').read_text())['scripts']
        for name, value in scripts.items():
            parts = value.split()
            if len(parts) > 1 and parts[0] == 'tsx' and not parts[1].startswith('-'):
                self.assertTrue((target / parts[1]).is_file(), f'Missing packaged command: {name}')

    def test_launcher_resolves_runtime_under_guard_and_inherits_lock(self):
        def child(command, *, cwd, pass_fds, env):
            self.assertEqual(cwd, self.current)
            self.assertEqual(command[-2:], ['ingest/daily.ts', '--publish'])
            for name in ['x', 'twitterapi', 'rapidapi', 'translation', 'editorial', 'publication', 'database', 'alerts']:
                self.assertIn('--env-file-if-exists=' + str(Path.home() / f'.config/prompix/{name}.env'), command)
            self.assertEqual(len(pass_fds), 1)
            self.assertEqual(env, runtime.collection_environment())
            with self.assertRaisesRegex(RuntimeError, 'running'):
                with runtime.runtime_guard(self.base, exclusive=True):
                    self.fail('Collector must keep runtime guarded')
            return subprocess.CompletedProcess(command, 7)
        with patch.object(runtime.subprocess, 'run', side_effect=child):
            self.assertEqual(runtime.run_collection(self.base, '/fixture/node'), 7)
        with runtime.runtime_guard(self.base, exclusive=True):
            pass

    def test_node_trust_uses_system_ca_and_preserves_explicit_configuration(self):
        ca_file = self.home / 'system-ca.pem'
        ca_file.write_text('test certificate bundle')
        original = {'PATH': '/fixture/bin'}
        self.assertEqual(runtime.collection_environment(original, ca_file),
                         {**original, 'NODE_EXTRA_CA_CERTS': str(ca_file)})
        self.assertNotIn('NODE_EXTRA_CA_CERTS', original)
        custom = {**original, 'NODE_EXTRA_CA_CERTS': '/custom.pem'}
        self.assertEqual(runtime.collection_environment(custom, ca_file), custom)
        self.assertEqual(runtime.collection_environment(original, self.home / 'absent.pem'), original)

    def test_migration_defers_cleanup_then_success_keeps_rollback(self):
        self.install()
        first = runtime.linked_runtime(self.base)
        self.assertEqual(runtime.linked_runtime(self.base, 'runtime.previous'), self.current)
        self.assertTrue(self.old.exists())
        self.install()
        second = runtime.linked_runtime(self.base)
        self.assertNotEqual(first, second)
        self.assertEqual(runtime.linked_runtime(self.base, 'runtime.previous'), first)
        self.assertEqual(set(self.root.iterdir()), {first, second})

    def test_failed_copy_never_activates_or_prunes(self):
        before = set(self.root.iterdir())
        with patch.object(installer, 'copy_runtime', side_effect=RuntimeError('npm failed')), \
             patch.object(installer.subprocess, 'run') as command:
            with self.assertRaisesRegex(RuntimeError, 'npm failed'):
                installer.install(self.repo, self.home)
            command.assert_not_called()
        self.assertEqual(set(self.root.iterdir()), before)
        self.assertEqual(runtime.linked_runtime(self.base), self.current)

    def test_legacy_collector_starting_during_copy_prevents_activation(self):
        before = set(self.root.iterdir())
        def copy(_repo, target):
            fixture(target)
            (self.base / 'content/daily.lock').mkdir(parents=True)
        with patch.object(installer, 'copy_runtime', side_effect=copy), \
             patch.object(installer.subprocess, 'run') as command:
            with self.assertRaisesRegex(RuntimeError, 'collection lock'):
                installer.install(self.repo, self.home)
            command.assert_not_called()
        self.assertEqual(set(self.root.iterdir()), before)
        self.assertEqual(runtime.linked_runtime(self.base), self.current)

    def test_failed_rollback_never_deletes_a_runtime_still_linked(self):
        before = set(self.root.iterdir())
        original = installer.replace_link
        def link(path, target):
            if target == self.current:
                raise OSError('rollback unavailable')
            original(path, target)
        def activation(command, **kwargs):
            if command[1] == 'bootstrap':
                raise subprocess.CalledProcessError(5, command)
        with patch.object(installer, 'replace_link', side_effect=link):
            with self.assertRaisesRegex(OSError, 'rollback unavailable'):
                self.install(activation)
        active = runtime.linked_runtime(self.base)
        self.assertNotEqual(active, self.current)
        self.assertTrue(active.is_dir())
        self.assertTrue(before.issubset(set(self.root.iterdir())))

    def test_failed_bootstrap_restores_previous_files_and_runtime(self):
        self.install()  # Establish a guarded scheduler, so success would prune.
        current = runtime.linked_runtime(self.base)
        before = set(self.root.iterdir())
        paths = [self.base / 'scheduler_runtime.py', self.base / 'run-daily.sh', self.home / 'Library/LaunchAgents/dev.prompix.collect.plist']
        snapshots = {path: path.read_bytes() for path in paths}
        attempted = []
        def activation(command, **kwargs):
            attempted.append(command)
            if len(attempted) == 2:
                raise subprocess.CalledProcessError(5, command)
        with self.assertRaises(subprocess.CalledProcessError):
            self.install(activation)
        self.assertEqual(runtime.linked_runtime(self.base), current)
        self.assertEqual(set(self.root.iterdir()), before)
        self.assertEqual({path: path.read_bytes() for path in paths}, snapshots)
        self.assertEqual([command[1] for command in attempted], ['bootout', 'bootstrap', 'bootstrap'])


if __name__ == '__main__':
    unittest.main()
