ALTER TABLE client_measurement_drafts ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;

CREATE TABLE client_measurement_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  submitted_by uuid NOT NULL REFERENCES app_users(id),
  garment measurement_garment NOT NULL,
  draft_id uuid NOT NULL,
  draft_revision integer NOT NULL CHECK (draft_revision > 0),
  measurements jsonb NOT NULL CHECK (jsonb_typeof(measurements) = 'object'),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  verified_version_id uuid UNIQUE REFERENCES customer_measurement_versions(id),
  FOREIGN KEY (workshop_id, customer_id) REFERENCES customers(workshop_id, id) ON DELETE CASCADE,
  UNIQUE (draft_id, draft_revision)
);

CREATE UNIQUE INDEX client_measurement_pending_idx
  ON client_measurement_submissions (customer_id, garment) WHERE verified_version_id IS NULL;
