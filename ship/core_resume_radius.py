# Read-only: missions Core would auto-resume on its next restart (interrupted by a restart within 48 h).
import sqlite3, datetime
c=sqlite3.connect('file:/root/.sandboxed-sh/missions/missions-default.db?mode=ro',uri=True)
cut=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=48)
n=0
for r in c.execute("select id,title,backend,goal_mode,terminal_reason,interrupted_at,status from missions where status='interrupted'"):
    t=r[5]
    if not t: continue
    when=datetime.datetime.fromisoformat(t.replace('Z','+00:00')[:26]+('+00:00' if '+' not in t[19:] and 'Z' not in t else ''))
    if when.tzinfo is None: when=when.replace(tzinfo=datetime.timezone.utc)
    if when>=cut:
        n+=1; print(r[0][:8], r[2], 'goal' if r[3] else '-', r[4], t[:19], (r[1] or '')[:45])
print(n,'interrupted within 48h; only server_shutdown/service_restart ones auto-resume')
