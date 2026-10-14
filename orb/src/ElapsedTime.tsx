import {createEffect, createSignal, onCleanup, Show} from "solid-js";
import "./elapsedTime.css";

export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}h ${minutes}m ${seconds % 60}s` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** Missing historical timestamps stay unknown; mounting a row never starts a clock. */
export function ElapsedTime(p: {startedAt?: number; finishedAt?: number; running: boolean}) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!p.running || p.startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const visible = () => p.startedAt !== undefined && Number.isFinite(p.startedAt) && (p.running || p.finishedAt !== undefined);
  return <Show when={visible()}><span class="elapsed-time" title="Elapsed time between recorded command events; live events use their arrival time when no server timestamp is available">{p.running ? "Working for " : "Ran for "}{elapsedLabel((p.finishedAt ?? now()) - p.startedAt!)}</span></Show>;
}
