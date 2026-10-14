import {createSignal} from 'solid-js';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@solidjs/testing-library';
import {collectSubagents, Subagents} from '../src/Subagents';
import {applyStreamEvent, buildTranscript, type StreamItem} from '../src/transcriptModel';
import {storedToStream} from '../src/stream';
afterEach(() => {cleanup(); vi.unstubAllGlobals();});
const call: StreamItem = {kind:'tool',key:'call',callId:'call',name:'Agent',args:{description:'Inspect parser',prompt:'Check unicode boundaries',run_in_background:true},done:true,result:'Agent launched'};
const agent = (status = 'running', detail = 'Using Read'): StreamItem => ({kind:'subagent',key:'agent:a',text:'Inspect parser',agent:{id:'a',tool_call_id:'call',description:'Inspect parser',status,detail}});

describe('subagent lifecycle', () => {
  it('does not mistake an asynchronous launch result for child completion', () => {
    expect(collectSubagents([call])[0].status).toBe('unknown');
    expect(collectSubagents([call,agent()])).toHaveLength(1);
    expect(collectSubagents([call,agent()])[0].status).toBe('running');
    expect(collectSubagents([call,agent('failed')])[0].status).toBe('failed');
  });
  it('replays persisted lifecycle and keeps children running after parent final', () => {
    const data = (agent() as Extract<StreamItem,{kind:'subagent'}>).agent;
    const saved = storedToStream({id:1,sequence:1,event_type:'subagent_update',timestamp:'2026-10-14',content:JSON.stringify(data)})!;
    let items = buildTranscript([saved,{type:'assistant_message',data:{content:'I started a helper',success:true}}]);
    expect(collectSubagents(items)[0].status).toBe('running');
    items = applyStreamEvent(items,{type:'subagent_update',sequence:2,data:{agent:{...data,status:'completed'}}});
    items = applyStreamEvent(items,saved);
    expect(collectSubagents(items)).toHaveLength(1);
    expect(collectSubagents(items)[0].status).toBe('completed');
  });
  it('keeps the same expanded row when native task identity arrives and finishes', () => {
    const [items,setItems] = createSignal<StreamItem[]>([{...call,done:false}]);
    const {container} = render(() => <Subagents items={items()}/>);
    const button = screen.getByRole('button',{name:/Inspect parser/});
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    setItems([call,agent()]);
    expect(screen.getByRole('button',{name:/Inspect parser/})).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Using Read')).toBeTruthy();
    setItems([call,agent('completed','No defects found')]);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.subagent')?.getAttribute('data-state')).toBe('completed');
    expect(screen.getByText('No defects found')).toBeTruthy();
  });
  it('retains list order across status changes and supports keyboard-native controls', () => {
    const first = agent(), second = {...agent(), key:'agent:b',agent:{id:'b',description:'Check tests',status:'running'}};
    const [items,setItems] = createSignal<StreamItem[]>([first,second]);
    render(() => <Subagents items={items()}/>);
    setItems([agent('completed'),second]);
    expect(screen.getAllByRole('button').slice(1).map(b => b.textContent)).toEqual(['Inspect parserDone›','Check testsWorking›']);
    const heading = screen.getByRole('button',{name:/Subagents/});
    fireEvent.click(heading);
    expect(screen.queryByRole('button',{name:/Inspect parser/})).toBeNull();
    fireEvent.click(heading);
    expect(screen.getByRole('button',{name:/Inspect parser/})).toBeTruthy();
  });
  it('does not label interrupted work as successfully completed', () => {
    const {container}=render(() => <Subagents items={[agent()]} interrupted/>);
    expect(container.querySelector('.subagent')?.getAttribute('data-state')).toBe('unknown');
    expect(screen.getByText('Status unavailable')).toBeTruthy();
  });
});

it('keeps new live agents visible beyond folded history, including after completion',()=>{
 const history:StreamItem[]=Array.from({length:8},(_,i)=>({kind:'subagent',key:`old-${i}`,text:`Old ${i}`,agent:{id:`old-${i}`,description:`Old ${i}`,status:'completed'}}));
 const [items,setItems]=createSignal([...history,agent()]);
 render(()=><Subagents items={items()}/>);
 const row=screen.getByRole('button',{name:/Inspect parser/});
 fireEvent.click(row);
 setItems([...history,agent('completed','Finished last task')]);
 expect(screen.getByRole('button',{name:/Inspect parser/})).toBe(row);
 expect(row.getAttribute('aria-expanded')).toBe('true');
});

it('preserves the launch time when a terminal lifecycle event has no start timestamp', () => {
 const items: StreamItem[]=[{...call,startedAt:1000}, {...agent('completed'),agent:{id:'a',tool_call_id:'call',description:'Inspect parser',status:'completed',startedAt:undefined,finishedAt:64000}} as StreamItem];
 expect(collectSubagents(items)[0]).toMatchObject({startedAt:1000,finishedAt:64000});
});

it('loads real Workflow children through the mission-scoped API and cancels on unmount', async () => {
  const receipt: StreamItem = {...call, name:'Workflow', result:'Workflow launched in background.\nTranscript dir: /root/.claude/subagents/workflows/wf_test\nRun ID: wf_test'};
  const journal = [{type:'started',agentId:'a',label:'subagent-1',phase:'Wait'}, {type:'started',agentId:'b',label:'subagent-2'}, {type:'result',agentId:'a',result:{ok:true}}].map(x=>JSON.stringify(x)).join('\n');
  const fetcher = vi.fn().mockResolvedValue(new Response(journal));
  vi.stubGlobal('fetch', fetcher);
  const {unmount,container} = render(() => <Subagents items={[receipt]} missionId="mission" workspaceId="workspace"/>);
  await screen.findByRole('button', {name:/subagent-1/});
  expect(container.querySelectorAll('.subagent')).toHaveLength(2);
  expect(container.querySelectorAll('[data-state="running"]')).toHaveLength(1);
  expect(fetcher.mock.calls[0][0]).toContain('mission_id=mission');
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  unmount();
  // A completed request is no longer attached; no further polling remains after cleanup.
  expect(signal.aborted).toBe(false);
});

it('keeps an expanded Workflow child mounted when another workflow appears or history refreshes', async () => {
  const receipt=(id:string):StreamItem=>({...call,callId:id,name:'Workflow',result:`Transcript dir: /root/.claude/subagents/workflows/${id}\nRun ID: ${id}`});
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>new Response(JSON.stringify({type:'started',agentId:'a',label:'Stable child'}))));
  const [items,setItems]=createSignal<StreamItem[]>([receipt('first')]);
  render(()=><Subagents items={items()} missionId="m" workspaceId="w"/>);
  const row=await screen.findByRole('button',{name:/Stable child/});
  fireEvent.click(row);
  setItems([receipt('first'),receipt('second')]);
  expect(screen.getByRole('button',{name:/Stable child/})).toBe(row);
  expect(row.getAttribute('aria-expanded')).toBe('true');
  setItems([]);
  expect(screen.getByRole('button',{name:/Stable child/})).toBe(row);
  expect(row.getAttribute('aria-expanded')).toBe('true');
});

it('does not restart Workflow polling when mission metadata refreshes with the same workspace', async () => {
  const receipt:StreamItem={...call,name:'Workflow',result:'Transcript dir: /root/.claude/subagents/workflows/stable\nRun ID: stable'};
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({type:'started',agentId:'a',label:'Metadata stable'}))).mockReturnValue(new Promise(()=>{}));
  vi.stubGlobal('fetch',fetcher);
  const [mission,setMission]=createSignal({id:'m',workspace_id:'w',status:'active'});
  render(()=><Subagents items={[receipt]} missionId={mission().id} workspaceId={mission().workspace_id}/>);
  const row=await screen.findByRole('button',{name:/Metadata stable/});
  fireEvent.click(row);
  expect(fetcher).toHaveBeenCalledTimes(2); // journal + the expanded child transcript
  setMission({id:'m',workspace_id:'w',status:'idle'});
  expect(screen.getByRole('button',{name:/Metadata stable/})).toBe(row);
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('loads child activity only when expanded and keeps lifecycle status from the journal', async () => {
 const receipt:StreamItem={...call,name:'Workflow',result:'Transcript dir: /root/.claude/subagents/workflows/live\nRun ID: live'};
 const fetcher=vi.fn(async(url:string)=>new Response(url.includes('journal.jsonl')
   ? JSON.stringify({type:'started',agentId:'agent1',label:'Live child'})
   : JSON.stringify({type:'assistant',timestamp:'2026-10-14T17:00:00Z',message:{model:'test-model',content:[{type:'tool_use',name:'Bash',input:{description:'Checking proof results'}}]}})));
 vi.stubGlobal('fetch',fetcher);
 const view=render(()=><Subagents items={[receipt]} missionId="m" workspaceId="w"/>);
 const row=await screen.findByRole('button',{name:/Live child/});
 expect(fetcher).toHaveBeenCalledTimes(1);
 fireEvent.click(row);
 expect(await screen.findByText('Bash: Checking proof results')).toBeTruthy();
 expect(screen.getByText(/Last recorded activity:/)).toBeTruthy();
 expect(row.textContent).toContain('Working');
 expect(fetcher.mock.calls[1][0]).toContain('agent-agent1.jsonl');
 view.unmount();
});
