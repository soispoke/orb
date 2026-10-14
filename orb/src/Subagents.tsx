import {For, Show, createMemo, createSignal} from 'solid-js';
import {anchoredDisclosure} from './anchoredDisclosure';
import type {StreamItem} from './transcriptModel';
import type {LocalActivity} from './localAgents';
import './subagents.css';

export interface Subagent {
  id: string;
  tool_call_id?: string | null;
  description: string;
  status: string;
  detail?: string | null;
  prompt?: string;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => text(record(v).text ?? v)).join('\n');
  return value == null ? '' : JSON.stringify(value, null, 2);
};
const label = (value: unknown) => typeof value === 'string' ? value : '';

/** Native task status overrides the launch tool's result. Starting an async
 * agent is a successful tool call, not a completed agent. Stable call identities
 * also preserve expanded rows when the first lifecycle notification arrives. */
export function collectSubagents(items: StreamItem[], local: LocalActivity[] = []): Subagent[] {
  const rows = new Map<string, Subagent>();
  for (const item of items) {
    if (item.kind !== 'tool' || !['agent', 'task', 'delegate_task'].includes(item.name.toLowerCase())) continue;
    const args = record(item.args), result = record(item.result);
    const background = args.run_in_background === true;
    rows.set(item.callId, {
      id: item.callId, description: label(args.description) || label(args.subagent_type) || 'Subagent',
      prompt: label(args.prompt),
      status: item.unresolved ? 'unknown' : result.is_error === true ? 'failed' : background ? (item.done ? 'unknown' : 'running') : item.done ? 'completed' : 'running',
      detail: item.done && !background ? text(item.result) : undefined,
    });
  }
  for (const item of items) {
    if (item.kind !== 'subagent') continue;
    const agent = item.agent, key = agent.tool_call_id || agent.id, old = rows.get(key);
    rows.set(key, {...old, ...agent, id: key, description: agent.description === 'Subagent' && old ? old.description : agent.description});
  }
  const spawned = new Set(local.filter(a => a.background && a.kind === 'agent').map(a => a.tool_use_id));
  for (const activity of local) {
    if (activity.kind !== 'agent' || (!activity.background && spawned.has(activity.id))) continue;
    const key = activity.tool_use_id || activity.id, old = rows.get(key);
    rows.set(key, { ...old, id: key, description: activity.label,
      status: activity.status === 'stopped' ? 'stopped' : activity.failed ? 'failed' : activity.done ? (activity.status === 'finished' ? 'finished' : 'completed') : 'running',
      detail: activity.detail,
    });
  }
  return [...rows.values()];
}
const states: Record<string,string> = {running:'Working', completed:'Done', finished:'Finished', failed:'Failed', stopped:'Stopped', waiting:'Waiting', unknown:'Status unavailable'};

export function Subagents(p: {items: StreamItem[]; local?: LocalActivity[]; interrupted?: boolean}) {
  const agents = createMemo(() => collectSubagents(p.items, p.local));
  const [expanded, setExpanded] = createSignal(true);
  const [showAll, setShowAll] = createSignal(false);
  const anchored = anchoredDisclosure();
  let toggle!: HTMLButtonElement;
  const status = (agent: Subagent) => p.interrupted && agent.status === 'running' ? 'unknown' : agent.status;
  const working = () => agents().filter(a => status(a) === 'running').length;
  const failed = () => agents().filter(a => status(a) === 'failed').length;
  // Iterate IDs, not fresh event objects: an update never remounts an open row.
  const revealed = createMemo<Set<string>>(previous => {
    const ids = new Set(previous);
    for (const agent of agents()) if (["running", "waiting", "failed"].includes(status(agent))) ids.add(agent.id);
    return ids;
  }, new Set());
  const visible = () => agents().filter((agent, index) => showAll() || index < 6 || revealed().has(agent.id)).map(a => a.id);
  return <Show when={agents().length}><section class="subagents" aria-label="Subagents">
    <button class="subagents-heading" ref={toggle} aria-expanded={expanded()} onClick={() => anchored(toggle, () => setExpanded(v => !v))}>
      <span class="subagents-chevron" data-open={expanded()} aria-hidden="true">›</span>
      <span>Subagents</span><span class="subagents-count">{agents().length}</span>
      <span class="subagents-summary">{working() ? `${working()} working` : 'Activity'}{failed() ? ` · ${failed()} failed` : ''}</span>
    </button>
    <div hidden={!expanded()} class="subagents-list">
      <For each={visible()}>{id => {
        const agent = () => agents().find(a => a.id === id)!;
        const [open, setOpen] = createSignal(false);
        let row!: HTMLButtonElement;
        return <div class="subagent" data-state={status(agent())}>
          <button ref={row} class="subagent-toggle" aria-expanded={open()} onClick={() => anchored(row, () => setOpen(v => !v))}>
            <span class="subagent-dot" aria-hidden="true"/>
            <span class="subagent-description" title={agent().description}>{agent().description}</span>
            <span class="subagent-status">{states[status(agent())] ?? 'Status unavailable'}</span>
            <span class="subagents-chevron" data-open={open()} aria-hidden="true">›</span>
          </button>
          <div hidden={!open()} class="subagent-details">
            <Show when={agent().prompt}><div class="subagent-detail-label">Task</div><pre>{agent().prompt}</pre></Show>
            <div class="subagent-detail-label">{status(agent()) === 'running' ? 'Latest activity' : 'Result'}</div>
            <pre>{agent().detail || (status(agent()) === 'running' ? 'Waiting for the next update…' : 'No additional result was reported.')}</pre>
          </div>
        </div>;
      }}</For>
      <Show when={showAll() || visible().length < agents().length}><button class="subagents-more" onClick={e => anchored(e.currentTarget, () => setShowAll(v => !v))}>{showAll() ? 'Show fewer' : `Show all ${agents().length} agents`}</button></Show>
    </div>
  </section></Show>;
}
