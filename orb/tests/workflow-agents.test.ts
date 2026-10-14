import {describe, it, expect} from 'vitest';
import {parseWorkflowJournal, workflowJournals} from '../src/workflowAgents';
describe('Workflow journals', () => {
  it('tracks separate children, completion and partial writes without inventing timestamps', () => {
    const journal = [JSON.stringify({type:'started',agentId:'a',label:'First',phase:'Wait'}), JSON.stringify({type:'started',agentId:'b',label:'Second'}), JSON.stringify({type:'result',agentId:'a',result:{ok:true}}), '{"type":'].join('\n');
    const rows = parseWorkflowJournal(journal, '/journal');
    expect(rows.map(a=>a.status)).toEqual(['completed','running']);
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
