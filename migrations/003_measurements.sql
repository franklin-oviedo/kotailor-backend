CREATE TYPE measurement_garment AS ENUM ('womens_trousers');

ALTER TABLE customers ADD CONSTRAINT customers_workshop_id_unique UNIQUE (workshop_id, id);

CREATE TABLE customer_measurement_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  garment measurement_garment NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  measurements jsonb NOT NULL CHECK (jsonb_typeof(measurements) = 'object'),
  verified_by uuid NOT NULL REFERENCES app_users(id),
  verified_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workshop_id, customer_id) REFERENCES customers(workshop_id, id) ON DELETE CASCADE,
  UNIQUE (workshop_id, customer_id, garment, version)
);
