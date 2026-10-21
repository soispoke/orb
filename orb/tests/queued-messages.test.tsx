import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@solidjs/testing-library';
import {createSignal} from 'solid-js';
import {QueuedMessages} from '../src/QueuedMessages';
import {LiveInputUnavailable} from '../src/liveInputAvailability';
const queue=vi.hoisted(()=>({rows:[] as any[],retry:vi.fn(),send:vi.fn(),prioritize:vi.fn(),remove:vi.fn(),pending:()=>false}));
vi.mock('../src/localMessageQueue',()=>({
 queuedLocalMessages:()=>queue.rows,localSteeringPending:()=>queue.pending(),
 retryQueuedMessage:queue.retry,sendQueuedNow:queue.send,
 prioritizeQueuedMessage:queue.prioritize,removeQueuedMessage:queue.remove,canDiscardQueuedMessage:()=>true,
}));
afterEach(()=>{cleanup();queue.rows=[];queue.pending=()=>false;vi.resetAllMocks();});
it('offers Retry without a disabled Send now for an interrupted message',async()=>{
 queue.rows=[{id:'interrupted',text:'vas-y',state:'accepted',interrupted:true,error:'Previous agent may still be running.'}];
 let finish!:()=>void;queue.retry.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
 render(()=><QueuedMessages mission="local"/>);
 expect(screen.queryByRole('button',{name:/^Send now/})).toBeNull();
 const retry=screen.getByRole('button',{name:'Retry'}) as HTMLButtonElement;
 await fireEvent.click(retry);
 expect(queue.retry).toHaveBeenCalledWith('interrupted');expect(retry.disabled).toBe(true);
 await fireEvent.click(retry);expect(queue.retry).toHaveBeenCalledTimes(1);
 finish();await waitFor(()=>expect(retry.disabled).toBe(false));
});
it('keeps Send now actionable for a queued message alongside an error',async()=>{
 queue.rows=[{id:'failed',text:'failed',state:'error',error:'Try again'}, {id:'queued',text:'next',state:'queued',waiting:true}];
 render(()=><QueuedMessages mission="local"/>);
 await fireEvent.click(screen.getByRole('button',{name:'Send now: next'}));
 expect(queue.send).toHaveBeenCalledWith('local','queued');expect(queue.retry).not.toHaveBeenCalled();
});

it('shows one line per message with edit, send now and remove actions, and marks the edited row',async()=>{
 queue.rows=['message 1','message 2','message 3'].map((text,i)=>({id:`m${i+1}`,text,state:'queued',waiting:true}));
 const edit=vi.fn();
 const ui=render(()=><QueuedMessages mission="local" onEdit={edit}/>);
 expect(ui.getByText('3 Queued')).toBeTruthy();
 expect(ui.getByText('to Send')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Send now: message 1'})).toBeTruthy();
 await fireEvent.click(screen.getByRole('button',{name:'Send now: message 3'}));
 expect(queue.send).toHaveBeenCalledWith('local','m3');
 await waitFor(()=>expect((screen.getByRole('button',{name:'Remove queued message: message 2'}) as HTMLButtonElement).disabled).toBe(false));
 await fireEvent.click(screen.getByRole('button',{name:'Remove queued message: message 2'}));
 expect(queue.remove).toHaveBeenCalledWith('m2');
 await fireEvent.click(screen.getByRole('button',{name:'Edit queued message: message 2'}));
 expect(edit).toHaveBeenCalledWith({id:'m2',text:'message 2'});
 cleanup();
 render(()=><QueuedMessages mission="local" editing="m2" onEdit={edit}/>);
 expect(screen.getByText('Editing')).toBeTruthy();
 expect(screen.queryByText('to Send')).toBeNull();
 expect((screen.getByRole('button',{name:'Send now: message 1'}) as HTMLButtonElement).disabled).toBe(true);
 await fireEvent.click(screen.getByRole('button',{name:'Hide queued messages'}));
 expect(screen.queryByText('message 1')).toBeNull();
});
it('does not render a duplicate bottom alert when a row already shows the retry error',async()=>{
 const reason='An agent process may still be using this workspace. Stop it before retrying.';
 queue.rows=[{id:'interrupted',text:'resume turn',state:'accepted',interrupted:true,error:`Orb lost the local run. Retry will check that the previous agent stopped. ${reason}`}];
 queue.retry.mockRejectedValue(new Error(reason));
 render(()=><QueuedMessages mission="local"/>);
 await fireEvent.click(screen.getByRole('button',{name:'Retry'}));
 await waitFor(()=>expect(queue.retry).toHaveBeenCalledWith('interrupted'));
 expect(screen.getAllByRole('alert')).toHaveLength(1);
});


it('offers steering while work is active',async()=>{
 queue.rows=[{id:'queued',text:'next',state:'queued',waiting:true}];
 render(()=><QueuedMessages mission="local" busy/>);
 expect(screen.queryByText('to Send')).toBeNull();
 expect(screen.queryByRole('button',{name:'Send now: next'})).toBeNull();
 await fireEvent.click(screen.getByRole('button',{name:'Steer now: next'}));
 expect(queue.send).toHaveBeenCalledWith('local','queued');
});

it('keeps unsupported steering queued with a neutral notice, not a send failure',async()=>{
 queue.rows=[{id:'queued',text:'status',state:'queued',waiting:true}];
 queue.send.mockRejectedValue(new LiveInputUnavailable());
 render(()=><QueuedMessages mission="local" busy/>);
 await fireEvent.click(screen.getByRole('button',{name:'Steer now: status'}));
 await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('Queued for the next turn'));
 expect(screen.queryByRole('alert')).toBeNull();
 expect(screen.getByText('1 Queued')).toBeTruthy();
 expect(queue.retry).not.toHaveBeenCalled();expect(queue.remove).not.toHaveBeenCalled();
});


it('shows pending steering neutrally and keeps lost-ack uncertainty visible after it settles',async()=>{
 const [pending,setPending]=createSignal(true);queue.pending=pending;
 queue.rows=[{id:'steer',text:'eta',state:'error',waiting:true,steerToken:'token',error:'Live delivery is unconfirmed. This message will not be resent automatically.'}];
 const ui=render(()=><QueuedMessages mission="local" busy/>);
 expect(screen.getByText('1 Sending…')).toBeTruthy();
 expect(screen.getByRole('status').textContent).toContain('Sending to the running session');
 expect(screen.queryByRole('alert')).toBeNull();expect(ui.container.querySelector('.failed')).toBeNull();
 setPending(false);
 await waitFor(()=>expect(screen.getByText('1 Delivery unconfirmed')).toBeTruthy());
 expect(screen.getByRole('status').textContent).toContain('will not be resent automatically');
 expect(screen.queryByRole('alert')).toBeNull();expect(screen.queryByRole('button',{name:'Retry'})).toBeNull();
 cleanup();render(()=><QueuedMessages mission="local" busy/>);
 expect(screen.getByText('1 Delivery unconfirmed')).toBeTruthy();
 expect(queue.send).not.toHaveBeenCalled();expect(queue.retry).not.toHaveBeenCalled();
});

it('still presents a real pre-delivery error as a failure',()=>{
 queue.rows=[{id:'failure',text:'question',state:'error',waiting:true,error:'Could not save your message.'}];
 const ui=render(()=><QueuedMessages mission="local"/>);
 expect(screen.getByRole('alert').textContent).toContain('Could not save');
 expect(ui.container.querySelector('.failed')).not.toBeNull();
});
