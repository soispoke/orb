import {createSignal} from 'solid-js';
import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@solidjs/testing-library';
import {collectSubagents, Subagents} from '../src/Subagents';
import {applyStreamEvent, buildTranscript, type StreamItem} from '../src/transcriptModel';
import {storedToStream} from '../src/stream';
afterEach(cleanup);
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
