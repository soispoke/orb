-- Preserve the snapshot visible before a delivered follow-up. Later tokens
-- create a fresh mutable row instead of erasing the preceding response.
CREATE TRIGGER IF NOT EXISTS preserve_text_at_user_boundary
BEFORE INSERT ON mission_events
WHEN NEW.event_type = 'user_message'
 AND COALESCE(json_extract(NEW.metadata, '$.queued'), 0) = 0
BEGIN
 UPDATE mission_events SET event_id = 'text_delta_checkpoint:' || sequence
 WHERE mission_id = NEW.mission_id AND event_type = 'text_delta'
 AND event_id = 'text_delta_latest';
END;
