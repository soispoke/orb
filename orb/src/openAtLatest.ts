import {createEffect, createSignal, onCleanup} from 'solid-js';

// Keep the transcript in layout while the tail's virtual rows are measured.
// Reveal only the final position, rather than painting the top and scrolling
// through it. This owns opening only; each view retains its reader/follow policy.
export function openAtLatest(element: () => HTMLElement | undefined, ready: () => boolean) {
  const [pending, setPending] = createSignal(true);
  let frame = 0, disposed = false;
  const release = () => { cancelAnimationFrame(frame); frame = 0; setPending(false); };
  createEffect(() => {
    if (!ready() || !pending() || frame) return;
    let previous = '', stable = 0, started = performance.now();
    const settle = () => {
      if (disposed || !pending()) return;
      const scroll = element();
      if (!scroll) { frame = requestAnimationFrame(settle); return; }
      scroll.scrollTop = scroll.scrollHeight;
      const last = scroll.querySelector('[data-virtual-transcript]')?.lastElementChild;
      const geometry = `${scroll.scrollHeight}:${scroll.clientHeight}:${last?.getBoundingClientRect().bottom}`;
      stable = geometry === previous ? stable + 1 : 0;
      previous = geometry;
      // ResizeObserver and the virtualizer each schedule a frame. Wait beyond
      // both; continuously streaming text must not keep the chat hidden forever.
      if ((stable >= 4 && document.fonts?.status !== 'loading') || performance.now() - started >= 750) release();
      else frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
  });
  onCleanup(() => { disposed = true; cancelAnimationFrame(frame); });
  return {pending, release};
}
