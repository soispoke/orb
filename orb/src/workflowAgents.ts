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
    // A durable start receipt proves a launch, not that its process still exists.
    // Workflow journals have no heartbeat or runner identity; do not resurrect
    // historical children as Working after a disconnect or server restart.
    if (event.type === 'started' && !old) rows.set(id, {
      id, workflowAgentId: event.agentId, description: typeof event.label === 'string' ? event.label : 'Workflow agent',
      phase: typeof event.phase === 'string' ? event.phase : undefined, status: 'unknown',
      detail: 'A start was recorded. No live status or final result is available yet.',
      transcriptPath: /^[a-zA-Z0-9_-]+$/.test(event.agentId) ? journal.replace(/journal\.jsonl$/, `agent-${event.agentId}.jsonl`) : undefined,
    });
    // Terminal receipts are authoritative. A replayed start or contradictory
    // later receipt must not turn a finished child back into a working child.
    if (old && old.status === 'unknown' && event.type === 'result')
      rows.set(id, {...old, status: 'completed', detail: JSON.stringify(event.result, null, 2)});
    if (old && old.status === 'unknown' && event.type === 'failed')
      rows.set(id, {...old, status: 'failed', detail: 'The workflow recorded an agent failure.'});
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

/** Native saved workflows contain queued children absent from the launch journal. */
export function workflowStatePath(journal: string): string | undefined {
  const match = journal.match(/^(\/.*)\/subagents\/workflows\/([A-Za-z0-9_-]+)\/journal\.jsonl$/);
  return match && !journal.split('/').includes('..') ? `${match[1]}/workflows/${match[2]}.json` : undefined;
}

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bounded = (value: unknown, limit = 3000): string | undefined => typeof value === 'string' ? value.slice(0, limit) : undefined;
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const terminal = (status: string) => ['completed', 'finished', 'failed', 'stopped'].includes(status);

export function parseWorkflowState(content: string, journal: string): Subagent[] {
  const state = object(JSON.parse(content));
  const runId = journal.split('/').at(-2);
  if (state.runId !== runId || typeof state.taskId !== 'string' || !Array.isArray(state.workflowProgress)) throw new Error('Invalid workflow state');
  const ended = ['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled'].includes(String(state.status));
  const endedAt = Date.parse(typeof state.timestamp === 'string' ? state.timestamp : '');
  const rows = new Map<number, Subagent>();
  for (const value of state.workflowProgress) {
    const event = object(value), index = number(event.index);
    if (event.type !== 'workflow_agent' || index === undefined || !Number.isSafeInteger(index) || index < 1) continue;
    const agentId = bounded(event.agentId, 128);
    const startedAt = number(event.startedAt);
    const duration = number(event.durationMs);
    const status = event.state === 'done' ? 'completed' : event.state === 'error' ? 'failed' : ended ? 'stopped' : 'unknown';
    // A saved nonterminal snapshot is history, not a heartbeat. Live status is
    // supplied by task_progress; a restarted CLI must never revive old work.
    const detail = status === 'stopped' ? (startedAt === undefined ? 'The workflow stopped before this agent started.' : 'The workflow stopped before this agent finished.')
      : status === 'failed' ? bounded(event.error) || 'The agent failed.'
      : status === 'completed' ? bounded(event.resultPreview)
      : 'Current status is unconfirmed. Waiting for a live workflow update.';
    rows.set(index, {
      id: `workflow:${state.taskId}:${index}`, workflowTaskId: state.taskId, workflowIndex: index, workflowAgentId: agentId,
      description: bounded(event.label, 240) || `Workflow agent ${index}`, status, detail,
      phase: bounded(event.phaseTitle, 240), model: bounded(event.model, 160), tokens: number(event.tokens), startedAt,
      finishedAt: terminal(status) ? (startedAt !== undefined && duration !== undefined ? startedAt + duration : Number.isFinite(endedAt) ? endedAt : undefined) : undefined,
      transcriptPath: agentId && /^[a-zA-Z0-9_-]+$/.test(agentId) ? journal.replace(/journal\.jsonl$/, `agent-${agentId}.jsonl`) : undefined,
    });
  }
  return [...rows.values()];
}

/** Join live events, saved state, and legacy receipts without duplicate cards. */
export function mergeWorkflowAgents(live: Subagent[], saved: Subagent[]): Subagent[] {
  const key = (a: Subagent) => a.workflowTaskId && a.workflowIndex !== undefined ? `workflow:${a.workflowTaskId}:${a.workflowIndex}` : a.id;
  const receipts = new Map(saved.filter(a => a.workflowAgentId).map(a => [a.workflowAgentId!, a]));
  const labels = new Map(live.filter(a => a.workflowTaskId && a.workflowAgentId).map(a => [a.workflowTaskId!, receipts.get(a.workflowAgentId!)?.workflowLabel]));
  const rows = new Map<string, Subagent>(live.map(a => {
    const receipt = a.workflowAgentId ? receipts.get(a.workflowAgentId) : undefined;
    return [key(a), {...a, id:key(a), transcriptPath:a.transcriptPath ?? receipt?.transcriptPath, workflowLabel:a.workflowLabel ?? receipt?.workflowLabel ?? (a.workflowTaskId ? labels.get(a.workflowTaskId) : undefined)}];
  }));
  for (const agent of saved) {
    const id = key(agent), old = rows.get(id);
    // A newer native run takes precedence over a prior run's saved outcome.
    const useSaved = !old || (terminal(agent.status) && !((old.updatedAt ?? old.startedAt) !== undefined && agent.finishedAt !== undefined && (old.updatedAt ?? old.startedAt)! > agent.finishedAt));
    rows.set(id, useSaved ? {...old, ...agent, id} : {...agent, ...old, id});
  }
  const knownChildren = new Set([...rows.values()].filter(a => a.workflowTaskId && a.workflowAgentId).map(a => a.workflowAgentId));
  return [...rows.values()].filter(a => a.workflowTaskId || !a.workflowAgentId || !knownChildren.has(a.workflowAgentId));
}
