# Activate a packaged Core image. Runs ON THE SERVER:
#   ssh host 'python3 - <rev> [--resume-live]' < scripts/orb-ship/core/deploy.py
# Refuses while any mission runs (unless --resume-live), a queued delivery is pending,
# or a machine transfer is open. With --resume-live, Core's startup recovery marks the
# running missions interrupted(server_shutdown) and resumes them; processes inside the
# container (builds, proofs) stop with the restart, and the resumed agents restart them. Backs up the mission database, swaps the image in the Compose override,
# restarts Core and its proxy together, and restores the previous image on any failure.
import datetime, hashlib, json, pathlib, shutil, subprocess, sys, time

rev = sys.argv[1]
resume_live = '--resume-live' in sys.argv[2:]
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
live = [r[0] for r in c.execute("select id from missions where status in ('active','pending','waiting_background','running','queued','starting','resuming')")]
open_runs = c.execute("select mission_id, owner_actor_id from mission_runs where ended_at is null").fetchall()
if sys.argv[2] == 'strict':
    assert not open_runs, 'A run is still open; let it finish or stop it first'
    assert not live, f'{len(live)} live mission(s); let them finish or stop them first'
else:
    # Only Core-owned runs are recovered by Core; a desktop-owned run must stop on its computer.
    assert all(o.startswith('control:') for _, o in open_runs), 'A desktop-owned run is open'
pending = c.execute("select count(*) from control_queue q, json_each(q.payload) j where q.id=1 and coalesce(json_extract(j.value,'$.inflight'),0)=0").fetchone()[0]
assert not pending, 'A queued delivery is pending'
assert c.execute("select count(*) from machine_transfers where phase not in ('activated','cancelled')").fetchone()[0] == 0, 'A machine transfer is in progress'
record = {'live': live, 'missions': c.execute('select count(*) from missions').fetchone()[0],
          'statuses': dict(c.execute('select status, count(*) from missions group by status').fetchall())}
if sys.argv[1] == 'backup':
    p = root / 'deployment-backups' / ('deploy-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    p.mkdir(mode=0o700, parents=True)
    dst = sqlite3.connect(str(p / 'missions.db')); c.backup(dst); dst.close(); (p / 'missions.db').chmod(0o600)
    record['snapshot'] = str(p)
print(json.dumps(record))
'''
def check(mode):
    policy = 'live' if resume_live else 'strict'
    r = subprocess.run(['docker', 'exec', '-i', 'orb-sandboxed-sh-1', 'python3', '-', mode, policy], input=PROBE, text=True, capture_output=True)
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
    resumed = {}
    deadline = time.monotonic() + 300
    while before['live'] and time.monotonic() < deadline:
        status = json.loads(out(['docker', 'exec', '-i', 'orb-sandboxed-sh-1', 'python3', '-c',
            "import sqlite3,json,sys;c=sqlite3.connect('file:/root/.sandboxed-sh/missions/missions-default.db?mode=ro',uri=True);"
            "print(json.dumps({m:c.execute('select status from missions where id=?',(m,)).fetchone()[0] for m in json.loads(sys.argv[1])}))",
            json.dumps(before['live'])]))
        resumed = {m: s for m, s in status.items() if s in ('active', 'running', 'starting', 'resuming')}
        if len(resumed) == len(before['live']): break
        time.sleep(5)
except BaseException:
    shutil.copy2(rollback, config); subprocess.run(restart, check=True); raise
record = {**v, 'state': 'activated', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'before': before, 'after': after, 'resumed': resumed,
          'not_resumed': [m for m in before['live'] if m not in resumed], 'rollback_config': str(rollback)}
(stage / 'ACTIVATED.json').write_text(json.dumps(record, indent=2)); print(json.dumps(record))
