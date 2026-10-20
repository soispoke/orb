import {createEffect,createSignal,onCleanup} from "solid-js";
import { connectionVersion, sendQueuedMessageNow } from "./api";
import { LiveInputUnavailable } from "./liveInputAvailability";

export type LiveDelivery = "sending" | "accepted" | "queued" | "unavailable" | "unconfirmed";
export const liveDeliveryLabel = (state: LiveDelivery) => ({
  sending: "Sending to the running session… Work continues.",
  accepted: "Sent to the running session. The agent reads it after its current step; work continues.",
  queued: "Queued for the next turn. Work continues.",
  unavailable: new LiveInputUnavailable().message,
  unconfirmed: "Message saved; live delivery is unconfirmed. It won’t be resent automatically.",
})[state];

/** Use the durable message identity. Never stop, fork, delete or replay a turn
 * to obtain an answer. Accepted means the session inbox accepted the message,
 * not that the model has read it or already answered. */
export function createMidrunDelivery(valid: () => boolean) {
  const version = connectionVersion();
  const attempts = new Map<string, Promise<LiveDelivery>>();
  let tail: Promise<unknown> = Promise.resolve();
  return (id: string): Promise<LiveDelivery> => {
    const existing = attempts.get(id);
    if (existing) return existing;
    const attempt = tail.then(async (): Promise<LiveDelivery> => {
      if (!valid() || connectionVersion() !== version) return "unconfirmed";
      try {
        const accepted = await sendQueuedMessageNow(id);
        // A receipt from the old connection cannot update a newly opened
        // conversation, even when its queue ID happens to match.
        if (!valid() || connectionVersion() !== version) return "unconfirmed";
        return accepted ? "accepted" : "queued";
      } catch {
        // A concurrent consumer may already own this ID. Absence does not
        // prove delivery, and cannot authorize replay with a fresh identity.
        return "unconfirmed";
      }
    });
    attempts.set(id, attempt);
    tail = attempt;
    return attempt;
  };
}


/** Pending/uncertain messages remain visible until resolved. An accepted receipt
 * stays until `isSettled` (the agent answered or the turn ended), else briefly. */
export function createLiveDeliveryNotice(isDelivered: (id: string) => boolean = () => false, isSettled?: (id: string) => boolean){
  const [notice,setNotice]=createSignal<{id:string;state:LiveDelivery}>();
  createEffect(()=>{
    const current=notice();
    // The queue may deliver after the immediate steer was refused, or before
    // its HTTP response arrives. A canonical receipt supersedes that stale
    // transport result; an empty queue alone is not proof of delivery.
    if(current && current.state!=="accepted" && isDelivered(current.id)) {
      setNotice({...current,state:"accepted"});
      return;
    }
    if(current?.state!=="accepted")return;
    if(isSettled){if(isSettled(current.id))setNotice(undefined);return;}
    const timer=setTimeout(()=>setNotice(previous=>previous===current?undefined:previous),6000);
    onCleanup(()=>clearTimeout(timer));
  });
  return [notice,setNotice] as const;
}
