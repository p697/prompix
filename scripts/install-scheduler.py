#!/usr/bin/env python3
"""Install a guarded, versioned daily runtime. No credentials in the launchd job."""
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

from scheduler_runtime import collection_idle, linked_runtime, prune_runtimes, runtime_guard, runtime_root


def replace_link(link, target):
    with tempfile.TemporaryDirectory(prefix='.runtime-link-', dir=link.parent) as directory:
        temporary = Path(directory) / 'link'
        temporary.symlink_to(target, target_is_directory=True)
        os.replace(temporary, link)


def write_atomic(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        pending = Path(temporary.name)
        try:
            temporary.write(data)
            temporary.flush()
            pending.chmod(mode)
            os.replace(pending, path)
        finally:
            pending.unlink(missing_ok=True)


def copy_runtime(repo, runtime):
    for name in ['ingest', 'packages', 'services']:
        shutil.copytree(repo / name, runtime / name, ignore=shutil.ignore_patterns('node_modules', '.wrangler', 'dist'))
    (runtime / 'ios/Prompix/Resources').mkdir(parents=True)
    catalog_path = Path('ios/Prompix/Resources/catalog.json')
    shutil.copy2(repo / catalog_path, runtime / catalog_path)
    # Only original images needed by publication; no bundled videos or other art.
    for prompt in json.loads((repo / catalog_path).read_text())['prompts']:
        image = (prompt.get('media') or {}).get('image')
        if prompt['kind'] == 'image' and image and prompt['source']['name'] == 'Prompix Studio':
            resource = Path('ios/Prompix/Resources/Assets.xcassets') / (image + '.imageset')
            shutil.copytree(repo / resource, runtime / resource)
    for name in ['package.json', 'package-lock.json']:
        shutil.copy2(repo / name, runtime / name)
    subprocess.run(['npm', 'ci'], cwd=runtime, check=True)


def discard_unactivated_runtime(base, runtime):
    # A failed rollback may have left the new link in place. Keep that runtime
    # rather than turning an installation error into a missing active directory.
    try:
        retained = {linked_runtime(base), linked_runtime(base, 'runtime.previous')}
    except (OSError, RuntimeError):
        return
    if runtime not in retained:
        shutil.rmtree(runtime)


def install(repo, home):
    base = home / '.local/share/prompix'
    root = runtime_root(base)
    with runtime_guard(base, exclusive=True):
        collection_idle(base)
        previous = linked_runtime(base)
        linked_runtime(base, 'runtime.previous')  # Do not replace unrelated paths.
        node = shutil.which('node')
        if not node:
            raise RuntimeError('Node is required to install the collector.')
        # Legacy launchers do not hold runtime.lock. Their current runtime stays
        # available for rollback; defer retention until the next guarded upgrade.
        helper = base / 'scheduler_runtime.py'
        guarded_before = helper.is_file() and not helper.is_symlink()
        runner = base / 'run-daily.sh'
        plist = home / 'Library/LaunchAgents/dev.prompix.collect.plist'
        files = [runner, helper, plist]
        if any(path.is_symlink() for path in files):
            raise RuntimeError('Scheduler files must not be symlinks.')
        backups = {path: (path.read_bytes(), path.stat().st_mode & 0o777) if path.exists() else None for path in files}
        runtime = root / str(time.time_ns())
        runtime.mkdir()
        activated = False
        changed = False
        try:
            copy_runtime(repo, runtime)
            collection_idle(base)
            command_paths = [str(Path(node).parent)]
            for command in ['wrangler', 'git']:
                executable = shutil.which(command)
                if executable:
                    command_paths.append(str(Path(executable).parent))
            command_paths.extend(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])
            runner_path = ':'.join(dict.fromkeys(command_paths))
            runner_text = '''#!/bin/sh
set -eu
export PATH=''' + shlex.quote(runner_path) + '''
export WRANGLER_SEND_METRICS=false
log="$HOME/.local/share/prompix/daily.log"
if [ -f "$log" ] && [ "$(wc -c < "$log")" -gt 1000000 ]; then mv "$log" "$log.previous"; fi
exec ''' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(helper)) + ' ' + shlex.quote(node) + ''' >> "$log" 2>&1
'''
            job = {'Label': 'dev.prompix.collect', 'ProgramArguments': ['/bin/sh', str(runner)], 'StartCalendarInterval': {'Hour': 8, 'Minute': 0}, 'ProcessType': 'Background', 'LowPriorityIO': True, 'StandardErrorPath': str(base / 'launchd-error.log')}
            changed = True
            write_atomic(helper, (repo / 'scripts/scheduler_runtime.py').read_bytes())
            write_atomic(runner, runner_text.encode(), 0o700)
            write_atomic(plist, plistlib.dumps(job))
            replace_link(base / 'runtime', runtime)
            subprocess.run(['launchctl', 'bootout', f'gui/{os.getuid()}', str(plist)], capture_output=True)
            subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], check=True)
            activated = True
        except BaseException:
            if changed:
                if previous is None:
                    (base / 'runtime').unlink(missing_ok=True)
                else:
                    replace_link(base / 'runtime', previous)
                for path, backup in backups.items():
                    if backup is None:
                        path.unlink(missing_ok=True)
                    else:
                        write_atomic(path, *backup)
                if backups[plist] is not None:
                    subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], capture_output=True)
            raise
        finally:
            if not activated:
                discard_unactivated_runtime(base, runtime)
        if previous is not None:
            replace_link(base / 'runtime.previous', previous)
        if guarded_before:
            removed = prune_runtimes(base, previous)
            print(f'Removed {len(removed)} obsolete Prompix runtimes; active and rollback runtimes retained.')
        else:
            print('Runtime guard installed. Existing runtimes are retained until the next successful upgrade.')
        print('Installed daily collection at 08:00 in this Mac’s local timezone.')


if __name__ == '__main__':
    try:
        install(Path(__file__).resolve().parent.parent, Path.home())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
