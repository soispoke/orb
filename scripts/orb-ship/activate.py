# Install a staged Orb UI build: python3 -I scripts/orb-ship/activate.py ~/Applications/Orb-<name>-stage
# Install the staged Orb UI build. Quits only the Orb window process; the
# execution worker, its runs and Core are left untouched. Keeps a rollback copy.
from pathlib import Path
import pathlib, importlib.util, json, subprocess, time, fcntl, datetime, sqlite3, sys

LIB = pathlib.Path(__file__).resolve().parent / 'lib'
spec = importlib.util.spec_from_file_location('guard', LIB / 'guard.py')
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
stage = Path(sys.argv[1]); app = g.APP  # e.g. /Users/alexis/Applications/Orb-<name>-stage
v = json.loads((stage / 'VERIFIED.json').read_text()); exe = app / 'Contents/MacOS/orb'
assert g.digest(exe) == v['installed_sha256'], 'Installed app changed since staging'
assert g.digest(stage / 'Orb.app/Contents/MacOS/orb') == v['candidate_sha256'], 'Staged binary changed'
g.verify_bundle(app); g.verify_bundle(stage / 'Orb.app')
record = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'scope': v['scope']}

with open(g.ROOT / 'boot.lock', 'a+') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    before = g.rpc('status'); rows = g.processes()
    ui = [p for p, r in rows.items() if r['exe'] == str(exe)
          and subprocess.check_output(['ps', '-p', str(p), '-o', 'args='], text=True).strip() == str(exe)]
    assert len(ui) == 1, ui
    assert g.children_clear(rows, ui[0]), 'UI owns live children'
    queue_rows = [json.loads(l) for l in subprocess.check_output(['python3', '-I', str(LIB / 'queue_metadata.py')], text=True).splitlines()]
    assert all(q.get('decoded') and not any(r.get('state') == 'dispatching' for r in q.get('metadata', []))
               for q in queue_rows if q.get('kind') == 'queue'), 'A message is being delivered; try again in a moment'
    protected = {p: r for p, r in rows.items()
                 if p == before['pid'] or p in g.descendants(rows, before['pid']) or Path(r['exe']).name in ('lake', 'lean')}
    record.update(worker_before=before, protected_before=protected, queue_metadata=queue_rows)
    (stage / 'UI_ACTIVATION_BEFORE.json').write_text(json.dumps(record, indent=2))

    incoming = app.with_name(stage.name + '-incoming.app'); rollback = stage / 'ui-rollback.app'
    assert not incoming.exists() and not rollback.exists()
    subprocess.run(['ditto', str(stage / 'Orb.app'), str(incoming)], check=True); g.verify_bundle(incoming)

    # Back up composer drafts transactionally, including WAL contents.
    for index, p in enumerate(Path('/Users/alexis/Library/WebKit/md.thomas.orb').rglob('IndexedDB.sqlite3')):
        src = sqlite3.connect('file:' + str(p) + '?mode=ro', uri=True)
        name = dict(src.execute('select key,value from IDBDatabaseInfo')).get('DatabaseName', b'')
        if isinstance(name, bytes): name = name.decode('utf-16-le')
        if name == 'orb-composer-drafts':
            dst = sqlite3.connect(str(stage / f'draft-backup-{index}.sqlite3')); src.backup(dst); dst.close()
        src.close()

    subprocess.run(['osascript', '-e', 'tell application "/Users/alexis/Applications/Orb.app" to quit'], check=True, timeout=30)
    deadline = time.monotonic() + 60
    while ui[0] in g.processes() and time.monotonic() < deadline: time.sleep(.1)
    assert ui[0] not in g.processes(), 'UI did not quit; nothing was forced or replaced'
    assert g.rpc('status')['pid'] == before['pid']
    assert g.digest(exe) == v['installed_sha256']
    app.rename(rollback)
    try:
        incoming.rename(app); g.verify_bundle(app)
    except BaseException:
        if not app.exists(): rollback.rename(app)
        raise

after = g.rpc('status'); now = g.processes()
assert after['pid'] == before['pid'] and after['executable'] == before['executable']
for r in before['runs']:
    if not r['done']:
        m = [q for q in after['runs'] if q['mission_id'] == r['mission_id']]
        assert m and m[0]['native_generation'] == r['native_generation'], f"run changed: {r['mission_id']}"
record.update(worker_after=after, installed_sha256=g.digest(exe),
              preserved_processes=[p for p, r in protected.items() if p in now and r['start'] == now[p]['start']],
              exited_during_window=[p for p in protected if p not in now])
assert record['installed_sha256'] == v['candidate_sha256']
subprocess.run(['open', '-a', str(app)], check=True)
record['ui_relaunch_requested'] = True
(stage / 'ACTIVATED.json').write_text(json.dumps(record, indent=2))
print('INSTALLED', json.dumps({k: record[k] for k in ['installed_sha256', 'preserved_processes', 'exited_during_window']}
                              | {'worker_pid': after['pid'], 'runs': len(after['runs'])}))
