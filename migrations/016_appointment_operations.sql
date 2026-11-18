ALTER TABLE appointments
  ADD COLUMN request_id uuid,
  ADD COLUMN request_hash text,
  ADD COLUMN synced_version integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT appointments_request_pair_check
    CHECK ((request_id IS NULL) = (request_hash IS NULL)),
  ADD CONSTRAINT appointments_synced_version_check
    CHECK (synced_version BETWEEN 0 AND version);

CREATE UNIQUE INDEX appointments_request_idx
  ON appointments (workshop_id, created_by, request_id) WHERE request_id IS NOT NULL;
