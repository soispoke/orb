import {afterEach, expect, it, vi} from 'vitest';
import {snapshotTextReader} from '../src/snapshotTextReader';
import type {StreamEvent} from '../src/stream';
const snapshot = (sequence: number, content: string): StreamEvent => ({type:'text_delta', sequence, data:{content}});
afterEach(() => vi.useRealTimers());

it('uses authoritative snapshots verbatim, including repeated words and initial characters', async () => {
  vi.useFakeTimers();
  const emit = vi.fn(), read = vi.fn().mockResolvedValue(snapshot(1, 'I prepared the report.\n\nI am validating it.'));
  const reader = snapshotTextReader(read, emit, vi.fn());
  reader.invalidate(); await vi.advanceTimersByTimeAsync(0);
  expect(emit).toHaveBeenLastCalledWith(snapshot(1, 'I prepared the report.\n\nI am validating it.'));
  read.mockResolvedValue(snapshot(2, 'I am validating it. I am validating it.'));
  reader.invalidate(); await vi.advanceTimersByTimeAsync(250);
  expect(emit).toHaveBeenLastCalledWith(snapshot(2, 'I am validating it. I am validating it.'));
  reader.dispose();
});

it('coalesces token bursts, retries a lagging logger and never overlaps requests', async () => {
  vi.useFakeTimers();
  let resolve!: (value: StreamEvent) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise(r => resolve = r)).mockResolvedValue(snapshot(2, 'Complete'));
  const emit = vi.fn(), reader = snapshotTextReader(read, emit, vi.fn());
  reader.invalidate(); await vi.advanceTimersByTimeAsync(0);
  for (let i=0;i<100;i++) reader.invalidate();
  expect(read).toHaveBeenCalledTimes(1);
  resolve(snapshot(1, 'Com')); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(249); expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(emit).toHaveBeenLastCalledWith(snapshot(2, 'Complete'));
  await vi.advanceTimersByTimeAsync(10000);
  const settled = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000); expect(read).toHaveBeenCalledTimes(settled);
  expect(emit).toHaveBeenCalledTimes(2);
  reader.dispose();
});

it.each(['finalize','dispose'] as const)('does not let a delayed snapshot overwrite a %s', async action => {
  vi.useFakeTimers();
  let resolve!: (value: StreamEvent) => void;
  const emit = vi.fn(), reader = snapshotTextReader(() => new Promise(r => resolve = r), emit, vi.fn());
  reader.invalidate(); await vi.advanceTimersByTimeAsync(0);
  reader[action](); resolve(snapshot(1, 'Old prefix'));
  await vi.advanceTimersByTimeAsync(10000); expect(emit).not.toHaveBeenCalled();
  reader.dispose();
});

it('recovers on read failure without rendering guessed text', async () => {
  vi.useFakeTimers();
  const emit = vi.fn(), recover = vi.fn();
  const reader = snapshotTextReader(vi.fn().mockRejectedValue(new Error('offline')),emit,recover);
  reader.invalidate(); await vi.advanceTimersByTimeAsync(0);
  expect(recover).toHaveBeenCalledOnce(); expect(emit).not.toHaveBeenCalled(); reader.dispose();
});

it('fresh output wakes a quiet-stream backoff without exceeding the request cadence', async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue(snapshot(1,'First'));
  const emit = vi.fn(), reader = snapshotTextReader(read,emit,vi.fn());
  reader.invalidate(); await vi.advanceTimersByTimeAsync(800);
  const before = read.mock.calls.length;
  read.mockResolvedValue(snapshot(2,'Next'));
  reader.invalidate(); await vi.advanceTimersByTimeAsync(150);
  expect(read).toHaveBeenCalledTimes(before+1);
  expect(emit).toHaveBeenLastCalledWith(snapshot(2,'Next'));
  reader.dispose();
});
