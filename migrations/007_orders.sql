CREATE TYPE order_status AS ENUM ('received', 'cutting', 'sewing', 'fitting', 'ready', 'delivered');

ALTER TABLE workshops ADD COLUMN itbis_basis_points integer CHECK (itbis_basis_points BETWEEN 0 AND 10000);

CREATE TABLE workshop_order_sequences (
  workshop_id uuid PRIMARY KEY REFERENCES workshops(id) ON DELETE CASCADE,
  last_number integer NOT NULL CHECK (last_number > 0)
);

CREATE TABLE workshop_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  customer_id uuid NOT NULL,
  customer_name text NOT NULL,
  catalog_name text NOT NULL,
  catalog_instructions text NOT NULL,
  tax_treatment tax_treatment NOT NULL,
  subtotal_cents bigint NOT NULL CHECK (subtotal_cents BETWEEN 0 AND 99999999999),
  tax_basis_points integer CHECK (tax_basis_points BETWEEN 0 AND 10000),
  tax_cents bigint CHECK (tax_cents >= 0),
  measurement_snapshots jsonb NOT NULL CHECK (jsonb_typeof(measurement_snapshots) = 'array'),
  delivery_local timestamp without time zone NOT NULL,
  responsible_name text,
  created_by uuid NOT NULL REFERENCES app_users(id),
  status order_status NOT NULL DEFAULT 'received',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workshop_id, customer_id) REFERENCES customers(workshop_id, id),
  UNIQUE (workshop_id, number),
  CHECK ((tax_basis_points IS NULL) = (tax_cents IS NULL))
);

CREATE INDEX workshop_orders_list_idx ON workshop_orders (workshop_id, created_at DESC, id DESC);
