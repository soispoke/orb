import json
import pathlib
import sqlite3
import tempfile
import unittest
from recover_codex_text import candidates, read_native, recover


def event(seq, second, kind='tool_call', text='', key=None):
    return {'id':seq,'sequence':seq,'timestamp':f'2026-10-19T01:00:{second:02d}Z','event_id':key,'event_type':kind,'content':text}


def native(key, second, text='Same words', phase='commentary'):
    return {'id':key,'thread':'t','turn':'turn','time':f'2026-10-19T01:00:{second:02d}Z','ordinal':second,'text':text,'phase':phase}


class RecoveryTests(unittest.TestCase):
    def test_equal_prose_remains_separate_and_only_vacant_slots_are_used(self):
        rows=[event(1,1),event(5,5),event(6,6),event(10,10)]
        plan=candidates([native('a',2),native('b',3),native('no-room',6),native('c',7)],rows,'mission')
        self.assertEqual([(r['id'],r['sequence']) for r in plan],[('a',2),('b',3),('c',7)])

    def test_current_mutable_snapshot_and_existing_identity_are_not_duplicated(self):
        rows=[event(1,1,key='codex:mission:a'),event(6,6,'text_delta','Same words','text_delta_latest'),event(10,10)]
        self.assertEqual(candidates([native('a',2),native('b',5)],rows,'mission'),[])

    def test_final_receipts_and_unbounded_or_reversed_chronology_are_not_invented(self):
        rows=[event(5,1),event(2,5)]
        self.assertEqual(candidates([native('a',2),native('b',10),native('c',3,phase='final_answer')],rows,'m'),[])

    def test_partial_native_record_waits_and_other_thread_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            path=pathlib.Path(d)/'log';state={}
            def row(thread):return json.dumps({'timestamp':'2026-10-19T01:00:02Z','ordinal':2,'payload':{'type':'item_completed','thread_id':thread,'turn_id':'turn','item':{'type':'AgentMessage','id':'a','phase':'commentary','content':[{'type':'Text','text':'saved'}]}}}).encode()
            path.write_bytes(row('other')+b'\n'+row('t'))
            self.assertEqual(read_native(path,'t',state),[])
            with path.open('ab') as f:f.write(b'\n')
            self.assertEqual([r['text'] for r in read_native(path,'t',state)],['saved'])
            self.assertEqual(len(read_native(path,'t',state)),1)

    def test_shared_boundary_trigger_preserves_snapshots_and_ignores_queued_input(self):
        c=sqlite3.connect(':memory:')
        c.executescript('CREATE TABLE mission_events(mission_id TEXT,event_type TEXT,event_id TEXT,sequence INT,metadata TEXT);')
        sql=pathlib.Path(__file__).parents[2]/'src/api/mission_store/preserve_text_boundaries.sql'
        c.executescript(sql.read_text())
        for harness in ['claude','codex','grok','opencode','antigravity']:
            c.execute("INSERT INTO mission_events VALUES (?,'text_delta','text_delta_latest',1,'{}')",(harness,))
            c.execute("INSERT INTO mission_events VALUES (?,'user_message','queued',2,'{\"queued\":true}')",(harness,))
            self.assertEqual(c.execute("SELECT event_id FROM mission_events WHERE mission_id=? AND event_type='text_delta'",(harness,)).fetchone()[0],'text_delta_latest')
            c.execute("INSERT INTO mission_events VALUES (?,'user_message','sent',3,'{}')",(harness,))
            self.assertEqual(c.execute("SELECT event_id FROM mission_events WHERE mission_id=? AND event_type='text_delta'",(harness,)).fetchone()[0],'text_delta_checkpoint:1')

    def test_applied_recovery_is_idempotent_and_never_changes_execution_or_existing_events(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d);home=root/'home';log=home/'sessions'/'t.jsonl';log.parent.mkdir(parents=True)
            (root/'codex-sessions').mkdir()
            binding=root/'codex-sessions'/'m.json'
            binding.write_text(json.dumps({'thread_id':'t','identity':{'codex_home':str(home)}}))
            log.write_text(json.dumps({'timestamp':'2026-10-19T01:00:02Z','ordinal':2,'payload':{'type':'item_completed','thread_id':'t','turn_id':'turn','item':{'type':'AgentMessage','id':'a','phase':'commentary','content':[{'type':'Text','text':'Recovered exactly'}]}}})+'\n')
            c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
            c.executescript("CREATE TABLE missions(id TEXT,session_id TEXT,backend TEXT,status TEXT); INSERT INTO missions VALUES ('m','codex-thread:t','codex','running'); CREATE TABLE mission_events(id INTEGER PRIMARY KEY, mission_id TEXT,sequence INT,event_id TEXT,event_type TEXT,timestamp TEXT,content TEXT,metadata TEXT);")
            for row in [event(1,1),event(5,5)]:
                c.execute("INSERT INTO mission_events VALUES (?, 'm', ?, ?, ?, ?, ?, '{}')",(row['id'],row['sequence'],row['event_id'],row['event_type'],row['timestamp'],row['content']))
            c.commit();original=[dict(r) for r in c.execute('SELECT * FROM mission_events')]
            self.assertEqual(recover(c,root,{},True,root/'audit'),1)
            self.assertEqual(recover(c,root,{},True,root/'audit'),0)
            self.assertEqual([dict(r) for r in c.execute('SELECT * FROM mission_events WHERE id IN (1,5)')],original)
            self.assertEqual(c.execute('SELECT status FROM missions').fetchone()[0],'running')
            self.assertEqual(c.execute("SELECT content FROM mission_events WHERE event_id='codex:m:a'").fetchone()[0],'Recovered exactly')
            c.execute("UPDATE missions SET session_id='codex-thread:other'");c.commit()
            self.assertEqual(recover(c,root,{},True,root/'audit'),0)



if __name__=='__main__':unittest.main()
