#!/usr/bin/env python3
"""Install a versioned runtime and a daily per-user launchd job. No credentials in plist."""
import os, pathlib, plistlib, shutil, subprocess, time
repo = pathlib.Path(__file__).resolve().parent.parent
home = pathlib.Path.home()
base = home / '.local/share/prompix'
if (base / 'content/daily.lock').exists():
    raise SystemExit('A collection lock exists. Finish or recover that run before upgrading.')
runtime = base / 'runtimes' / str(int(time.time()))
base.mkdir(parents=True, exist_ok=True)
runtime.mkdir(parents=True)
for name in ['ingest', 'packages', 'services']:
    shutil.copytree(repo / name, runtime / name, ignore=shutil.ignore_patterns('node_modules','.wrangler'))
(runtime/'ios/Prompix/Resources').mkdir(parents=True)
shutil.copy2(repo/'ios/Prompix/Resources/catalog.json', runtime/'ios/Prompix/Resources/catalog.json')
for name in ['package.json', 'package-lock.json']:
    shutil.copy2(repo/name,runtime/name)
subprocess.run(['npm','ci'],cwd=runtime,check=True)
link = base / 'runtime.next'
link.unlink(missing_ok=True)
link.symlink_to(runtime, target_is_directory=True)
os.replace(link, base / 'runtime')
node = shutil.which('node')
assert node
runner=base/'run-daily.sh'
runner.write_text('''#!/bin/sh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export WRANGLER_SEND_METRICS=false
cd "$HOME/.local/share/prompix/runtime"
log="$HOME/.local/share/prompix/daily.log"
if [ -f "$log" ] && [ "$(wc -c < "$log")" -gt 1000000 ]; then mv "$log" "$log.previous"; fi
exec '''+node+''' --env-file-if-exists="$HOME/.config/prompix/x.env" --import tsx ingest/daily.ts --publish >> "$log" 2>&1
''')
runner.chmod(0o700)
plist=home/'Library/LaunchAgents/dev.prompix.collect.plist'
plist.parent.mkdir(parents=True,exist_ok=True)
job={'Label':'dev.prompix.collect','ProgramArguments':['/bin/sh',str(runner)],'StartCalendarInterval':{'Hour':8,'Minute':0},'ProcessType':'Background','LowPriorityIO':True,'StandardErrorPath':str(base/'launchd-error.log')}
plist.write_bytes(plistlib.dumps(job))
subprocess.run(['launchctl','bootout',f'gui/{os.getuid()}',str(plist)],capture_output=True)
subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(plist)],check=True)
print('Installed daily collection at 08:00 in this Mac’s local timezone.')
