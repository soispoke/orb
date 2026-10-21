# Stage a signed Orb.app from the binary build_desktop.sh produced.
# Usage: python3 -I scripts/orb-ship/stage.py <name> "<what changed>"
# Creates ~/Applications/Orb-<name>-stage with the app, logs and VERIFIED.json.
from pathlib import Path
import datetime, hashlib, json, os, shutil, subprocess, sys

name, notes = sys.argv[1], sys.argv[2]
repo = Path(__file__).resolve().parents[2]
target = Path(os.environ.get('ORB_TARGET', Path.home() / '.cache/orb-target'))
logs = Path(os.environ.get('ORB_SHIP_LOGS', Path.home() / '.cache/orb-ship-logs'))
apps = Path.home() / 'Applications'; app = apps / 'Orb.app'; stage = apps / f'Orb-{name}-stage'
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def git(*a): return subprocess.check_output(['git', '-C', str(repo), *a], text=True).strip()

binary = target / 'debug/orb'
assert binary.exists(), 'Run scripts/orb-ship/build_desktop.sh first'
assert binary.stat().st_mtime >= (repo / 'orb/dist/index.html').stat().st_mtime, 'Binary is older than the frontend build'
assert not stage.exists(), f'{stage} exists'
stage.mkdir(); stage.chmod(0o700)
subprocess.run(['ditto', str(app), str(stage / 'Orb.app')], check=True)
shutil.copy2(binary, stage / 'Orb.app/Contents/MacOS/orb')
subprocess.run(['codesign', '--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements',
                str(repo / 'orb/src-tauri/Entitlements.plist'), str(stage / 'Orb.app')], check=True, capture_output=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(stage / 'Orb.app')], check=True, capture_output=True)
for f in ['native-build.log', 'frontend-build.log']:
    if (logs / f).exists(): shutil.copy2(logs / f, stage / f)
dirty = git('status', '--porcelain', '--', 'orb', 'src', 'shared')
v = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'notes': notes,
     'source_repo': str(repo), 'source_commit': git('rev-parse', 'HEAD'), 'source_dirty': bool(dirty),
     'installed_sha256': sha(app / 'Contents/MacOS/orb'),
     'candidate_sha256': sha(stage / 'Orb.app/Contents/MacOS/orb'),
     'scope': 'Desktop app only; execution worker and Core unchanged'}
if dirty: (stage / 'uncommitted.patch').write_text(git('diff', 'HEAD', '--', 'orb', 'src', 'shared'))
(stage / 'VERIFIED.json').write_text(json.dumps(v, indent=2)); print(json.dumps(v, indent=1))
