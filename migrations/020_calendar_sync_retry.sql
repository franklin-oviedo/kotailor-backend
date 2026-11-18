CREATE TYPE calendar_sync_failure AS ENUM ('unavailable', 'reconciliation');

ALTER TABLE appointments
  ADD COLUMN calendar_sync_attempted boolean NOT NULL DEFAULT false,
  ADD COLUMN calendar_retry_version integer NOT NULL DEFAULT 0,
  ADD COLUMN calendar_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN calendar_retry_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN calendar_sync_failure calendar_sync_failure,
  ADD CONSTRAINT appointments_calendar_retry_check
    CHECK (calendar_retry_version BETWEEN 0 AND version AND calendar_retry_count >= 0);

UPDATE appointments SET calendar_sync_attempted = true WHERE synced_version > 0;

CREATE INDEX appointments_calendar_pending_idx
  ON appointments (calendar_retry_at, workshop_id, id)
  WHERE synced_version < version;
