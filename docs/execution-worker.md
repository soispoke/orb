
### Queue and same-session steering

During a run the first Enter durably queues the message. A second deliberate
Enter with an empty composer requests live delivery of that same message ID.
A new draft queues separately. Held keys, IME composition, connection changes
and chat changes do not trigger delivery. A receipt means transport acceptance;
it does not promise that the model has read or answered the question yet.

The local worker advertises a per-session input token. Claude uses its existing
stream-json stdin and echoed input; Codex uses turn/steer with the existing
thread and expected turn ID. Neither adapter invokes stop, interrupt, recovery
or launch. Nested agent results do not terminate the coordinator. Missing
capabilities (including an older pinned worker) leave the message queued with
an explanation. Other native harnesses currently retain the same safe queued
fallback; they must gain a verified input adapter before advertising steering.

Before native delivery, Orb persists an uncertain-delivery record. A crash,
lost acknowledgment or transcript-sync failure retains that record and prevents
automatic replay as a new run. Native repeated message IDs are idempotent within
the same session token. Owner records and pinned worker images are not removed
by a UI upgrade. Installing the bundle does not upgrade a live pinned worker:
new native behavior requires a safe worker replacement after its runs finish.
