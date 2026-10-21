import type {StreamItem} from './transcriptModel';

/** Queue receipts can be appended after output during replay. Only a delivered
 * user event establishes a new turn boundary. */
export function hasTurnActivity(items: StreamItem[]): boolean {
  const lastUser = items.reduce((last, item, index) =>
    item.kind === 'user' && !item.queued && !item.receipt ? index : last, -1);
  return items.slice(lastUser + 1).some(item => item.kind === 'tool' ||
    ((item.kind === 'text' || item.kind === 'think') && !!item.text.trim()));
}
