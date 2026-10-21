import {createSignal} from 'solid-js';
import {readSideThread, saveSideThread} from './composerDrafts';
import {sideQuestionKey} from './sideQuestionStorage';
import type {LocalTranscriptBoundary} from './localTranscript';

const [records, setRecords] = createSignal<Record<string, LocalTranscriptBoundary[]>>({});
const keyFor = (mission: string) => `local-transcript:v1:${sideQuestionKey(mission)}`;
export const localTranscriptBoundaries = (mission: string) => records()[keyFor(mission)] ?? [];
export async function loadLocalTranscriptBoundaries(mission: string) {
  const key = keyFor(mission);
  await navigator.locks.request(key, async () => {
    const rows = await readSideThread<LocalTranscriptBoundary[]>(key) ?? [];
    setRecords(previous => ({...previous, [key]: rows}));
  });
}
/** Persist before stdin, so an uncertain acknowledgement cannot lose ordering. */
export async function saveLocalTranscriptBoundary(mission: string, boundary: LocalTranscriptBoundary) {
  const key = keyFor(mission);
  await navigator.locks.request(key, async () => {
    const rows = await readSideThread<LocalTranscriptBoundary[]>(key) ?? [];
    const index = rows.findIndex(row => row.id === boundary.id);
    if (index < 0) rows.push(boundary); else rows[index] = boundary;
    await saveSideThread(key, rows);
    setRecords(previous => ({...previous, [key]: rows}));
  });
}

/** Import only missing identities: a concurrent live delivery always wins. */
export async function mergeRecoveredTranscriptBoundaries(mission: string, recovered: LocalTranscriptBoundary[], questionOrder: string[]) {
  if (!recovered.length) return;
  const key = keyFor(mission);
  await navigator.locks.request(key, async () => {
    const rows = await readSideThread<LocalTranscriptBoundary[]>(key) ?? [];
    const ids = new Set(rows.map(row => row.id));
    for (const row of recovered) if (!ids.has(row.id)) { rows.push(row); ids.add(row.id); }
    // Recovery may precede cuts recorded by this desktop. Group by run, then
    // order exact cumulative prefixes; stable ties retain delivery order.
    const runs = [...new Set(rows.map(row => row.runId))];
    const rank = (id:string) => { const index=questionOrder.indexOf(id); return index<0 ? Number.MAX_SAFE_INTEGER : index; };
    const ordered = runs.flatMap(run => rows.filter(row => row.runId === run).sort((a,b) => a.before.length - b.before.length || rank(a.id) - rank(b.id)));
    await saveSideThread(key, ordered);
    setRecords(previous => ({...previous, [key]: ordered}));
  });
}
