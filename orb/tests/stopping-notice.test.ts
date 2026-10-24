import { expect, test } from "vitest";
import { applyStreamEvent, buildTranscript, type StreamItem } from "../src/transcriptModel";
import { heldAfterHistory, type StreamEvent } from "../src/stream";

// Mission 2220fd85 (2026-10-24): Stop at 06:18:04, the cancelled turn ended
// with its streamed text, then two more messages ran new turns.
const id = "2220fd85-fa01-4f07-a2cf-db0aceb2544c";
const cancel = `Parallel mission ${id} cancellation requested`;
const stored = (sequence: number, type: string, data: Record<string, unknown>, eventId?: string): StreamEvent =>
  ({ type, sequence, storedId: sequence, eventId, timestamp: "2026-10-24T06:18:04Z", data });
const history: StreamEvent[] = [
  stored(1924, "user_message", { id: "u1", content: "rethink the design" }, "u1"),
  stored(1936, "text_delta", { content: "That workspace is a large Rust campaign." }, "text_delta_checkpoint:1936"),
  stored(1939, "error", { message: cancel, resumable: true }),
  stored(1941, "assistant_message", { content: "That workspace is a large Rust campaign.", success: true }, "a1"),
  stored(1944, "mission_status_changed", { status: "interrupted" }),
  stored(1947, "user_message", { id: "u2", content: "rethink the design and rebuild this" }, "u2"),
  stored(1972, "tool_call", { tool_call_id: "t1", name: "Bash", args: {} }),
  stored(1974, "user_message", { id: "u3", content: "Keep the equivalent of maxwells in a private repo" }, "u3"),
];
const notices = (items: StreamItem[]) => items.filter((i): i is Extract<StreamItem, { kind: "error" }> => i.kind === "error");

test("a stop request is not rendered as a persistent error", () => {
  const items = buildTranscript(history);
  expect(notices(items)).toHaveLength(0);
});

test("the live copy of a stored Stop notice is not replayed after newer history", () => {
  // Live SSE errors carry no sequence or ID.
  const live: StreamEvent = { type: "error", timestamp: "2026-10-24T06:18:04Z", data: { message: cancel, resumable: true } };
  const held = heldAfterHistory(history, [live]);
  const items = held.reduce((state, event) => applyStreamEvent(state, event), buildTranscript(history));
  expect(notices(items)).toHaveLength(0);
  expect(items.at(-1)).toMatchObject({ kind: "user", messageId: "u3" });
});

test("a terminal cancelled result still shows one notice", () => {
  const items = buildTranscript([
    stored(1, "user_message", { id: "u1", content: "go" }, "u1"),
    stored(2, "tool_call", { tool_call_id: "t1", name: "Bash", args: {} }),
    stored(3, "error", { message: cancel }),
    stored(4, "assistant_message", { content: "Cancelled", success: false }, "a1"),
  ]);
  expect(notices(items)).toHaveLength(1);
  expect(notices(items)[0]).toMatchObject({ cancelled: true });
});

test("a cancellation request disappears when later work proves the run continued", () => {
  const items = buildTranscript([
    stored(1, "user_message", { id: "u1", content: "go" }, "u1"),
    stored(2, "error", { message: cancel }),
    stored(3, "tool_call", { tool_call_id: "t1", name: "Bash", args: {} }),
    stored(4, "tool_result", { tool_call_id: "t1", name: "Bash", result: "still running" }),
  ]);
  expect(notices(items)).toHaveLength(0);
  expect(items.some(item => item.kind === "tool")).toBe(true);
});
