"""Shared runtime guard and conservative retention for the local collector."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def runtime_root(base):
    root = base / 'runtimes'
    if base.is_symlink() or root.is_symlink():
        raise RuntimeError('Runtime directories must not be symlinks.')
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


@contextmanager
def runtime_guard(base, *, exclusive):
    # Never unlink this inode: both installer and collector share it.
    descriptor = os.open(base / 'runtime.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        mode = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        try:
            fcntl.flock(lock, mode | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('A runtime installation or collection is running. Try again after it finishes.') from error
        try:
            yield lock.fileno()
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def managed_runtime(path, root):
    """Recognize only direct, real runtime directories made by this installer."""
    if path.parent != root or not re.fullmatch(r'[0-9]{10,20}', path.name):
        return False
    if path.is_symlink() or not path.is_dir() or path.resolve() != path:
        return False
    required = ['package.json', 'package-lock.json', 'ingest/daily.ts', 'packages/schema/catalog.ts']
    if any((path / name).resolve() != path / name or not (path / name).is_file() for name in required):
        return False
    try:
        package = json.loads((path / 'package.json').read_text())
        return isinstance(package, dict) and package.get('name') == 'prompix' and package.get('private') is True
    except (OSError, ValueError):
        return False


def linked_runtime(base, name='runtime'):
    link = base / name
    if not link.is_symlink():
        if link.exists():
            raise RuntimeError(f'{name} must be a runtime symlink.')
        return None
    target = link.resolve()
    if not managed_runtime(target, runtime_root(base)):
        raise RuntimeError(f'{name} points outside a recognized Prompix runtime.')
    return target


def collection_idle(base):
    # Legacy/manual collectors may not hold runtime.lock. Content commands own
    # stale-lock recovery; the installer never guesses whether a lock is stale.
    if os.path.lexists(base / 'content/daily.lock'):
        raise RuntimeError('A collection lock exists. Finish or recover that run before upgrading.')


def prune_runtimes(base, previous):
    """Caller holds the exclusive guard after successful launchd activation."""
    collection_idle(base)
    root = runtime_root(base)
    active = linked_runtime(base)
    if active is None:
        raise RuntimeError('Refusing retention without an active runtime.')
    if previous is not None and not managed_runtime(previous, root):
        raise RuntimeError('Refusing retention with an unrecognized rollback runtime.')
    keep = {active, previous}
    removed = []
    for candidate in sorted(root.iterdir()):
        if candidate not in keep and managed_runtime(candidate, root):
            collection_idle(base)
            shutil.rmtree(candidate)
            removed.append(candidate.name)
    return removed


def collection_environment(environ=None, ca_file=Path('/etc/ssl/cert.pem')):
    """Trust the host CA bundle in Node without weakening TLS verification."""
    environment = dict(os.environ if environ is None else environ)
    if 'NODE_EXTRA_CA_CERTS' not in environment and ca_file.is_file():
        environment['NODE_EXTRA_CA_CERTS'] = str(ca_file)
    return environment


def run_collection(base, node):
    runtime_root(base)
    with runtime_guard(base, exclusive=False) as descriptor:
        runtime = linked_runtime(base)
        if runtime is None:
            raise RuntimeError('No active Prompix runtime is installed.')
        # Inherit the lock too, so killing the launcher cannot unguard its child.
        return subprocess.run([
            node, '--env-file-if-exists=' + str(Path.home() / '.config/prompix/x.env'),
            '--env-file-if-exists=' + str(Path.home() / '.config/prompix/twitterapi.env'),
            '--env-file-if-exists=' + str(Path.home() / '.config/prompix/rapidapi.env'),
            '--env-file-if-exists=' + str(Path.home() / '.config/prompix/translation.env'),
            '--env-file-if-exists=' + str(Path.home() / '.config/prompix/editorial.env'),
            '--env-file-if-exists=' + str(Path.home() / '.config/prompix/publication.env'),
            '--env-file-if-exists=' + str(Path.home() / '.config/prompix/database.env'),
            '--env-file-if-exists=' + str(Path.home() / '.config/prompix/alerts.env'),
            '--import', 'tsx', 'ingest/daily.ts', '--publish',
        ], cwd=runtime, pass_fds=(descriptor,), env=collection_environment()).returncode


if __name__ == '__main__':
    try:
        sys.exit(run_collection(Path(__file__).resolve().parent, sys.argv[1]))
    except (OSError, RuntimeError) as error:
        raise SystemExit(str(error))
