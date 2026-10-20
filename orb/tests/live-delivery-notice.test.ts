import {createRoot, createSignal} from 'solid-js';
import {expect, it, vi} from 'vitest';
import {createLiveDeliveryNotice} from '../src/midrunDelivery';

it('keeps an accepted receipt until the agent answers, instead of hiding it after a few seconds', async () => {
  vi.useFakeTimers();
  await createRoot(async dispose => {
    const [answered, setAnswered] = createSignal(false);
    const [notice, setNotice] = createLiveDeliveryNotice(() => false, () => answered());
    setNotice({id: 'm', state: 'accepted'});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notice()?.state).toBe('accepted');
    setAnswered(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(notice()).toBeUndefined();
    dispose();
  });
  vi.useRealTimers();
});

it('still clears an accepted receipt briefly when no settle signal is given', async () => {
  vi.useFakeTimers();
  await createRoot(async dispose => {
    const [notice, setNotice] = createLiveDeliveryNotice();
    setNotice({id: 'm', state: 'accepted'});
    await vi.advanceTimersByTimeAsync(6_500);
    expect(notice()).toBeUndefined();
    dispose();
  });
  vi.useRealTimers();
});
