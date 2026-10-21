import {appendClientTranscript, connectionVersion} from './api';
import type {ClientRunReceipt} from './clientRuns';
import {followLocal, type PollLocal} from './localAgents';

/** Mirror a live reply while the native session waits for background work.
 * Writes are serialized so a slow older prefix cannot replace a newer reply.
 * The caller still owns the final transcript/status write and its durable retry. */
export function liveReplyMirror(write: (text: string) => Promise<void>, delay = 1000) {
  let latest = '', saved = '', closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const schedule = () => {
    if (!closed && !timer && !pending && latest.trim() && latest !== saved)
      timer = setTimeout(drain, delay);
  };
  const drain = () => {
    timer = undefined;
    if (closed || pending || !latest.trim() || latest === saved) return;
    const text = latest;
    pending = Promise.resolve().then(() => write(text)).then(() => { saved = text; }).catch(() => {
      // A temporary failure leaves the latest prefix available for retry.
    }).finally(() => { pending = undefined; schedule(); });
  };
  return {
    update(text: string) { if (!closed) { latest = text; schedule(); } },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await pending;
    },
  };
}

export async function followLocalReply(id: string, receipt?: ClientRunReceipt): Promise<PollLocal> {
  // Legacy recovered queue rows may lack ownership; only their final durable save may resolve it.
  if (!receipt) return followLocal(id, () => {});
  const version = connectionVersion();
  const eventId = crypto.randomUUID();
  const mirror = liveReplyMirror(text => version === connectionVersion()
    ? appendClientTranscript(id, 'assistant', text, eventId, receipt) : Promise.resolve());
  try { return await followLocal(id, text => mirror.update(text)); }
  finally { await mirror.close(); }
}
