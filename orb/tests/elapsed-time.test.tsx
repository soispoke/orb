import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, render, screen} from '@solidjs/testing-library';
import {createSignal} from 'solid-js';
import {ElapsedTime, elapsedLabel} from '../src/ElapsedTime';
import {buildTranscript} from '../src/transcriptModel';
import {storedToStream} from '../src/stream';
afterEach(() => {cleanup();vi.useRealTimers();});
describe('command elapsed time', () => {
 it('ticks, freezes on completion, and releases its interval', () => {
  vi.useFakeTimers();vi.setSystemTime(100000);
  const [done,setDone]=createSignal(false);
  render(()=><ElapsedTime startedAt={39000} finishedAt={done()?102000:undefined} running={!done()}/>);
  expect(screen.getByText('Working for 1m 1s')).toBeTruthy();
  vi.advanceTimersByTime(2000);expect(screen.getByText('Working for 1m 3s')).toBeTruthy();
  setDone(true);vi.advanceTimersByTime(90000);
  expect(screen.getByText('Ran for 1m 3s')).toBeTruthy();expect(vi.getTimerCount()).toBe(0);
 });
 it('does not invent a clock for old or interrupted events', () => {
  const view=render(()=><><ElapsedTime running/><ElapsedTime startedAt={1} running={false}/></>);
  expect(view.container.textContent).toBe('');
 });
 it('retains stored timestamps across replay and duplicate calls', () => {
  const call=storedToStream({id:1,sequence:1,event_type:'tool_call',timestamp:'2026-10-14T09:00:00Z',tool_call_id:'a',tool_name:'Bash',content:'{}'})!;
  const result=storedToStream({id:2,sequence:2,event_type:'tool_result',timestamp:'2026-10-14T09:01:03Z',tool_call_id:'a',content:'{}'})!;
  const items=buildTranscript([call,{...call,sequence:3,timestamp:'2026-10-14T09:00:20Z'},result]);
  expect(items[0]).toMatchObject({startedAt:Date.parse(call.timestamp!),finishedAt:Date.parse(result.timestamp!),done:true});
 });
 it('formats hours and clamps clock skew',()=>{expect(elapsedLabel(3661000)).toBe('1h 1m 1s');expect(elapsedLabel(-500)).toBe('0s');});
});
