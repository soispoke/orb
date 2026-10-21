# Read-only: why did recent sig.golf conversations stop? Runs inside the Core container.
import sqlite3, json
c = sqlite3.connect('file:/root/.sandboxed-sh/missions/missions-default.db?mode=ro', uri=True)
c.row_factory = sqlite3.Row
cols = lambda t: [r[1] for r in c.execute(f'pragma table_info({t})')]
print('missions cols', cols('missions'))
print('runs cols', cols('mission_runs'))
ms = [dict(r) for r in c.execute(
    "select id,title,status,backend,updated_at from missions "
    "where lower(title) like '%sig%golf%' or lower(title) like '%siggolf%' or lower(title) like '%sig.golf%' "
    "order by updated_at desc limit 6")]
for m in ms:
    print('\nMISSION', json.dumps(m))
    for r in c.execute('select * from mission_runs where mission_id=? order by rowid desc limit 3', (m['id'],)):
        print('  RUN', json.dumps({k: (str(v)[:300] if v is not None else None) for k, v in dict(r).items()}))
ev = cols('mission_events') if c.execute("select 1 from sqlite_master where name='mission_events'").fetchone() else []
if ms and ev:
    for r in c.execute('select * from mission_events where mission_id=? order by rowid desc limit 12', (ms[0]['id'],)):
        d = dict(r)
        print('  EV', d.get('sequence'), d.get('event_type'), d.get('timestamp'), str(d.get('content'))[:240].replace('\n', ' '), str(d.get('metadata'))[:200])
