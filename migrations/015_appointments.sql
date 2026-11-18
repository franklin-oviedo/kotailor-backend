CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE appointment_kind AS ENUM ('fitting', 'measurements', 'delivery');
CREATE TYPE appointment_status AS ENUM ('scheduled', 'cancelled');

ALTER TABLE workshop_orders
  ADD CONSTRAINT workshop_orders_workshop_id_customer_unique UNIQUE (workshop_id, id, customer_id);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  order_id uuid,
  responsible_id uuid NOT NULL REFERENCES app_users(id),
  kind appointment_kind NOT NULL,
  status appointment_status NOT NULL DEFAULT 'scheduled',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES app_users(id),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (workshop_id, customer_id) REFERENCES customers(workshop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workshop_id, order_id, customer_id) REFERENCES workshop_orders(workshop_id, id, customer_id),
  CONSTRAINT appointments_responsible_no_overlap EXCLUDE USING gist (
    responsible_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'scheduled')
);

CREATE INDEX appointments_workshop_starts_idx ON appointments (workshop_id, starts_at, id);
CREATE INDEX appointments_customer_starts_idx ON appointments (workshop_id, customer_id, starts_at, id);
