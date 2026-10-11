#!/usr/bin/env python3
"""Install a versioned runtime and a daily per-user launchd job. No credentials in plist."""
import json, os, pathlib, plistlib, shlex, shutil, subprocess, time
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
# Mirror first-party image outputs for older clients; videos and unrelated assets stay out.
catalog = json.loads((repo/'ios/Prompix/Resources/catalog.json').read_text())
for prompt in catalog['prompts']:
    image = (prompt.get('media') or {}).get('image')
    if prompt['kind'] == 'image' and image and prompt['source']['name'] == 'Prompix Studio':
        resource = pathlib.Path('ios/Prompix/Resources/Assets.xcassets') / (image + '.imageset')
        shutil.copytree(repo/resource, runtime/resource)

for name in ['package.json', 'package-lock.json']:
    shutil.copy2(repo/name,runtime/name)
subprocess.run(['npm','ci'],cwd=runtime,check=True)
link = base / 'runtime.next'
link.unlink(missing_ok=True)
link.symlink_to(runtime, target_is_directory=True)
os.replace(link, base / 'runtime')
node = shutil.which('node')
assert node
# launchd does not inherit the interactive shell PATH. Wrangler's env-node
# shebang must resolve the same runtime as the collector, including keg-only Node.
command_paths = [str(pathlib.Path(node).parent)]
for command in ['wrangler', 'git']:
    executable = shutil.which(command)
    if executable:
        command_paths.append(str(pathlib.Path(executable).parent))
command_paths.extend(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])
runner_path = ':'.join(dict.fromkeys(command_paths))
runner=base/'run-daily.sh'
runner.write_text('''#!/bin/sh
set -eu
export PATH='''+shlex.quote(runner_path)+'''
export WRANGLER_SEND_METRICS=false
cd "$HOME/.local/share/prompix/runtime"
log="$HOME/.local/share/prompix/daily.log"
if [ -f "$log" ] && [ "$(wc -c < "$log")" -gt 1000000 ]; then mv "$log" "$log.previous"; fi
exec '''+shlex.quote(node)+''' --env-file-if-exists="$HOME/.config/prompix/x.env" --import tsx ingest/daily.ts --publish >> "$log" 2>&1
''')
runner.chmod(0o700)
plist=home/'Library/LaunchAgents/dev.prompix.collect.plist'
plist.parent.mkdir(parents=True,exist_ok=True)
job={'Label':'dev.prompix.collect','ProgramArguments':['/bin/sh',str(runner)],'StartCalendarInterval':{'Hour':8,'Minute':0},'ProcessType':'Background','LowPriorityIO':True,'StandardErrorPath':str(base/'launchd-error.log')}
plist.write_bytes(plistlib.dumps(job))
subprocess.run(['launchctl','bootout',f'gui/{os.getuid()}',str(plist)],capture_output=True)
subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(plist)],check=True)
print('Installed daily collection at 08:00 in this Mac’s local timezone.')
