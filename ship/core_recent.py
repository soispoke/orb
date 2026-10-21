# Read-only: latest run and messages of the sig.golf fork.
import sqlite3
c=sqlite3.connect('file:/root/.sandboxed-sh/missions/missions-default.db?mode=ro',uri=True)
mid='f5db653d-c39f-429c-872e-05e87e32b10b'
print(c.execute("select status from missions where id=?",(mid,)).fetchone())
for r in c.execute("select generation,started_at,ended_at,terminal_reason from mission_runs where mission_id=? order by rowid desc limit 2",(mid,)):print('RUN',r)
for seq,t,ts,content in c.execute("select sequence,event_type,timestamp,content from mission_events where mission_id=? and event_type in ('user_message','assistant_message','error') and timestamp > '2026-10-21T05:38' order by sequence",(mid,)):
    print(seq,t,ts[:19],'\n   ',str(content)[:1200].replace('\n','\n    '))
