ALTER TABLE workshop_calendar_connections
  ADD COLUMN selected_calendar_id text,
  ADD COLUMN pending_calendar_id text,
  ADD COLUMN selection_version integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT calendar_selection_version_check CHECK (selection_version >= 0),
  ADD CONSTRAINT calendar_selected_id_check CHECK (
    selected_calendar_id IS NULL OR
    (length(selected_calendar_id) BETWEEN 1 AND 1024 AND selected_calendar_id NOT IN ('.', '..'))
  ),
  ADD CONSTRAINT calendar_pending_id_check CHECK (
    pending_calendar_id IS NULL OR
    (length(pending_calendar_id) BETWEEN 1 AND 1024 AND pending_calendar_id NOT IN ('.', '..')
      AND selected_calendar_id IS NOT NULL AND pending_calendar_id <> selected_calendar_id)
  );
