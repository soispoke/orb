# Read-only: goal state and goal events of the sig.golf fork.
import sqlite3
c=sqlite3.connect('file:/root/.sandboxed-sh/missions/missions-default.db?mode=ro',uri=True)
mid='f5db653d-c39f-429c-872e-05e87e32b10b'
cols=[r[1] for r in c.execute('pragma table_info(missions)')]
print({k:str(v)[:300] for k,v in zip(cols,c.execute('select * from missions where id=?',(mid,)).fetchone()) if 'goal' in k or k in('terminal_reason','desired_state','status','awaiting_kind')})
print([r for r in c.execute("select event_type,count(*) from mission_events where mission_id=? group by event_type order by 2 desc",(mid,))][:30])
for r in c.execute("select sequence,event_type,timestamp,substr(content,1,300),substr(metadata,1,300) from mission_events where mission_id=? and (event_type like '%goal%' or event_type like '%status%' or event_type like '%turn%' or event_type='error') order by sequence desc limit 25",(mid,)):print(r)
