# Activate a packaged Core image. Runs ON THE SERVER:
#   ssh host 'python3 - <rev>' < scripts/orb-ship/core/deploy.py
# Refuses while any mission runs, a queued delivery is pending, or a machine transfer
# is open. Backs up the mission database, swaps the image in the Compose override,
# restarts Core and its proxy together, and restores the previous image on any failure.
import datetime, hashlib, json, pathlib, shutil, subprocess, sys

rev = sys.argv[1]
stage = pathlib.Path(f'/home/thomas/orb-stage-{rev}')
v = json.loads((stage / 'VERIFIED.json').read_text())
assert v['isolated_health'] and v['state'] == 'verified, not deployed'
def out(args): return subprocess.check_output(args, text=True).strip()
assert out(['docker', 'inspect', 'orb-sandboxed-sh-1', '--format', '{{.Config.Image}}']) == v['previous_image'], 'Core image changed since packaging'
assert out(['docker', 'image', 'inspect', v['image'], '--format', '{{.Id}}']) == v['image_id']
assert hashlib.sha256((stage / 'sandboxed-sh').read_bytes()).hexdigest() == v['sha256']

PROBE = r'''
import sqlite3, json, pathlib, datetime, sys
root = pathlib.Path('/root/.sandboxed-sh')
c = sqlite3.connect('file:' + str(root / 'missions/missions-default.db') + '?mode=ro', uri=True)
assert c.execute('select count(*) from mission_runs where ended_at is null').fetchone()[0] == 0, 'A run is still open; let it finish or stop it first'
live = c.execute("select count(*) from missions where status in ('active','pending','waiting_background','running','queued','starting','resuming')").fetchone()[0]
assert live == 0, f'{live} live mission(s); let them finish or stop them first'
pending = c.execute("select count(*) from control_queue q, json_each(q.payload) j where q.id=1 and coalesce(json_extract(j.value,'$.inflight'),0)=0").fetchone()[0]
assert not pending, 'A queued delivery is pending'
assert c.execute("select count(*) from machine_transfers where phase not in ('cancelled','completed','failed')").fetchone()[0] == 0, 'A machine transfer is in progress'
record = {'missions': c.execute('select count(*) from missions').fetchone()[0],
          'statuses': dict(c.execute('select status, count(*) from missions group by status').fetchall())}
if sys.argv[1] == 'backup':
    p = root / 'deployment-backups' / ('deploy-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    p.mkdir(mode=0o700, parents=True)
    dst = sqlite3.connect(str(p / 'missions.db')); c.backup(dst); dst.close(); (p / 'missions.db').chmod(0o600)
    record['snapshot'] = str(p)
print(json.dumps(record))
'''
def check(mode):
    r = subprocess.run(['docker', 'exec', '-i', 'orb-sandboxed-sh-1', 'python3', '-', mode], input=PROBE, text=True, capture_output=True)
    if r.returncode: raise RuntimeError('Deploy guard refused: ' + r.stderr.strip().splitlines()[-1])
    return json.loads(r.stdout)

before = check('backup')
config = pathlib.Path('/home/thomas/orb/docker-compose.override.yml'); text = config.read_text()
assert text.count(v['previous_image']) == 1, 'Override does not pin exactly the previous image'
rollback = stage / 'docker-compose.override.rollback.yml'; shutil.copy2(config, rollback); rollback.chmod(0o600)
restart = ['python3', '/home/thomas/orb/scripts/compose-core.py', 'restart', '--directory', '/home/thomas/orb']
check('check')
config.write_text(text.replace(v['previous_image'], v['image']))
try:
    subprocess.run(restart, check=True)
    running = out(['docker', 'exec', 'orb-sandboxed-sh-1', 'sha256sum', '/usr/local/bin/sandboxed-sh']).split()[0]
    assert running == v['sha256'], 'Core is not running the packaged binary'
    after = check('check')
    assert after['missions'] == before['missions'], 'Mission count changed across the restart'
except BaseException:
    shutil.copy2(rollback, config); subprocess.run(restart, check=True); raise
record = {**v, 'state': 'activated', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'before': before, 'after': after, 'rollback_config': str(rollback)}
(stage / 'ACTIVATED.json').write_text(json.dumps(record, indent=2)); print(json.dumps(record))
