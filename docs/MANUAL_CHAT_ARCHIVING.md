# Chats stay visible until explicitly archived

Reading a chat or leaving it idle must not move it into Archived. The former
ack-promotion loop did exactly that one hour after a waiting chat was viewed.
The loop is removed. Its legacy store hook returns no changes in every store;
read receipts remain independent of status. Expiring a PR-writer lease also
releases only the lease, without archiving its conversation.

Explicit Archive and Restore still use the existing status endpoint and retain
its active-run/background-job checks. Existing archives are not automatically
restored: some were deliberately archived by the user.

## Protect an older running Core without interrupting work

`scripts/orb-disable-legacy-auto-archive.sql` is a narrow compatibility guard
for the old SQLite sweep. Back up the database with SQLite's backup API, then
install it in a short transaction. It changes no mission, history, run, or
transfer rows. Never replace a live database with the backup.

The obsolete sweep changes status without updating `last_status_change_at`;
explicit status changes update that field. The guard aborts the old sweep's
transaction, preventing both persistence and misleading archive broadcasts.
Read receipts and manual archive/restore continue to work. Until the updated
backend is deployed, the old loop can log an "Automatic chat archiving disabled"
warning when it attempts a sweep. This is the compatibility guard working.

The guard survives restarts and does not require a Core or proxy restart. Once
the updated backend is installed, the old timer no longer runs. The guard may
then be removed with `DROP TRIGGER IF EXISTS orb_disable_legacy_auto_archive`.
Removing it while running an old binary re-enables that binary's timer. The
separate PR-writer lease behavior changes only with the updated backend.

Validation:

- `python3 scripts/test_orb_manual_archive.py`
- `cargo test --locked -j 1 --lib viewed_idle_chats_require_explicit_archive_in_every_store -- --test-threads=1`
- `cargo test --locked -j 1 --lib expired_writer_lease_does_not_archive_chat -- --test-threads=1`
