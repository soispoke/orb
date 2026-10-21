import type {StreamEvent} from './stream';

/** Legacy Core's synthetic text_op bubble guesses overlaps between snapshots.
 * Treat it as an invalidation, not text. Read the producer's durable snapshot
 * verbatim; native, independently identified text_op bubbles do not use this.
 * One request at a time, with a trailing read for the asynchronous logger. */
export function snapshotTextReader(
  read: () => Promise<StreamEvent | undefined>,
  emit: (event: StreamEvent) => void,
  recover: () => void,
) {
  let stopped = false, pending = false, revision = -1, epoch = 0;
  let dirty = false, retries = 0;
  let lastStarted = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number) => {
    if (stopped || pending || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void refresh(); }, Math.max(delay, 200 - (Date.now() - lastStarted)));
  };
  const refresh = async () => {
    if (stopped || pending) return;
    pending = true;
    lastStarted = Date.now();
    dirty = false;
    const generation = epoch;
    let advanced = false;
    try {
      const event = await read();
      if (stopped || generation !== epoch) return;
      if (event?.sequence !== undefined && event.sequence > revision) {
        revision = event.sequence;
        advanced = true;
        emit(event);
      }
    } catch {
      if (!stopped && generation === epoch) recover();
    } finally {
      pending = false;
      if (!stopped && generation === epoch) {
        // At least one trailing read: a newer token may not yet be logged.
        if (dirty || advanced) retries = 0;
        if (dirty || advanced || retries < 4) schedule(250 * 2 ** retries++);
      } else if (!stopped && dirty) schedule(0);
    }
  };
  return {
    invalidate() {
      dirty = true;
      retries = 0;
      // Fresh output should not wait behind a quiet-stream retry backoff.
      clearTimeout(timer); timer = undefined;
      schedule(0);
    },
    finalize() { epoch++; dirty = false; clearTimeout(timer); timer = undefined; },
    dispose() { stopped = true; epoch++; clearTimeout(timer); },
  };
}
