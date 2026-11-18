ALTER TABLE workshop_calendar_connections
  ADD COLUMN move_retry_count integer NOT NULL DEFAULT 0 CHECK (move_retry_count >= 0),
  ADD COLUMN move_retry_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN move_failure calendar_sync_failure;
