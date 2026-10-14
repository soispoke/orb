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
  expect((await screen.findByRole('alert')).textContent).toContain('still queued');
  expect(screen.getByText('2 Queued')).toBeTruthy();
  expect(backend.api).toHaveBeenCalledTimes(1);
  expect(backend.api).toHaveBeenCalledWith('/api/control/queue/two/send-now',{method:'POST'});
  expect(send).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
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


