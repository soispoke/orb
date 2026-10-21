# Local machine transfer continuity

Machine transfers copy the archived conversation and saved workspace files, not a live
process. Preparing an active source stops its run. In-memory computation cannot be
migrated; switch after a checkpoint or completed build. The destination waits for the
next user message. Provider authentication remains on each machine and is excluded from
workspace transfer.

## Fixes

- Force a fresh, strict local CLI scan before stopping the source and before activating
  a local destination. A failed scan cannot silently authorize a transfer using stale
  inventory. Normal background inventory callers retain their previous fallback behavior
  and share the same pending scan promise.
- Keep remote destinations usable if the local inventory fails, with refresh controls
  in the machine picker and local transfer dialog.
- Require the selected model to belong to the destination catalog.
- Key local session adoption by transfer identity and harness, as well as workspace
  path, for every harness. Repeated reads of one transfer preserve its new native session;
  a later transfer to the same path starts from the transferred context instead of
  reusing an obsolete local session.
- Retain the selected model and effort when creating the destination binding.

## Validation

The frontend regression suite passed (1,123 tests, three optional live tests skipped),
followed by a new passing remote-availability regression and the focused transfer tests.
The TypeScript/Vite build and all 28 Chromium/WebKit overlay tests passed. Claude's actual
local launch wrapper reported an existing authenticated account in two fresh temporary
workspace directories, without another login or copying credentials.

These checks do not establish live process migration or guarantee that provider sessions
never expire. No real research conversation was moved or interrupted for testing.
