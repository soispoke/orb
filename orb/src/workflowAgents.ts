import type {StreamItem} from './transcriptModel';
import type {Subagent} from './Subagents';

export function workflowJournals(items: StreamItem[]): string[] {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'tool' || item.name.toLowerCase() !== 'workflow' || !item.done) continue;
    const content = typeof item.result === 'string' ? item.result : JSON.stringify(item.result);
    // Only consume a structured launch receipt, never execute the Workflow script.
    const match = content?.match(/Transcript dir: ([^\s"\\]+)/);
    const path = match?.[1];
    if (path?.startsWith('/') && path.includes('/subagents/workflows/') && !path.split('/').includes('..')) paths.add(path + '/journal.jsonl');
  }
  return [...paths].slice(-20);
}

export function parseWorkflowJournal(content: string, journal: string): Subagent[] {
  const rows = new Map<string, Subagent>();
  for (const line of content.split('\n')) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line); } catch { continue; } // A live writer may leave a partial final line.
    if (!event || typeof event.agentId !== 'string') continue;
    const id = `${journal}:${event.agentId}`;
    const old = rows.get(id);
    if (event.type === 'started' && !old) rows.set(id, {
      id, description: typeof event.label === 'string' ? event.label : 'Workflow agent',
      phase: typeof event.phase === 'string' ? event.phase : undefined, status: 'running',
      transcriptPath: /^[a-zA-Z0-9_-]+$/.test(event.agentId) ? journal.replace(/journal\.jsonl$/, `agent-${event.agentId}.jsonl`) : undefined,
    });
    if (event.type === 'result' && old) rows.set(id, {...old, status: 'completed', detail: JSON.stringify(event.result, null, 2)});
    // Other journal types are deliberately not guessed to mean success.
  }
  return [...rows.values()];
}

/** Read visible activity only, never encrypted/internal thinking blocks. */
export function parseWorkflowTranscript(content: string) {
  let detail = '', model: string | undefined, startedAt: number | undefined, updatedAt: number | undefined;
  for (const line of content.split('\n')) {
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    const time = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
    if (Number.isFinite(time)) { startedAt = startedAt === undefined ? time : Math.min(startedAt, time); updatedAt = Math.max(updatedAt ?? time, time); }
    if (typeof event.message?.model === 'string') model = event.message.model;
    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) detail = block.text.slice(-3000);
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const description = block.input?.description ?? block.input?.command ?? block.input?.file_path;
        detail = `${block.name}${typeof description === 'string' ? ': ' + description.slice(0, 2000) : ''}`;
      }
    }
  }
  return {detail, model, startedAt, updatedAt};
}
