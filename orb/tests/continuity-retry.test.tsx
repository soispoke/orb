import { expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { Transcript } from "../src/Transcript";
import { applyStreamEvent, buildTranscript, visibleTranscript } from "../src/transcriptModel";
import { storedToStream, type StreamEvent } from "../src/stream";

const prompt = "Resume the verification work. Preserve all ongoing audits and builds.";
const retry = prompt + "\n\nContinuity reconciliation: recovered the missing receipts; no commands were replayed.";
const failure = "Codex native continuity: Codex execution failed: codex_continuity_unresolved_tools: previous tool outcome needs reconciliation; no command was replayed";
const user = (id: string, content = prompt, extra = {}): StreamEvent => ({
  type: "user_message", data: { id, content, source: "host-queue:api:default", ...extra },
});
const failed: StreamEvent = {type: "assistant_message", data: {success: false, content: failure}};
const history = [user("first"), failed, user("retry", retry)];

it("collapses only the repeated recovery attempt and keeps both original records intact", () => {
  const items = buildTranscript(history);
  const before = JSON.stringify(items);
  const shown = visibleTranscript(items);
  expect(shown).toMatchObject([
    {kind: "user", text: prompt},
    {kind: "user", text: retry, continuityRetry: true},
  ]);
  expect(JSON.stringify(items)).toBe(before);
  expect(visibleTranscript(items)[1]).toBe(shown[1]);
  const {container} = render(() => <Transcript items={items}/>);
  expect(container.querySelectorAll(".user")).toHaveLength(1);
  expect(container.querySelector(".user")?.textContent).toBe(prompt);
  expect(container.querySelector("summary")?.textContent).toBe("Retried after interruption");
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector(".background-wake-body")?.textContent).toBe(retry);
});

it("matches persisted history and live delivery, including queued-to-delivered recovery", () => {
  const saved = history.map((event, i) => storedToStream({
    id: i, sequence: i, event_id: String(event.data.id ?? "failure"),
    event_type: event.type, content: String(event.data.content), timestamp: "", metadata: event.data,
  })!);
  const replay = visibleTranscript(buildTranscript(saved));
  let items = buildTranscript([user("first"), failed]);
  items = applyStreamEvent(items, user("retry", retry, {queued: true}));
  expect(visibleTranscript(items).some(item => item.kind === "user" && item.continuityRetry)).toBe(false);
  items = applyStreamEvent(items, user("retry", retry));
  expect(visibleTranscript(items).map(item => [item.kind, item.text, item.kind === "user" && item.continuityRetry]))
    .toEqual(replay.map(item => [item.kind, item.text, item.kind === "user" && item.continuityRetry]));
});

it("retains expanded retry details while active tool and text events stream", () => {
  const [items, setItems] = createSignal(buildTranscript(history));
  const {container} = render(() => <Transcript items={items()}/>);
  const details = container.querySelector("details")!;
  details.open = true;
  setItems(items => applyStreamEvent(items, {type: "tool_call", data: {tool_call_id: "audit", name: "bash", args: {command: "audit"}}}));
  setItems(items => applyStreamEvent(items, {type: "text_delta", data: {content: "The audit is still running."}}));
  expect(container.querySelector("details")).toBe(details);
  expect(details.open).toBe(true);
  expect(items().find(item => item.kind === "tool")).toMatchObject({done: false});
});

it.each([
  ["no failure", [user("first"), user("retry", retry)]],
  ["ordinary failure", [user("first"), {type: "assistant_message", data: {success: false, content: "Build failed"}}, user("retry", retry)]],
  ["different prompt", [user("first"), failed, user("retry", "Use a different verification strategy.")]],
  ["ordinary added instruction", [user("first"), failed, user("retry", prompt + "\n\nAlso run the new tests.")]],
  ["source changed", [user("first"), failed, user("retry", retry, {source: "scheduler"})]],
  ["attachment", [user("first"), failed, user("retry", retry, {attached: true})]],
  ["intervening tool", [user("first"), failed, {type: "tool_call", data: {tool_call_id: "t", name: "bash"}}, user("retry", retry)]],
  ["intervening answer", [user("first"), failed, {type: "assistant_message", data: {content: "I have recovered."}}, user("retry", retry)]],
  ["missing earlier page", [failed, user("retry", retry)]],
] as [string, StreamEvent[]][])("leaves genuine messages expanded: %s", (_name, events) => {
  expect(visibleTranscript(buildTranscript(events)).some(item => item.kind === "user" && item.continuityRetry)).toBe(false);
});
