# Read-only: messages around the end of a run.
import sqlite3
c=sqlite3.connect('file:/root/.sandboxed-sh/missions/missions-default.db?mode=ro',uri=True)
mid='f5db653d-c39f-429c-872e-05e87e32b10b'
for seq,t,ts,content in c.execute("select sequence,event_type,timestamp,content from mission_events where mission_id=? and event_type in ('user_message','assistant_message','assistant_message_canonical','error') and timestamp between '2026-10-20T21:40' and '2026-10-21T05:40' order by sequence",(mid,)):
    print(seq,t,ts[:19],'\n   ',str(content)[:1500].replace('\n','\n    '))
print([r for r in c.execute("select goal_mode, deferred_goal from missions where id=?",(mid,))] if 'goal_mode' in [r[1] for r in c.execute('pragma table_info(missions)')] else 'no goal_mode col')
