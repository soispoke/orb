# Read-only: which missions have goal mode on, and what would the new rule do for them?
import sqlite3, json
c=sqlite3.connect('file:/root/.sandboxed-sh/missions/missions-default.db?mode=ro',uri=True)
rows=c.execute("select id,title,status,backend,updated_at,substr(goal_objective,1,60) from missions where goal_mode=1 order by updated_at desc").fetchall()
print(len(rows),'goal-mode missions')
for r in rows:
    st=c.execute("select json_extract(metadata,'$.status') from mission_events where mission_id=? and event_type='goal_status' order by sequence desc limit 1",(r[0],)).fetchone()
    print(r[0][:8], r[2], r[3], r[4][:16], 'last_goal_status=',st[0] if st else None, '|', (r[1] or '')[:40], '|', r[5])
