/** Deliver each new follow-up once, after its durable admission. The caller
 * owns receipts and errors; an uncertain attempt is never replayed here. */
export function queuedSteering(send: (id: string) => Promise<unknown>) {
  const submissions = new Map<string, boolean>();
  let delivery: Promise<unknown> = Promise.resolve();
  let generation = 0;
  return {
    submitted(id: string) {
      if (!submissions.has(id)) submissions.set(id, false);
    },
    admitted(id: string, queued: boolean) {
      if (!submissions.has(id) || submissions.get(id)) return;
      submissions.set(id, true);
      const admittedGeneration = generation;
      if (queued) delivery = delivery.then(() => {
        // Navigation can happen between admission and delivery.
        if (generation === admittedGeneration && submissions.has(id)) return send(id);
      }).catch(() => {});
    },
    clear() { generation++; submissions.clear(); },
  };
}
