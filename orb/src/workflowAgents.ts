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
    });
    if (event.type === 'result' && old) rows.set(id, {...old, status: 'completed', detail: JSON.stringify(event.result, null, 2)});
    // Other journal types are deliberately not guessed to mean success.
  }
  return [...rows.values()];
}
