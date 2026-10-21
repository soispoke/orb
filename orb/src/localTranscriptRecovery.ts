import {note} from './diagnostics';
import {nativeInvoke} from './clientRuns';
import {localTranscriptBoundaries,mergeRecoveredTranscriptBoundaries} from './localTranscriptStorage';
import {isLocalRunText} from './localTranscript';
import type {StreamItem} from './transcriptModel';

/** Older desktops saved cumulative output without the in-flight question cuts.
 * Native recovery is read-only and returns only identity-verified prefixes. */
export async function recoverLocalTranscript(mission: string, runId: string, canonical: StreamItem[]) {
  const invoke = nativeInvoke();
  if (!invoke) return;
  const at = canonical.findIndex(i => isLocalRunText(i, runId));
  if (at < 0) return;
  const snapshot = canonical[at];
  if (snapshot.kind !== 'text' || !snapshot.text) return;
  const known = new Set(localTranscriptBoundaries(mission).map(row => row.id));
  const questions = canonical.slice(at + 1).flatMap(i => i.kind === 'user' && i.messageId && !known.has(i.messageId) ? [{id:i.messageId,text:i.text}] : []);
  if (!questions.length) return;
  const cuts = await invoke('local_transcript_recover', {mission, full:snapshot.text, questions}) as {id:string;before:string}[];
  const verified = cuts.flatMap(cut => {
    const question = questions.find(q => q.id === cut.id);
    return question && typeof cut.before === 'string' && snapshot.text.startsWith(cut.before)
      ? [{...question,runId,before:cut.before,activityKeys:[],accepted:true}] : [];
  });
  await mergeRecoveredTranscriptBoundaries(mission, verified, canonical.flatMap(i => i.kind === 'user' && i.messageId ? [i.messageId] : []));
  if (verified.length) note('transcript-recovered', {mission, runId, messageIds:verified.map(row => row.id)});
}
