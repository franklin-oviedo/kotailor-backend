ALTER TABLE appointments
  ADD COLUMN calendar_absence_seen_at timestamptz;

ALTER TABLE calendar_move_progress
  ADD COLUMN source_absence_seen_at timestamptz;
