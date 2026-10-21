import {renderHook} from '@solidjs/testing-library';
import {afterEach, expect, it, vi} from 'vitest';
import {createLiveDeliveryNotice, createMidrunDelivery, liveDeliveryLabel} from '../src/midrunDelivery';
const mock=vi.hoisted(()=>({version:1,send:vi.fn()}));
vi.mock('../src/api',()=>({connectionVersion:()=>mock.version,sendQueuedMessageNow:mock.send}));
afterEach(()=>{mock.version=1;vi.resetAllMocks();});
it('delivers status and ETA in order using saved identities without stopping work',async()=>{
 const calls:string[]=[];let finish!:(value:boolean)=>void;
 mock.send.mockImplementationOnce((id:string)=>{calls.push(id);return new Promise(resolve=>{finish=resolve;});});
 mock.send.mockImplementationOnce(async(id:string)=>{calls.push(id);return true;});
 const deliver=createMidrunDelivery(()=>true);
 const first=deliver('status'),second=deliver('eta');
 await vi.waitFor(()=>expect(calls).toEqual(['status']));finish(true);
 expect(await first).toBe('accepted');expect(await second).toBe('accepted');
 expect(calls).toEqual(['status','eta']);
 expect(await deliver('status')).toBe('accepted');expect(mock.send).toHaveBeenCalledTimes(2);
});
it('does not replay uncertain delivery, and keeps a definite refusal queued',async()=>{
 mock.send.mockRejectedValueOnce(new Error('Connection lost after write')).mockResolvedValueOnce(false);
 const deliver=createMidrunDelivery(()=>true);
 expect(await deliver('uncertain')).toBe('unconfirmed');
 expect(await deliver('uncertain')).toBe('unconfirmed');
 expect(await deliver('unsupported')).toBe('queued');
 expect(liveDeliveryLabel('queued')).toBe('Queued for the next turn. Work continues.');
 expect(mock.send).toHaveBeenCalledTimes(2);
 expect(liveDeliveryLabel('unconfirmed')).toContain('won’t be resent');
});
it('does not send into a changed connection or a disposed conversation',async()=>{
 const deliver=createMidrunDelivery(()=>true);mock.version++;
 expect(await deliver('old')).toBe('unconfirmed');
 expect(await createMidrunDelivery(()=>false)('closed')).toBe('unconfirmed');
 expect(mock.send).not.toHaveBeenCalled();
});

it('does not apply a late acceptance after connection or conversation ownership changes',async()=>{
 for (const change of ['connection','conversation']) {
  let active=true;let finish!:(value:boolean)=>void;
  mock.send.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
  const deliver=createMidrunDelivery(()=>active);
  const result=deliver(change);
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  if(change==='connection') mock.version++; else active=false;
  finish(true);
  expect(await result).toBe('unconfirmed');
  expect(await deliver(change)).toBe('unconfirmed');
 }
 expect(mock.send).toHaveBeenCalledTimes(2);
});

it('clears accepted receipts after six seconds without clearing a newer pending or uncertain message',()=>{
 vi.useFakeTimers();
 const {result:[notice,setNotice],cleanup}=renderHook(()=>createLiveDeliveryNotice());
 try{
  setNotice({id:'a',state:'accepted'});vi.advanceTimersByTime(5999);
  expect(notice()?.id).toBe('a');vi.advanceTimersByTime(1);expect(notice()).toBeUndefined();
  setNotice({id:'a',state:'accepted'});vi.advanceTimersByTime(3000);setNotice({id:'b',state:'sending'});
  vi.advanceTimersByTime(10000);expect(notice()).toEqual({id:'b',state:'sending'});
  setNotice({id:'b',state:'unconfirmed'});vi.advanceTimersByTime(10000);expect(notice()?.state).toBe('unconfirmed');
 }finally{cleanup();vi.useRealTimers();}
});

it('settles late queued and uncertain notices only from matching delivered receipts',async()=>{
 const {createSignal}=await import('solid-js');
 const {result,cleanup}=renderHook(()=>{
  const [delivered,setDelivered]=createSignal<string>();
  return {notice:createLiveDeliveryNotice(id=>delivered()===id),setDelivered};
 });
 try{
  const [notice,setNotice]=result.notice;
  setNotice({id:'a',state:'queued'});result.setDelivered('other');
  expect(notice()?.state).toBe('queued');
  result.setDelivered('a');expect(notice()).toEqual({id:'a',state:'accepted'});
  // The HTTP refusal can arrive after the durable delivery event.
  setNotice({id:'a',state:'queued'});expect(notice()?.state).toBe('accepted');
  setNotice({id:'b',state:'unconfirmed'});expect(notice()?.state).toBe('unconfirmed');
  result.setDelivered('b');expect(notice()?.state).toBe('accepted');
 }finally{cleanup();}
});
