CREATE TABLE calendar_move_progress (
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  selection_version integer NOT NULL CHECK (selection_version > 0),
  destination_ready boolean NOT NULL DEFAULT false,
  source_removed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workshop_id, appointment_id, selection_version),
  CHECK (NOT source_removed OR destination_ready)
);

CREATE INDEX calendar_move_progress_workshop_idx
  ON calendar_move_progress (workshop_id, selection_version, source_removed);

CREATE FUNCTION prevent_unsynchronized_appointment_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workshops w JOIN workshop_calendar_connections c ON c.workshop_id = w.id
    WHERE w.id = OLD.workshop_id AND c.selected_calendar_id IS NOT NULL
      AND (c.pending_calendar_id IS NOT NULL OR
        (OLD.calendar_sync_attempted AND (OLD.status = 'scheduled' OR OLD.synced_version < OLD.version)))
  ) THEN
    RAISE EXCEPTION 'Appointment must be synchronized before deletion' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER appointments_protect_calendar_events
  BEFORE DELETE ON appointments FOR EACH ROW EXECUTE FUNCTION prevent_unsynchronized_appointment_deletion();
