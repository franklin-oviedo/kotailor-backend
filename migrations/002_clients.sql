CREATE TYPE customer_kind AS ENUM ('person', 'company');
CREATE TYPE fiscal_document_kind AS ENUM ('cedula', 'rnc', 'passport');

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  phone text NOT NULL CHECK (char_length(btrim(phone)) BETWEEN 7 AND 30),
  email text,
  kind customer_kind NOT NULL,
  document_kind fiscal_document_kind,
  document_number text,
  contact_authorized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((document_kind IS NULL) = (document_number IS NULL))
);

CREATE INDEX customers_workshop_created_idx ON customers(workshop_id, created_at DESC, id);
