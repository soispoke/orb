import {describe, it, expect} from 'vitest';
import {parseWorkflowJournal, workflowJournals} from '../src/workflowAgents';
describe('Workflow journals', () => {
  it('tracks separate children, completion and partial writes without inventing timestamps', () => {
    const journal = [JSON.stringify({type:'started',agentId:'a',label:'First',phase:'Wait'}), JSON.stringify({type:'started',agentId:'b',label:'Second'}), JSON.stringify({type:'result',agentId:'a',result:{ok:true}}), '{"type":'].join('\n');
    const rows = parseWorkflowJournal(journal, '/journal');
    expect(rows.map(a=>a.status)).toEqual(['completed','unknown']);
    expect(rows[0].phase).toBe('Wait');
    expect(rows[0].startedAt).toBeUndefined();
    expect(parseWorkflowJournal(journal+'\n'+JSON.stringify({type:'started',agentId:'a'}),'/journal')[0].status).toBe('completed');
  });
  it('reads launch receipts without evaluating scripts and rejects traversal', () => {
    const item = (path: string) => ({kind:'tool', name:'Workflow', done:true, callId:'x',args:{script:'never execute'},result:{output:`Transcript dir: ${path}\nRun ID: x`}} as any);
    expect(workflowJournals([item('/root/.claude/subagents/workflows/wf_1')])).toEqual(['/root/.claude/subagents/workflows/wf_1/journal.jsonl']);
    expect(workflowJournals([item('/root/../subagents/workflows/wf_1')])).toEqual([]);
  });
});

it('extracts real activity without displaying hidden thinking or inventing completion', async () => {
 const {parseWorkflowTranscript}=await import('../src/workflowAgents');
 const result=parseWorkflowTranscript([
  JSON.stringify({timestamp:'2026-10-14T17:00:00Z',type:'assistant',message:{model:'test-model',content:[{type:'text',text:'Checking the build'},{type:'thinking',thinking:'private'}]}}),
  JSON.stringify({timestamp:'2026-10-14T17:01:00Z',type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{description:'Run the verifier'}}]}}),
  '{"type":'
 ].join('\n'));
 expect(result.detail).toBe('Bash: Run the verifier');
 expect(result.model).toBe('test-model');
 expect(result.updatedAt).toBe(Date.parse('2026-10-14T17:01:00Z'));
 expect(result.startedAt).toBe(Date.parse('2026-10-14T17:00:00Z'));
});


it('does not infer liveness from an unchanged start receipt after a restart', () => {
 const content = JSON.stringify({type:'started',agentId:'a',label:'Quiet agent'});
 const before = parseWorkflowJournal(content, '/journal');
 const after = parseWorkflowJournal(content, '/journal');
 expect(before[0].status).toBe('unknown');
 expect(after).toEqual(before);
 expect(after[0].detail).toContain('No live status');
});

it('honors failure receipts and never treats an unrecognized event as completion', () => {
 const events = [{type:'started',agentId:'a'}, {type:'failed',agentId:'a'},
  {type:'started',agentId:'a'}, {type:'started',agentId:'b'}, {type:'unexpected',agentId:'b'}];
 const rows = parseWorkflowJournal(events.map(e=>JSON.stringify(e)).join('\n'), '/journal');
 expect(rows.map(a=>a.status)).toEqual(['failed','unknown']);
 expect(rows[0].detail).toContain('failure');
});

import {mergeWorkflowAgents, parseWorkflowState, workflowStatePath} from '../src/workflowAgents';
const journalPath='/root/.claude/projects/project/session/subagents/workflows/wf_test/journal.jsonl';
const snapshot=(status='killed')=>({runId:'wf_test',taskId:'task1',status,timestamp:'2026-10-15T05:20:20Z',workflowProgress:
 Array.from({length:10},(_,i)=>({type:'workflow_agent',index:i+1,label:`Reviewer ${i+1}`,state:i<2?'progress':'start',phaseTitle:'Review',model:'test',queuedAt:1000,
  ...(i<2?{agentId:`a${i}`,startedAt:1000,tokens:42}:{} )}))});
it('recovers all ten reviewers from native state and stops queued children on abort',()=>{
 const rows=parseWorkflowState(JSON.stringify(snapshot()),journalPath);
 expect(rows).toHaveLength(10);
 expect(rows.every(a=>a.status==='stopped')).toBe(true);
 expect(rows[2].detail).toContain('before this agent started');
 expect(rows[0].tokens).toBe(42);
 expect(rows[0].transcriptPath).toContain('agent-a0.jsonl');
 expect(rows[2].startedAt).toBeUndefined();
});
it('preserves individual terminal outcomes when the parent is killed',()=>{
 const data=snapshot();data.workflowProgress[0].state='done';data.workflowProgress[1].state='error';
 const rows=parseWorkflowState(JSON.stringify(data),journalPath);
 expect(rows.slice(0,3).map(a=>a.status)).toEqual(['completed','failed','stopped']);
});
it('never turns a saved running snapshot into proof of current liveness',()=>{
 const rows=parseWorkflowState(JSON.stringify(snapshot('running')),journalPath);
 expect(rows.every(a=>a.status==='unknown')).toBe(true);
});
it('joins live, saved and journal records without duplicate children or loss of live status',()=>{
 const saved=parseWorkflowState(JSON.stringify(snapshot('running')),journalPath);
 const live={...saved[0],id:'native-run-id',status:'running',transcriptPath:undefined};
 const journal=parseWorkflowJournal(JSON.stringify({type:'started',agentId:'a0'}),journalPath);
 const rows=mergeWorkflowAgents([live,...journal],saved);
 expect(rows).toHaveLength(10);expect(rows[0].id).toBe('workflow:task1:1');expect(rows[0].status).toBe('running');
 const stopped=mergeWorkflowAgents([live],parseWorkflowState(JSON.stringify(snapshot()),journalPath));
 expect(stopped[0].status).toBe('stopped');
});
it('does not apply an old saved outcome to a newer native run',()=>{
 const saved=parseWorkflowState(JSON.stringify(snapshot()),journalPath);
 const live={...saved[0],id:'new-run',status:'running',startedAt:Date.parse('2026-10-15T05:30:00Z'),finishedAt:undefined};
 expect(mergeWorkflowAgents([live],saved)[0].status).toBe('running');
});
it('only derives state paths within the receipt session and rejects mismatched records',()=>{
 expect(workflowStatePath(journalPath)).toBe('/root/.claude/projects/project/session/workflows/wf_test.json');
 expect(workflowStatePath('/root/../subagents/workflows/wf_test/journal.jsonl')).toBeUndefined();
 expect(()=>parseWorkflowState(JSON.stringify({...snapshot(),runId:'other'}),journalPath)).toThrow();
 expect(()=>parseWorkflowState('{',journalPath)).toThrow();
});

it('keeps same-named reviewers from separate workflows distinct and labels their attempts',()=>{
 const earlier=parseWorkflowState(JSON.stringify(snapshot()),journalPath).map(a=>({...a,workflowLabel:'Workflow 1'}));
 const current={...earlier[0],id:'live-current',workflowTaskId:'task2',workflowAgentId:'new-agent',status:'running',workflowLabel:undefined,transcriptPath:undefined};
 const receipt={id:'new-journal:new-agent',description:current.description,status:'unknown',workflowAgentId:'new-agent',workflowLabel:'Workflow 2',transcriptPath:'/new/agent-new-agent.jsonl'};
 const rows=mergeWorkflowAgents([current],[...earlier,receipt]);
 expect(rows).toHaveLength(11);
 expect(rows.filter(a=>a.description===current.description)).toHaveLength(2);
 expect(rows[0]).toMatchObject({status:'running',workflowLabel:'Workflow 2',transcriptPath:'/new/agent-new-agent.jsonl'});
});
