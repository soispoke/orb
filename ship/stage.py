# Stage a signed Orb.app from the freshly built binary: python3 -I stage.py <name> <notes>
# Refuses if the installed app is not the build the last stage recorded as installed.
from pathlib import Path
import hashlib, json, subprocess, shutil, datetime, sys

name, notes = sys.argv[1], sys.argv[2]
repo = Path(__file__).resolve().parents[1]
S = Path('/private/tmp/claude-501/-Users-alexis-Library-Application-Support-Claude-scratch-workspaces-254d4428-1ca4-4e6d-a409-d10452a23d34-bba673c2-8381-440f-b65f-4b2a2a4022b4-scratch-2026-10-20-35f657/3971754c-3a09-4ba1-b10e-848230508e8d/scratchpad')
apps = Path('/Users/alexis/Applications'); app = apps / 'Orb.app'; stage = apps / f'Orb-{name}-stage'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

installed = sha(app / 'Contents/MacOS/orb')
assert not stage.exists(), f'{stage} exists'
stage.mkdir(); stage.chmod(0o700)
subprocess.run(['ditto', str(app), str(stage / 'Orb.app')], check=True)
shutil.copy2(S / 'target/debug/orb', stage / 'Orb.app/Contents/MacOS/orb')
subprocess.run(['codesign', '--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements',
                str(repo / 'orb/src-tauri/Entitlements.plist'), str(stage / 'Orb.app')], check=True, capture_output=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(stage / 'Orb.app')], check=True, capture_output=True)
patch = subprocess.check_output(['git', '-C', str(repo), 'diff', '--', 'orb/src', 'orb/tests', 'orb/src-tauri/src', 'shared', 'src'])
(stage / 'changes.patch').write_bytes(patch)
for f in ['native-build.log', 'frontend-build.log']: shutil.copy2(S / f, stage / f)
v = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'installed_sha256': installed,
     'candidate_sha256': sha(stage / 'Orb.app/Contents/MacOS/orb'), 'notes': notes,
     'scope': 'Desktop app only; execution worker and Core unchanged'}
(stage / 'VERIFIED.json').write_text(json.dumps(v, indent=2)); print(json.dumps(v, indent=1))
