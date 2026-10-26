import type { Mission } from "./api";

export function queueWaitLabel(mission: Pick<Mission, "status" | "queue_wait" | "not_before"> | null | undefined): string | null {
  const wait = mission?.queue_wait;
  if (!["pending", "queued"].includes(mission?.status ?? "") || wait?.reason !== "waiting_for_slot") return null;
  if (new Date(mission?.not_before ?? "").getTime() > Date.now()) return null;
  return `Waiting for a free slot (${wait.slots_used}/${wait.slots_max} in use)`;
}
