CREATE TYPE catalog_category AS ENUM ('tailoring', 'alteration');
CREATE TYPE tax_treatment AS ENUM ('taxable', 'exempt');

CREATE TABLE garment_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  category catalog_category NOT NULL,
  base_price_cents bigint NOT NULL CHECK (base_price_cents BETWEEN 0 AND 99999999999),
  tax_treatment tax_treatment NOT NULL,
  measurement_garments measurement_garment[] NOT NULL DEFAULT '{}',
  instructions text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX garment_catalog_workshop_created_idx ON garment_catalog (workshop_id, created_at DESC, id DESC);
