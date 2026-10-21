import {describe, expect, it, vi} from 'vitest';
import {queuedSteering} from '../src/queuedSteering';
describe('background steering after durable admission', () => {
  it('delivers exactly once after admission, without another keypress', async () => {
    const send = vi.fn(async () => {}), queue = queuedSteering(send);
    queue.submitted('one'); expect(send).not.toHaveBeenCalled();
    queue.admitted('one', true); queue.admitted('one', true);
    await Promise.resolve(); expect(send).toHaveBeenCalledExactlyOnceWith('one');
  });
  it('does not lose rapid submissions when the first admission is delayed', async () => {
    const send = vi.fn(async () => {}), queue = queuedSteering(send);
    queue.submitted('one'); queue.submitted('two');
    queue.admitted('one', true); queue.admitted('two', true);
    await vi.waitFor(()=>expect(send.mock.calls.map(call => call[0])).toEqual(['one', 'two']));
  });
  it('does not steer an idle launch or an unsubmitted recovered queue entry', async () => {
    const send = vi.fn(async () => {}), queue = queuedSteering(send);
    queue.submitted('one'); queue.admitted('one', false); queue.admitted('old', true);
    await Promise.resolve(); expect(send).not.toHaveBeenCalled();
  });
  it('fences both pending admission and scheduled delivery on navigation', async () => {
    const send = vi.fn(async () => {}), queue = queuedSteering(send);
    queue.submitted('one'); queue.submitted('two'); queue.admitted('one', true);
    queue.clear(); queue.admitted('two', true);
    await Promise.resolve(); expect(send).not.toHaveBeenCalled();
  });
  it('never retries an uncertain result', async () => {
    const send = vi.fn(async () => { throw Error('unconfirmed'); }), queue = queuedSteering(send);
    queue.submitted('one'); queue.admitted('one', true);
    await Promise.resolve(); await Promise.resolve();
    queue.admitted('one', true); await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

it('serializes live delivery while admission and draft entry remain independent',async()=>{
 let finish!:()=>void;const send=vi.fn((id:string)=>id==='one'?new Promise<void>(resolve=>finish=resolve):Promise.resolve());
 const queue=queuedSteering(send);queue.submitted('one');queue.submitted('two');
 queue.admitted('one',true);queue.admitted('two',true);
 await Promise.resolve();expect(send).toHaveBeenCalledExactlyOnceWith('one');
 finish();await vi.waitFor(()=>expect(send.mock.calls.map(call=>call[0])).toEqual(['one','two']));
});
