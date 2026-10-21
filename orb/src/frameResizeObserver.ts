/** Layout writes must run outside ResizeObserver's delivery cycle. */
export function frameResizeObserver(callback: ResizeObserverCallback) {
  let frame = 0, disposed = false;
  const pending = new Map<Element, ResizeObserverEntry>();
  const observer = new ResizeObserver(entries => {
    for (const entry of entries) pending.set(entry.target, entry);
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (disposed) return;
      const batch = [...pending.values()];
      pending.clear();
      callback(batch, observer);
    });
  });
  return {
    observe: (target: Element, options?: ResizeObserverOptions) => observer.observe(target, options),
    disconnect: () => { disposed = true; observer.disconnect(); cancelAnimationFrame(frame); pending.clear(); },
  };
}
