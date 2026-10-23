import { expect, test } from "vitest";
import { applyStreamEvent, buildTranscript, type StreamItem } from "../src/transcriptModel";
import type { StreamEvent } from "../src/stream";

// Core keeps one mutable `text_delta_latest` row per response. Claude's runner
// fills it with the text of the *current* assistant message only, so after a
// tool call the next message's text arrives as a snapshot that does not extend
// the paragraph already on screen (mission df112123, recursion.fast).
// Stored rows as the snapshot reader and history replay deliver them (storedToStream).
type Row = { event_id?: string; tool_call_id?: string; tool_name?: string };
const row = (sequence: number, type: string, content: string, extra: Row = {}): StreamEvent => ({
  type, sequence, storedId: sequence, eventId: extra.event_id, timestamp: "2026-10-23T10:00:00Z",
  data: type === "user_message" ? { id: extra.event_id, content }
    : type === "tool_call" ? { tool_call_id: extra.tool_call_id, name: extra.tool_name, args: {} }
    : type === "tool_result" ? { tool_call_id: extra.tool_call_id, name: extra.tool_name, result: content }
    : type === "assistant_message" ? { content, success: true }
    : { content },
});
const live = (items: StreamItem[], event: StreamEvent) => applyStreamEvent(items, event);
const texts = (items: StreamItem[]) => items.filter(i => i.kind === "text").map(i => (i as Extract<StreamItem, { kind: "text" }>).text);

const first = "I'll check both lanes before steering them.";
const second = "Lane A is green; lane B is still benchmarking.";

test("a new Claude message's text does not replace the paragraph already shown", () => {
  let items = buildTranscript([row(1, "user_message", "status?", { event_id: "u1" })]);
  items = live(items, row(2, "text_delta", "I'll check", { event_id: "text_delta_latest" }));
  items = live(items, row(3, "text_delta", first, { event_id: "text_delta_latest" }));
  items = live(items, row(4, "tool_call", "{}", { tool_call_id: "t1", tool_name: "Bash" }));
  items = live(items, row(5, "tool_result", "ok", { tool_call_id: "t1", tool_name: "Bash" }));
  items = live(items, row(6, "text_delta", "Lane A", { event_id: "text_delta_latest" }));
  expect(texts(items)).toEqual([first, "Lane A"]);
  items = live(items, row(7, "text_delta", second, { event_id: "text_delta_latest" }));
  expect(texts(items)).toEqual([first, second]);
  // The new paragraph reads after the work that preceded it.
  expect(items.map(i => i.kind)).toEqual(["user", "text", "tool", "text"]);
  // Claude's final result is the last message only.
  items = live(items, row(8, "assistant_message", second, { event_id: "final" }));
  expect(texts(items)).toEqual([first, second]);
  expect(items.filter(i => i.kind === "text").every(i => i.kind === "text" && !i.live)).toBe(true);
});

test("the final message keeps an earlier paragraph the snapshot reader saw last", () => {
  // The reader coalesces: it may never see the last message's streamed text.
  let items = buildTranscript([row(1, "user_message", "status?", { event_id: "u1" })]);
  items = live(items, row(2, "text_delta", first, { event_id: "text_delta_latest" }));
  items = live(items, row(3, "tool_call", "{}", { tool_call_id: "t1", tool_name: "Bash" }));
  items = live(items, row(4, "assistant_message", second, { event_id: "final" }));
  expect(texts(items)).toEqual([first, second]);
});

test("a message that starts like the previous one never shrinks it", () => {
  let items = buildTranscript([row(1, "user_message", "status?", { event_id: "u1" })]);
  items = live(items, row(2, "text_delta", "I'll check lane A.", { event_id: "text_delta_latest" }));
  items = live(items, row(3, "tool_call", "{}", { tool_call_id: "t1", tool_name: "Bash" }));
  items = live(items, row(4, "text_delta", "I'll", { event_id: "text_delta_latest" }));
  expect(texts(items)).toEqual(["I'll check lane A."]);
  items = live(items, row(5, "text_delta", "I'll steer lane B.", { event_id: "text_delta_latest" }));
  expect(texts(items)).toEqual(["I'll check lane A.", "I'll steer lane B."]);
});

test("a growing snapshot and its matching final stay one paragraph", () => {
  let items = buildTranscript([row(1, "user_message", "status?", { event_id: "u1" })]);
  items = live(items, row(2, "text_delta", "Lane A", { event_id: "text_delta_latest" }));
  items = live(items, row(3, "text_delta", second, { event_id: "text_delta_latest" }));
  items = live(items, row(4, "assistant_message", `${second}\n`, { event_id: "final" }));
  expect(texts(items)).toEqual([`${second}\n`]);
});

test("each message of one response keeps its own display key", () => {
  let items = buildTranscript([row(1, "user_message", "status?", { event_id: "u1" })]);
  items = live(items, row(2, "text_delta", first, { event_id: "text_delta_latest" }));
  items = live(items, row(3, "tool_call", "{}", { tool_call_id: "t1", tool_name: "Bash" }));
  items = live(items, row(4, "text_delta", second, { event_id: "text_delta_latest" }));
  items = live(items, row(5, "tool_call", "{}", { tool_call_id: "t2", tool_name: "Bash" }));
  items = live(items, row(6, "assistant_message", "All done.", { event_id: "final" }));
  expect(texts(items)).toEqual([first, second, "All done."]);
  expect(new Set(items.map(i => i.key)).size).toBe(items.length);
});
