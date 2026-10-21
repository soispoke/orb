-- Live compatibility guard for Core builds that still run the archive timer.
-- Install transactionally after backing up the database. No row is changed.
-- The old sweep omits last_status_change_at. Explicit status updates set it.
-- ABORT (not IGNORE) makes the sweep roll back instead of broadcasting phantom
-- archive events for the IDs it selected before the UPDATE.
CREATE TRIGGER IF NOT EXISTS orb_disable_legacy_auto_archive
BEFORE UPDATE OF status ON missions
WHEN OLD.status = 'awaiting_user'
 AND NEW.status = 'acknowledged'
 AND NEW.last_status_change_at IS OLD.last_status_change_at
BEGIN
 SELECT RAISE(ABORT, 'Automatic chat archiving disabled; use explicit Archive');
END;
