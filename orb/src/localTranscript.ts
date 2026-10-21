import type {StreamItem} from './transcriptModel';

/** Local finals use the execution ID as their durable event ID. Rendering keys
 * can change independently; never infer ownership by comparing response prose.
 * The key fallback supports older cached projections. */
export function isLocalRunText(item: StreamItem, runId: string): item is Extract<StreamItem, {kind:'text'}> {
  return item.kind === 'text' && (item.sourceEventId === runId || item.key.startsWith(`text:${runId}:`) || item.key === `local:${runId}`);
}

/** A steering boundary is captured before delivery, never inferred from prose.
 * The run identity keeps identical answers in other turns entirely independent. */
export interface LocalTranscriptBoundary {
  id: string;
  runId: string;
  text: string;
  before: string;
  activityKeys: string[];
  accepted: boolean;
}

export function projectLocalTranscript(
  canonical: StreamItem[],
  boundaries: LocalTranscriptBoundary[],
  current: {runId?: string; text: string; active: boolean; activities: StreamItem[]},
): StreamItem[] {
  let items = [...canonical];
  const groups = new Map<string, LocalTranscriptBoundary[]>();
  for (const boundary of boundaries) {
    // A confirmed history echo also settles delivery after a lost acknowledgement.
    if (!boundary.accepted && !items.some(i => i.kind === 'user' && i.messageId === boundary.id)) continue;
    const group = groups.get(boundary.runId) ?? [];
    group.push(boundary); groups.set(boundary.runId, group);
  }
  if (current.runId && !groups.has(current.runId)) groups.set(current.runId, []);
  for (const [runId, cuts] of groups) {
    const isCurrent = runId === current.runId;
    const ownsText = (item: StreamItem) => isLocalRunText(item, runId);
    const snapshots = items.filter(ownsText) as Extract<StreamItem, {kind:'text'}>[];
    let full = snapshots.at(-1)?.text ?? '';
    // A stale history fetch must not shorten output already painted by native.
    if (isCurrent && current.text && !full.startsWith(current.text)) full = current.text;
    if (!full && cuts.length) full = cuts.at(-1)!.before;
    const ids = new Set(cuts.map(c => c.id));
    const activities = isCurrent ? current.activities : [];
    const activityKeys = new Set(activities.map(i => i.key));
    const owned = (item: StreamItem) => ownsText(item) || item.kind === 'user' && !!item.messageId && ids.has(item.messageId) || activityKeys.has(item.key);
    let insertion = items.findIndex(owned);
    if (insertion < 0) insertion = items.length;
    const output: StreamItem[] = [];
    let offset = 0;
    const remainingActivities = new Map(activities.map(i => [i.key, i]));
    const addActivities = (keys: Iterable<string>) => {
      for (const key of keys) {
        const item = remainingActivities.get(key);
        if (item) { output.push(item); remainingActivities.delete(key); }
      }
    };
    const addText = (end: number, key: string, live: boolean) => {
      const text = full.slice(offset, end);
      if (text.trim()) output.push({kind:'text', key, text, live});
      offset = end;
    };
    for (const cut of cuts) {
      // Rewrites can invalidate a snapshot prefix. Split only the common prefix;
      // never discard corrected bytes or duplicate the old version of a reply.
      let end = 0;
      while (end < full.length && end < cut.before.length && full[end] === cut.before[end]) end++;
      if (end > 0 && /[\uD800-\uDBFF]/.test(full[end - 1]) && /[\uDC00-\uDFFF]/.test(full[end] ?? '')) end--;
      end = Math.max(offset, end);
      addActivities(cut.activityKeys);
      addText(end, `local:${runId}:before:${cut.id}`, false);
      const user = items.find(i => i.kind === 'user' && i.messageId === cut.id);
      output.push(user ?? {kind:'user', key:`user:${cut.id}`, messageId:cut.id, text:cut.text});
    }
    addActivities(remainingActivities.keys());
    addText(full.length, `local:${runId}`, isCurrent && current.active);
    items = [...items.slice(0, insertion).filter(i => !owned(i)), ...output, ...items.slice(insertion).filter(i => !owned(i))];
  }
  return items;
}

/** Keep observed output through a run transition until its durable row catches up.
 * The cache is view-local and keyed by execution identity, never prose matching.
 * It releases each old snapshot as soon as history includes that revision. */
export function createLocalTranscriptProjection() {
  const observed = new Map<string,{text:string;afterKey?:string}>();
  return (canonical:StreamItem[], boundaries:LocalTranscriptBoundary[], current:Parameters<typeof projectLocalTranscript>[2]) => {
    if (current.runId && current.text) {
      const afterKey=observed.get(current.runId)?.afterKey ?? [...canonical].reverse().find(item=>item.kind==='user'&&!item.queued)?.key;
      observed.set(current.runId,{text:current.text,afterKey});
    }
    let history = canonical;
    for (const [runId,{text,afterKey}] of observed) {
      if (runId === current.runId && current.text) continue;
      const owns = (item:StreamItem) => isLocalRunText(item, runId);
      const stored = history.find(owns);
      if (stored?.kind==='text' && stored.text.startsWith(text)) { observed.delete(runId); continue; }
      if (stored) history=history.map(item=>item.kind==='text'&&owns(item)?{...item,text}:item);
      else {
        // No stored row yet: insert at the first delivered cut for this run.
        const ids=new Set(boundaries.filter(cut=>cut.runId===runId).map(cut=>cut.id));
        let at=history.findIndex(item=>item.kind==='user' && !!item.messageId && ids.has(item.messageId));
        if(at<0 && afterKey) {const anchor=history.findIndex(item=>item.key===afterKey);if(anchor>=0)at=anchor+1;}
        const row:StreamItem={kind:'text',key:`local:${runId}`,text,live:false};
        history=at<0?[...history,row]:[...history.slice(0,at),row,...history.slice(at)];
      }
    }
    return projectLocalTranscript(history,boundaries,current);
  };
}
