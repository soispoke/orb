import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { RemoteQueue, type RemoteQueueHandle } from '../src/RemoteQueue';
const backend = vi.hoisted(() => ({ list: vi.fn(), api: vi.fn() }));
vi.mock('../src/api', () => ({ listQueuedMessages: backend.list, api: backend.api, connectionVersion: () => 1 }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('shows durable remote messages in order and removes only the selected entry', async () => {
  backend.list.mockResolvedValue([{ id: 'one', content: 'First', source: 'remote-queue' },{ id: 'two', content: 'Second', source: 'remote-queue' },{ id: 'local', content: 'Local', source: 'api' }]);
  backend.api.mockResolvedValue({ ok: true });
  const cancel = vi.fn(), rows = vi.fn();
  render(() => <RemoteQueue mission="remote" onRows={rows} onCancel={cancel}/>);
  await screen.findByText('2 Queued');
  expect(rows).toHaveBeenLastCalledWith(['one', 'two']);
  expect(screen.queryByText('Local')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Remove queued message: First' }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('one'));
  expect(backend.api).toHaveBeenCalledWith('/api/control/queue/one', { method: 'DELETE' });
  expect(screen.queryByText('First')).toBeNull();
  expect(screen.getByText('Second')).toBeTruthy();
});
it('keeps the queue visible if cancellation fails', async () => {
  backend.list.mockResolvedValue([{ id: 'next', content: 'Try again', source: 'remote-queue' }]);
  backend.api.mockRejectedValue(new Error('Connection unavailable'));
  const cancel = vi.fn();
  render(() => <RemoteQueue mission="remote" onRows={() => {}} onCancel={cancel}/>);
  await screen.findByText('Try again');
  await fireEvent.click(screen.getByRole('button', { name: 'Remove queued message: Try again' }));
  await screen.findByRole('alert');
  expect(screen.getByText('Try again')).toBeTruthy();
  expect(cancel).not.toHaveBeenCalled();
});
it('reconciles delivery or cancellation from another client without reopening', async () => {
  backend.list.mockResolvedValueOnce([{id:'next',content:'Queued',source:'remote-queue'}]).mockResolvedValue([]);
  const rows=vi.fn();
  render(()=><RemoteQueue mission="remote" onRows={rows} onCancel={()=>{}}/>);
  await screen.findByText('Queued');
  await waitFor(()=>expect(rows).toHaveBeenLastCalledWith([]),{timeout:4000});
  expect(screen.queryByText('Queued')).toBeNull();
});

it('shows host follow-ups with the blocking writer and cancellation', async () => {
  backend.list.mockResolvedValue([{id:'host',content:'Follow up',source:'host-queue:api:u',queue_error:'Waiting for PR writer blocker'}, {id:'done',content:'Consumed',source:'host-queue:api:u',inflight:true}]);
  backend.api.mockResolvedValue({ok:true});
  const cancel=vi.fn();
  render(()=><RemoteQueue mission="host" onRows={()=>{}} onCancel={cancel}/>);
  await screen.findByText('1 Queued');
  expect(screen.getByText(/Waiting for PR writer blocker/)).toBeTruthy();
  expect(screen.queryByText('Consumed')).toBeNull();
  await fireEvent.click(screen.getByRole('button',{name:'Remove queued message: Follow up'}));
  await waitFor(()=>expect(cancel).toHaveBeenCalledWith('host'));
});

it('shows sending and confirmed receipts without waiting for a slow queue poll', async () => {
  backend.list.mockReturnValue(new Promise(()=>{}));
  const {createSignal} = await import('solid-js');
  const [pending,setPending]=createSignal<{id:string;content:string}|undefined>({id:'next',content:'Continue overnight'});
  const [confirmed,setConfirmed]=createSignal<{id:string;content:string}[]>([]);
  render(()=><RemoteQueue mission="remote" pending={pending()} confirmed={confirmed()} onRows={()=>{}} onCancel={()=>{}}/>);
  expect(screen.getByText('Continue overnight')).toBeTruthy();
  expect(screen.queryByRole('button',{name:/Remove queued message/})).toBeNull();
  setConfirmed([{id:'next',content:'Continue overnight'}]);setPending(undefined);
  await screen.findByText('1 Queued');
  expect(screen.getAllByText('Continue overnight')).toHaveLength(1);
  expect(screen.getByRole('button',{name:'Remove queued message: Continue overnight'})).toBeTruthy();
});

it('supports editing, replacing in order, and sending a queued remote message immediately', async () => {
  backend.list.mockResolvedValue([{ id: 'one', content: 'First', source: 'remote-queue' }, { id: 'two', content: 'Second', source: 'remote-queue' }]);
  backend.api.mockResolvedValue({ ok: true });
  const edit = vi.fn(), sendImmediate = vi.fn().mockResolvedValue(undefined);
  let handle!: RemoteQueueHandle;
  render(() => <RemoteQueue mission="remote" ref={h => handle = h} onEdit={edit} onSendImmediate={sendImmediate} onRows={() => {}} onCancel={() => {}}/>);
  await screen.findByText('2 Queued');
  await fireEvent.click(screen.getByRole('button', { name: 'Edit queued message: First' }));
  expect(edit).toHaveBeenCalledWith({ id: 'one', text: 'First', remote: true });
  const sendReplaced = vi.fn().mockResolvedValue(true);
  const replayAfter = vi.fn().mockResolvedValue(undefined);
  expect(await handle.replaceEdited('one', sendReplaced, replayAfter)).toBe(true);
  expect(backend.api).toHaveBeenCalledWith('/api/control/queue/one', { method: 'DELETE' });
  expect(backend.api).toHaveBeenCalledWith('/api/control/queue/two', { method: 'DELETE' });
  expect(sendReplaced).toHaveBeenCalledTimes(1);
  expect(replayAfter).toHaveBeenCalledWith([{ content: 'Second', attached: undefined }]);
});

it('keeps messages queued when live delivery is unsupported, without cancelling or resending', async () => {
  backend.list.mockResolvedValue([{id:'one',content:'First',source:'remote-queue'}, {id:'two',content:'Second',source:'remote-queue'}]);
  backend.api.mockResolvedValue({ok:true,delivered:false});
  const send = vi.fn(), cancel = vi.fn();
  render(() => <RemoteQueue mission="remote" onSendImmediate={send} onRows={()=>{}} onCancel={cancel}/>);
  await screen.findByText('2 Queued');
  await fireEvent.click(screen.getByRole('button',{name:'Send now: Second'}));
  // Waiting is normal, not a failure: it is shown as information, not an alert.
  expect((await screen.findByRole('status')).textContent).toContain('still queued');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('2 Queued')).toBeTruthy();
  expect(backend.api).toHaveBeenCalledTimes(1);
  expect(backend.api).toHaveBeenCalledWith('/api/control/queue/two/send-now',{method:'POST'});
  expect(send).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});
it('shows the reason a queued message waits without calling it a failure', async () => {
  backend.list.mockResolvedValue([{id:'one',content:'First',source:'host-queue:api:u',queue_error:'Waiting for a free run slot (5 of 5 in use); it starts automatically'}]);
  backend.api.mockResolvedValue({ok:true,delivered:false});
  render(() => <RemoteQueue mission="host" onRows={()=>{}} onCancel={()=>{}}/>);
  await screen.findByText('1 Queued');
  await fireEvent.click(screen.getByRole('button',{name:'Send now: First'}));
  expect((await screen.findByRole('status')).textContent).toBe('Not sent yet: Waiting for a free run slot (5 of 5 in use); it starts automatically. It’s still queued.');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('does not turn an ambiguous network failure into a delete and resend', async () => {
  backend.list.mockResolvedValue([{id:'one',content:'First',source:'remote-queue'}]);
  backend.api.mockRejectedValue(new Error('Connection interrupted'));
  const send = vi.fn();
  render(() => <RemoteQueue mission="remote" onSendImmediate={send} onRows={()=>{}} onCancel={()=>{}}/>);
  await screen.findByText('1 Queued');
  await fireEvent.click(screen.getByRole('button',{name:'Send now: First'}));
  expect((await screen.findByRole('alert')).textContent).toContain('Connection interrupted');
  expect(screen.getByText('First')).toBeTruthy();
  expect(backend.api).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
});
it('removes ghost receipts absent from the authoritative queue', async () => {
  backend.list.mockResolvedValue([]);
  const cancel=vi.fn();
  render(() => <RemoteQueue mission="remote" confirmed={[{id:'ghost',content:'Old retry'}]} onRows={()=>{}} onCancel={cancel}/>);
  await waitFor(()=>expect(cancel).toHaveBeenCalledWith('ghost'));
  expect(screen.queryByText('Old retry')).toBeNull();
});
it('preserves a new receipt arriving after a queue read began', async () => {
  let finish!: (rows:unknown[])=>void;
  backend.list.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  const {createSignal}=await import('solid-js');
  const [confirmed,setConfirmed]=createSignal<{id:string;content:string}[]>([]);
  const cancel=vi.fn();
  render(()=><RemoteQueue mission="remote" confirmed={confirmed()} onRows={()=>{}} onCancel={cancel}/>);
  setConfirmed([{id:'new',content:'Just sent'}]);finish([]);
  await waitFor(()=>expect(screen.getByText('Just sent')).toBeTruthy());
  expect(cancel).not.toHaveBeenCalled();
});

it('injects the selected queued message live without deleting remaining queued messages when the harness accepts mid-turn input', async () => {
  backend.list.mockResolvedValue([
    { id: 'one', content: 'First', source: 'remote-queue' },
    { id: 'two', content: 'Steer live now', source: 'remote-queue' },
  ]);
  backend.api.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/api/control/queue/two/send-now' && init?.method === 'POST') {
      return Promise.resolve({ ok: true, delivered: true });
    }
    return Promise.resolve({ ok: true });
  });
  const sendImmediate = vi.fn().mockResolvedValue(undefined);
  const cancel = vi.fn();
  const rows = vi.fn();
  render(() => <RemoteQueue mission="remote" onSendImmediate={sendImmediate} onRows={rows} onCancel={cancel}/>);
  await screen.findByText('2 Queued');
  await fireEvent.click(screen.getByRole('button', { name: 'Send now: Steer live now' }));
  await waitFor(() => expect(sendImmediate).toHaveBeenCalledWith(
    [],
    [{ id: 'two', content: 'Steer live now', attached: undefined }],
  ));
  expect(backend.api).toHaveBeenCalledWith('/api/control/queue/two/send-now', { method: 'POST' });
  expect(backend.api).not.toHaveBeenCalledWith('/api/control/queue/one', { method: 'DELETE' });
  expect(backend.api).not.toHaveBeenCalledWith('/api/control/queue/two', { method: 'DELETE' });
  expect(cancel).toHaveBeenCalledWith('two');
  expect(cancel).not.toHaveBeenCalledWith('one');
  expect(screen.getByText('First')).toBeTruthy();
  expect(screen.queryByText('Steer live now')).toBeNull();
});

it('removes a queued message optimistically before the DELETE request resolves and stacks multiple pending items in order', async () => {
  backend.list.mockResolvedValue([{ id: 'one', content: 'First confirmed', source: 'remote-queue' }]);
  let resolveDelete!: () => void;
  backend.api.mockImplementation(() => new Promise<unknown>(r => { resolveDelete = () => r({ ok: true }); }));
  const cancel = vi.fn();
  const { createSignal } = await import('solid-js');
  const [pending, setPending] = createSignal([
    { id: 'p1', content: 'Stacked 1' },
    { id: 'p2', content: 'Stacked 2' },
  ]);
  render(() => <RemoteQueue mission="remote" pending={pending()} onRows={() => {}} onCancel={cancel}/>);
  await screen.findByText('3 Queued');
  const items = Array.from(document.querySelectorAll('.queue-text')).map(el => el.textContent);
  expect(items).toEqual(['First confirmed', 'Stacked 1', 'Stacked 2']);

  // Click Delete on 'First confirmed' while DELETE is still pending in flight
  await fireEvent.click(screen.getByRole('button', { name: 'Remove queued message: First confirmed' }));
  // Optimistic DOM removal happens synchronously before resolveDelete() is called
  expect(screen.queryByText('First confirmed')).toBeNull();
  expect(cancel).not.toHaveBeenCalled();
  expect(screen.getByText('2 Sending…')).toBeTruthy();
  resolveDelete();
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('one'));
  setPending([{ id: 'p2', content: 'Stacked 2' }]);
  await screen.findByText('1 Sending…');
});



it('reconciles a send-now 404 without resending or leaving a zero-item sending indicator', async () => {
  backend.list.mockResolvedValue([{id:'one',content:'Already consumed',source:'remote-queue'}]);
  backend.api.mockRejectedValue(new Error('404 message not in queue'));
  const cancel=vi.fn(), send=vi.fn();
  render(()=><RemoteQueue mission="remote" onRows={()=>{}} onCancel={cancel} onSendImmediate={send}/>);
  await screen.findByText('Already consumed');
  fireEvent.click(screen.getByRole('button',{name:'Send now: Already consumed'}));
  await waitFor(()=>expect(cancel).toHaveBeenCalledWith('one'));
  expect(screen.queryByRole('region',{name:'Queued messages'})).toBeNull();
  expect(screen.queryByText('0 Sending…')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(send).not.toHaveBeenCalled(); expect(backend.api).toHaveBeenCalledTimes(1);
});

it('reconciles an aborted send without resending and clears its stale error when dequeued', async () => {
  backend.list.mockResolvedValue([{id:'one',content:'Status?',source:'remote-queue'}]);
  backend.api.mockRejectedValue(new DOMException('Fetch is aborted','AbortError'));
  const send=vi.fn();
  render(()=><RemoteQueue mission="remote" onRows={()=>{}} onCancel={()=>{}} onSendImmediate={send}/>);
  await screen.findByText('Status?');
  fireEvent.click(screen.getByRole('button',{name:'Send now: Status?'}));
  expect((await screen.findByRole('alert')).textContent).toContain('Delivery wasn’t confirmed');
  backend.list.mockResolvedValue([]);
  await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull(),{timeout:4000});
  expect(send).not.toHaveBeenCalled(); expect(backend.api).toHaveBeenCalledTimes(1);
});

it('keeps automatic steering out of the queue and prevents a second keyboard delivery',async()=>{
 const {createSignal}=await import('solid-js');
 backend.list.mockResolvedValue([{id:'steering',content:'Visible in chat',source:'remote-queue'}]);
 const [hidden,setHidden]=createSignal<ReadonlySet<string>>(new Set(['steering']));
 const edit=vi.fn(),rows=vi.fn();let handle!:RemoteQueueHandle;
 render(()=><RemoteQueue mission="auto" hiddenIds={hidden()} ref={value=>handle=value} onEdit={edit} onRows={rows} onCancel={()=>{}}/>);
 await waitFor(()=>expect(rows).toHaveBeenLastCalledWith(['steering']));
 expect(screen.queryByRole('region',{name:'Queued messages'})).toBeNull();
 await handle.sendNow();handle.editFirst();
 expect(backend.api).not.toHaveBeenCalled();expect(edit).not.toHaveBeenCalled();
 setHidden(new Set<string>());
 await screen.findByText('Visible in chat');handle.editFirst();
 expect(edit).toHaveBeenCalledWith({id:'steering',text:'Visible in chat',remote:true});
});

function deferred<T>() {
 let resolve!: (value:T)=>void, reject!: (error:Error)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}

it('navigation releases the old send lock without letting its completion unlock the new chat',async()=>{
 const {createSignal}=await import('solid-js');
 const [mission,setMission]=createSignal('first');
 backend.list.mockImplementation(async(id:string)=>[{id,content:id,source:'remote-queue'}]);
 const first=deferred<{delivered:boolean}>(),second=deferred<{delivered:boolean}>();
 backend.api.mockImplementation((path:string)=>path.includes('/first/')?first.promise:second.promise);
 const cancel=vi.fn(),send=vi.fn();let handle!:RemoteQueueHandle;
 render(()=><RemoteQueue mission={mission()} onRows={()=>{}} onCancel={cancel} onSendImmediate={send} ref={h=>handle=h}/>);
 await screen.findByText('first');const oldSend=handle.sendNow();
 setMission('second');await screen.findByText('second');
 expect((screen.getByRole('button',{name:'Send now: second'}) as HTMLButtonElement).disabled).toBe(false);
 const newSend=handle.sendNow();
 first.resolve({delivered:true});await oldSend;
 expect((screen.getByRole('button',{name:'Send now: second'}) as HTMLButtonElement).disabled).toBe(true);
 expect(cancel).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
 second.resolve({delivered:true});await newSend;
 expect(cancel).toHaveBeenCalledWith('second');
});

it.each(['success','failure'] as const)('ignores an old send %s after navigating away and back',async outcome=>{
 const {createSignal}=await import('solid-js');
 const [mission,setMission]=createSignal('first');
 backend.list.mockImplementation(async(id:string)=>[{id,content:id,source:'remote-queue'}]);
 const request=deferred<{delivered:boolean}>();backend.api.mockReturnValue(request.promise);
 const cancel=vi.fn(),send=vi.fn();let handle!:RemoteQueueHandle;
 render(()=><RemoteQueue mission={mission()} onRows={()=>{}} onCancel={cancel} onSendImmediate={send} ref={h=>handle=h}/>);
 await screen.findByText('first');const sending=handle.sendNow();
 setMission('second');await screen.findByText('second');
 setMission('first');await screen.findByText('first');
 if(outcome==='success')request.resolve({delivered:true});else request.reject(new Error('Old chat error'));
 await sending;
 expect(screen.getByText('first')).toBeTruthy();
 expect(screen.queryByRole('alert')).toBeNull();
 expect(cancel).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
});

it('a failed delete from an old visit cannot restore stale rows after navigating back',async()=>{
 const {createSignal}=await import('solid-js');
 const [mission,setMission]=createSignal('first');
 backend.list.mockResolvedValue([{id:'old',content:'Old queued prompt',source:'remote-queue'}]);
 const request=deferred<unknown>();backend.api.mockReturnValue(request.promise);
 render(()=><RemoteQueue mission={mission()} onRows={()=>{}} onCancel={()=>{}}/>);
 await screen.findByText('Old queued prompt');
 fireEvent.click(screen.getByRole('button',{name:'Remove queued message: Old queued prompt'}));
 backend.list.mockResolvedValue([{id:'new',content:'Current queued prompt',source:'remote-queue'}]);
 setMission('second');await screen.findByText('Current queued prompt');
 setMission('first');await waitFor(()=>expect(backend.list).toHaveBeenCalledTimes(3));
 request.reject(new Error('Old deletion failed'));
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(screen.queryByText('Old queued prompt')).toBeNull();
 expect(screen.getByText('Current queued prompt')).toBeTruthy();
 expect(screen.queryByRole('alert')).toBeNull();
});

it('stops an in-flight queue edit from deleting or submitting into a newly selected chat',async()=>{
 const {createSignal}=await import('solid-js');
 const [mission,setMission]=createSignal('first');
 backend.list.mockResolvedValue([{id:'one',content:'First',source:'remote-queue'},{id:'two',content:'Second',source:'remote-queue'}]);
 const request=deferred<unknown>();backend.api.mockReturnValue(request.promise);
 let handle!:RemoteQueueHandle;const cancel=vi.fn(),replace=vi.fn().mockResolvedValue(true),replay=vi.fn();
 render(()=><RemoteQueue mission={mission()} onRows={()=>{}} onCancel={cancel} ref={h=>handle=h}/>);
 await screen.findByText('First');const editing=handle.replaceEdited('one',replace,replay);
 setMission('second');await waitFor(()=>expect(backend.list).toHaveBeenCalledTimes(2));
 request.resolve({ok:true});expect(await editing).toBe(false);
 expect(backend.api).toHaveBeenCalledTimes(1);
 expect(cancel).not.toHaveBeenCalled();expect(replace).not.toHaveBeenCalled();expect(replay).not.toHaveBeenCalled();
 expect(screen.getByText('First')).toBeTruthy();
});

it('serializes queue mutations while an optimistic delete is pending',async()=>{
 backend.list.mockResolvedValue([{id:'one',content:'First',source:'remote-queue'},{id:'two',content:'Second',source:'remote-queue'}]);
 const request=deferred<unknown>();backend.api.mockReturnValue(request.promise);
 let handle!:RemoteQueueHandle;const replace=vi.fn();
 render(()=><RemoteQueue mission="first" onRows={()=>{}} onCancel={()=>{}} ref={h=>handle=h}/>);
 await screen.findByText('First');
 fireEvent.click(screen.getByRole('button',{name:'Remove queued message: First'}));
 expect((screen.getByRole('button',{name:'Remove queued message: Second'}) as HTMLButtonElement).disabled).toBe(true);
 await handle.sendNow('two');expect(await handle.replaceEdited('two',replace)).toBe(false);
 expect(backend.api).toHaveBeenCalledTimes(1);expect(replace).not.toHaveBeenCalled();
 request.reject(new Error('Connection unavailable'));
 await screen.findByText('First');
 expect((screen.getByRole('button',{name:'Remove queued message: Second'}) as HTMLButtonElement).disabled).toBe(false);
});

it('does not let a queue poll confirm an optimistic deletion before its request succeeds',async()=>{
 const callbacks:(()=>void)[]=[];
 const interval=vi.spyOn(globalThis,'setInterval').mockImplementation(((callback:()=>void)=>{callbacks.push(callback);return 1;}) as typeof setInterval);
 try {
  const row={id:'one',content:'Pending deletion',source:'remote-queue'};
  backend.list.mockResolvedValue([row]);
  const request=deferred<unknown>();backend.api.mockReturnValue(request.promise);
  const cancel=vi.fn();
  render(()=><RemoteQueue mission="first" confirmed={[row]} onRows={()=>{}} onCancel={cancel}/>);
  await waitFor(()=>expect(backend.list).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button',{name:'Remove queued message: Pending deletion'}));
  for(const refresh of callbacks)refresh();
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(backend.list).toHaveBeenCalledTimes(1);expect(cancel).not.toHaveBeenCalled();
  request.reject(new Error('Connection unavailable'));
  await screen.findByText('Pending deletion');
  expect(cancel).not.toHaveBeenCalled();
 } finally {interval.mockRestore();}
});

it('does not submit a queued replacement twice while its first deletion is pending',async()=>{
 backend.list.mockResolvedValue([{id:'one',content:'First',source:'remote-queue'}]);
 const request=deferred<unknown>();backend.api.mockReturnValue(request.promise);
 let handle!:RemoteQueueHandle;const replace=vi.fn().mockResolvedValue(true);
 render(()=><RemoteQueue mission="first" onRows={()=>{}} onCancel={()=>{}} ref={h=>handle=h}/>);
 await screen.findByText('First');
 const first=handle.replaceEdited('one',replace);
 expect(await handle.replaceEdited('one',replace)).toBe(false);
 expect(backend.api).toHaveBeenCalledTimes(1);
 request.resolve({ok:true});expect(await first).toBe(true);
 expect(replace).toHaveBeenCalledTimes(1);
});
