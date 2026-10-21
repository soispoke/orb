import {describe, expect, it} from 'vitest';
import {buildTranscript} from '../src/transcriptModel';
import type {StreamEvent} from '../src/stream';

const ev = (type: string, data: Record<string, unknown>): StreamEvent => ({type, data, timestamp: '2026-10-21T07:00:00Z'} as StreamEvent);
const thinks = (events: StreamEvent[]) => buildTranscript(events).filter(item => item.kind === 'think');
const answer = 'About 3.5 hours remain, mostly proof runtime.';

describe('thinking blocks', () => {
  it('finalizes a streamed block whose final copy arrives after the next tool call', () => {
    const items = thinks([
      ev('user_message', {id: 'eta', content: 'eta'}),
      ev('thinking', {content: 'About 3.5 hours', done: false}),
      ev('thinking', {content: answer, done: false}),
      ev('tool_call', {tool_call_id: 't1', name: 'Bash', args: {}}),
      ev('thinking', {content: answer, done: true}),
      ev('tool_result', {tool_call_id: 't1', name: 'Bash', result: 'ok'}),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({text: answer, done: true});
  });

  it('never repeats a finished block within a turn, but keeps distinct blocks and later turns', () => {
    const later = 'The 4x4 tree is proved.';
    const items = thinks([
      ev('user_message', {id: 'eta', content: 'eta'}),
      ev('thinking', {content: answer, done: true}),
      ev('tool_call', {tool_call_id: 't1', name: 'Bash', args: {}}),
      ev('thinking', {content: later, done: true}),
      ev('thinking', {content: answer, done: true}),
      ev('thinking', {content: later, done: true}),
      ev('user_message', {id: 'eta2', content: 'eta'}),
      ev('thinking', {content: answer, done: true}),
    ]);
    expect(items.map(item => item.text)).toEqual([answer, later, answer]);
  });
});
