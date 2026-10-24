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

  it('does not repeat a long block the live stream resends after a mid-run message', () => {
    const optimizing = '**Optimizing recorder capacity**\n\n' + 'I am thinking about a separate high-level operation DAG for the recorder. '.repeat(4);
    const clarifying = '**Clarifying implementation tasks**\n\n' + 'I need to implement a tracing operation graph with macro and module tests. '.repeat(4);
    const items = thinks([
      ev('user_message', {id: 'go', content: 'go'}),
      ev('thinking', {content: optimizing, done: true}),
      ev('tool_call', {tool_call_id: 't1', name: 'Bash', args: {}}),
      ev('user_message', {id: 'emile', content: 'emile said: recursion needs batching'}),
      ev('thinking', {content: clarifying, done: true}),
      ev('tool_call', {tool_call_id: 't2', name: 'Bash', args: {}}),
      ev('thinking', {content: optimizing, done: true}),
      ev('thinking', {content: clarifying, done: true}),
    ]);
    expect(items.map(item => item.text)).toEqual([optimizing, clarifying]);
  });
});

it('finalizes the matching earlier block without overwriting a newer live thought', () => {
  const items = thinks([
    ev('thinking', {content: 'First thought', done: false}),
    ev('tool_call', {tool_call_id: 'first', name: 'Bash'}),
    ev('thinking', {content: 'Second thought', done: false}),
    ev('thinking', {content: 'First thought complete.', done: true}),
    ev('thinking', {content: 'Second thought complete.', done: true}),
  ]);
  expect(items.map(item => ({text: item.text, done: item.done}))).toEqual([
    {text: 'First thought complete.', done: true},
    {text: 'Second thought complete.', done: true},
  ]);
});
