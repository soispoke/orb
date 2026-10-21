import type {LocalActivity} from './localAgents';

/** Claude replays this recovery notice on resume; it does not prove a worker failed. */
export function sessionEndAgent(summary: unknown): string | undefined {
  if (typeof summary !== 'string') return;
  return /^Background agent "([^\n]+)" didn't finish before the previous session ended$/.exec(summary)?.[1];
}
export const UNCONFIRMED_AGENT = "Session ended before this agent's outcome was confirmed. It may still be running.";

/** Also repair presentation of activities saved by older desktop versions. */
export function reconcileAgentActivity(activity: LocalActivity): LocalActivity {
  const name = activity.background && activity.failed ? sessionEndAgent(activity.detail) : undefined;
  return name ? {...activity, label: activity.label === 'Background task' ? name : activity.label,
    kind: 'agent', failed: false, done: false, status: 'unknown', finished_at: undefined,
    detail: UNCONFIRMED_AGENT} : activity;
}
export function sessionEndTool(name: string, result: unknown): string | undefined {
  if (name !== 'Background task' || !result || typeof result !== 'object') return;
  const data = result as Record<string, unknown>;
  return data.status === 'failed' ? sessionEndAgent(data.error) : undefined;
}
