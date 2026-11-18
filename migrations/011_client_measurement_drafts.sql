CREATE TABLE client_measurement_drafts (
  customer_id uuid NOT NULL REFERENCES customer_account_links(customer_id) ON DELETE CASCADE,
  garment measurement_garment NOT NULL,
  measurements jsonb NOT NULL CHECK (jsonb_typeof(measurements) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, garment)
);
