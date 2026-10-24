# Desktop updates and local execution

On macOS and Linux the desktop is a client of a detached execution worker.
The worker owns harness stdin/stdout, native questions and plans, execution
receipts, run locks, binding updates, local-origin synchronization, wake-up
operations and transfer checks. A lost desktop connection unsubscribes that
view; it does not cancel the session. A new desktop reads a snapshot and
subscribes to the same streams and pending questions.

The worker uses a private Unix socket in `~/.orb/runtime` (directory 0700,
socket 0600), checks the peer UID, and announces its protocol before accepting
any request. All launches retain the existing Core permit and generation
checks. Transport errors are uncertain acknowledgements: the client never
replays a mutation automatically. Incompatible protocols fail before sending
a command. A missing or unreachable worker with an existing owner record
requires explicit recovery; Orb must not start another owner over its children.

At first use Orb preserves an immutable runtime image outside `Orb.app` and
starts that image in its own process session, with no inherited terminal or
stdio pipes. The installed desktop bundle can then be replaced independently.
The running worker keeps its original executable and MCP companion. Compatible
new desktops attach to that worker. Runtime-code changes take effect only when
that worker can itself be safely replaced; a desktop update does not secretly
restart a worker to upgrade its code. Windows retains the existing in-process
runner until a detached transport is implemented there.

## Initial migration

An old desktop already holding harness pipes cannot transfer them to the new
worker. Do not terminate, reparent, suspend or resume its sessions to simulate
a handoff. The first installation needs a gap with no local work owned by the
old desktop. Remote Core chats and independently owned builds are not reasons
to wait once their ownership has been established. Preserve independent context
workers. Do not run two desktop versions against live legacy sessions.

## Activation evidence

Before replacing the desktop, inspect its actual process descendants and
in-progress launch/transfer state. On later worker-backed versions, verify the
worker identity through `Orb.app/Contents/MacOS/orb --orb-execution-status` and
confirm that local agents and builds belong to that worker, not the UI. This
command is read-only and never starts a worker. Unavailable diagnostics,
unknown ownership, pending legacy launches or UI-owned children block activation.
Hold the applicable activation/launch gates across the final check and UI exit.
Preserve the old bundle and runtime images for rollback.

After relaunch, require the same worker PID, harness/build PIDs, pending
interaction identity and execution receipts. Check backend transport health
without issuing a model request. Do not use CPU quietness, stale timestamps or
SIGSTOP state as evidence of completion. Never clean runtime images or owner
records while their process state is unconfirmed. Core and its network-sharing
proxy are independent and must not be restarted for a desktop update.

The worker retains completed run snapshots while the desktop is absent. Initial
local-origin runs continue their existing native synchronization. Follow-up
transcript finalization and queued message dispatch reconnect through the
existing desktop receipt flow; this change does not start new research while
the UI is closed, or move provider calls out of the harness.

## Regression coverage

`cargo test --bin orb local_runtime::tests -- --test-threads=1` uses an isolated
HOME and a fake CLI. A separate UI client exits with an open subscription while
the CLI owns a child build and waits for a question. A replacement client checks
the same question, the same live process identities, a still-paused build and a
complete stream snapshot, then answers and receives the final output. The test
also verifies single launch, duplicate-owner refusal, oversized-message bounds,
private socket storage and incompatible-protocol refusal. No model requests or
user workspaces are used.

## Background work and queued messages

A queued follow-up never ends an active run merely because it has waited for a
long time. Elapsed time, quiet output and a memory pause are not completion
receipts. The first Enter queues; a second deliberate Enter with an empty composer
requests same-session steering of that saved message. A local queue wake only
retries normal dispatch. Unsupported steering stays queued and never falls
back to stopping or restarting the run. Explicit Stop remains separate.

Automatic background checks request observations only. They do not authorize
TaskStop, process signals or relaunches. Terminal task statuses are excluded
from live background snapshots; paused and unknown statuses remain pending.
Recovery messages describe a confirmed stopped run without inventing an app
restart or telling the agent to restart surviving builds.

Claude text snapshots reconcile against the current protocol message's streamed
prefix. This tolerates a transport ID differing from the persisted message ID,
retains a missing suffix, and preserves identical prose in a later message.
It does not rewrite existing conversation history or deduplicate arbitrary text.
Native parser/check changes require a new worker; installing a compatible UI
must leave the current worker and its children running until a safe replacement.

Regression coverage is in `local-message-queue.test.ts`,
`composer-draft-lifecycle.test.tsx`, `queued-messages.test.tsx`, and the native
`claude_stream_snapshot_*`, `claude_background_terminal_snapshot_*` and
`automatic_background_check_*` tests. They use fixtures rather than user jobs.

Remote follow-ups submitted with Enter are durably queued first. A second
deliberate Enter offers the saved message to Core's existing live session inbox. The composer clears after
admission and keeps subsequent drafts editable while delivery is pending.
An accepted inbox receipt does not claim the model has read or answered it.
Unsupported delivery stays queued; uncertain delivery is never replayed or
converted into stop-and-resume. The UI labels these states separately. This
uses the existing Core endpoint and requires no Core restart. Local workers
without a live-input capability continue to queue safely; do not claim that
UI installation adds such a capability to an already-running worker.

## Model-independent orchestration contract

Model names are display metadata, not ownership. A coordinator may use a
Claude-compatible transport while its children use Sol/Astra, or a Codex
coordinator may spawn Claude children. Route by mission, execution generation,
native thread and parent-tool identities. Child text, errors and completion
must not overwrite or terminate the coordinator. Child lifecycle reporting
remains separate from parent reply assembly. Native and Core Claude transports
share `shared/claude_stream_scope.rs`; Codex readers retain thread-ID filtering.

A coalesced text fragment must flush while the run is still open, not only at
EOF. Codex and legacy Grok have regressions that hold the session open after
the final fragment; Core Claude uses a periodic flush already. This is distinct
from a completed model response: tool work can continue after a progress note.

Delivery receipts are scoped to the connection and conversation that requested
them, including receipts arriving after a connection switch. Inbox acceptance
is not a read receipt or an answer receipt. A status or ETA query must not be
reported as answered solely because delivery succeeded. ETA requires evidence;
unknown completion time must remain unknown.

Current support limits: Core's live-input registry is connected to Claude and
Codex. The updated native worker also exposes same-session input for Claude and
Codex. Other harnesses and older pinned workers still queue messages
without interrupting work. Do not claim universal immediate mid-run answers or
silently emulate delivery by cancelling, restarting, or forking the main run.
The shared stream-scope tests cover mixed model labels on the Claude protocol;
the Codex regression covers child text, failure, completion and goal events.
These are protocol fixtures, not live provider/model evaluations. UI replacement
cannot activate changes inside a pinned worker or an already-running Core.

## Explicit worker upgrade at an idle boundary

A UI update alone cannot upgrade the native worker or transfer its live pipes.
The operational upgrader must verify terminal local run receipts, persisted
results, no live descendants (including stopped or memory-paused children),
and no pending launch/transfer operation. Closing only the UI flushes drafts;
a boot lock and quarantined socket pathname fence new requests. Existing
requests must drain completely before taking run, journal and transfer locks.
Only a worker proved idle under those gates may be terminated for replacement.
No agent/build receives a signal, and no forced termination is allowed. Keep
owner records and pinned images archived, preserve queued input, and verify
the replacement's exact hash, signature and live-input endpoint. Read-only
capability availability is distinct from having tested a live model answer.

Transcript disclosure controls precede their content and expand downward.
Delivered input freezes the already visible part of a cumulative answer; new
text renders below that input using the producer's original Unicode offsets.
This does not close running tools or change agent execution. Queued-only input
is not a delivered turn boundary. Chromium/WebKit regressions cover both.

## Follow-up response boundaries and stable disclosure

Claude follow-ups retain their individual native input IDs. Only the matching
coordinator input echo marks one consumed. Visible output from a response that
started before consumption cannot retire that input, even if the response
finishes afterward. Replayed response starts do not change that boundary.
Child-model output and child tool results cannot acknowledge coordinator input.
Multiple follow-ups retain independent, bounded reminder budgets; no question
keywords select a different assistant, model, or conversation.

This tracks consumption and subsequent visible output, not whether arbitrary
prose actually answers a question. Thinking is never promoted to a public
answer. The shared policy requests a visible reply before unrelated work;
model compliance still requires live evaluation. These runner changes take
effect in a new Core process or safely replaced desktop worker, not inside an
already-running harness.

The transcript preserves a displayed thought through completion and regrouping
with later thoughts or tools. Manual collapses remain authoritative. Historical
thoughts initially load collapsed, and reasoning inside work details is labelled
Thinking. Public assistant text stays outside work details. Browser regressions
exercise completion, grouping, manual collapse, turn order and replay in
Chromium and WebKit. Synthetic harness event cases validate renderer contracts;
they are not evidence that every live provider answers follow-ups correctly.
