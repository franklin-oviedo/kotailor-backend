CREATE TYPE administrative_invoice_status AS ENUM ('draft', 'issued', 'void');
CREATE TYPE administrative_invoice_revision_kind AS ENUM ('created', 'updated', 'issued', 'voided');
CREATE TYPE invoice_tax_treatment AS ENUM ('taxable', 'exempt');

CREATE TABLE workshop_billing_profiles (
  workshop_id uuid PRIMARY KEY REFERENCES workshops(id) ON DELETE CASCADE,
  legal_name text CHECK (legal_name IS NULL OR length(trim(legal_name)) BETWEEN 1 AND 200),
  trade_name text CHECK (trade_name IS NULL OR length(trim(trade_name)) BETWEEN 1 AND 200),
  rnc text CHECK (rnc IS NULL OR rnc ~ '^[0-9]{9,11}$'),
  fiscal_address text CHECK (fiscal_address IS NULL OR length(trim(fiscal_address)) <= 500),
  phone text CHECK (phone IS NULL OR length(trim(phone)) <= 30),
  email text CHECK (email IS NULL OR length(trim(email)) <= 254),
  logo_mime_type text CHECK (logo_mime_type IS NULL OR logo_mime_type IN ('image/png', 'image/jpeg')),
  logo_bytes bytea CHECK (logo_bytes IS NULL OR octet_length(logo_bytes) <= 1048576),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((logo_mime_type IS NULL) = (logo_bytes IS NULL))
);

CREATE TABLE administrative_invoice_sequences (
  workshop_id uuid PRIMARY KEY REFERENCES workshops(id) ON DELETE CASCADE,
  last_number integer NOT NULL CHECK (last_number > 0)
);

CREATE TABLE administrative_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  order_id uuid,
  customer_id uuid NOT NULL,
  status administrative_invoice_status NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  issue_date date NOT NULL,
  due_date date,
  workshop_snapshot jsonb NOT NULL CHECK (jsonb_typeof(workshop_snapshot) = 'object'),
  workshop_logo_mime_type text CHECK (workshop_logo_mime_type IS NULL OR workshop_logo_mime_type IN ('image/png', 'image/jpeg')),
  workshop_logo_bytes bytea CHECK (workshop_logo_bytes IS NULL OR octet_length(workshop_logo_bytes) <= 1048576),
  customer_snapshot jsonb NOT NULL CHECK (jsonb_typeof(customer_snapshot) = 'object'),
  terms text NOT NULL DEFAULT '' CHECK (length(terms) <= 2000),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  subtotal_cents bigint NOT NULL CHECK (subtotal_cents BETWEEN 0 AND 99999999999),
  tax_cents bigint CHECK (tax_cents IS NULL OR tax_cents BETWEEN 0 AND 99999999999),
  total_cents bigint CHECK (total_cents IS NULL OR total_cents BETWEEN 0 AND 99999999999),
  created_by uuid NOT NULL REFERENCES app_users(id),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  issued_at timestamptz,
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(trim(void_reason)) BETWEEN 1 AND 1000),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  FOREIGN KEY (workshop_id, customer_id) REFERENCES customers(workshop_id, id),
  FOREIGN KEY (workshop_id, order_id) REFERENCES workshop_orders(workshop_id, id),
  UNIQUE (workshop_id, id),
  UNIQUE (workshop_id, number),
  UNIQUE (workshop_id, order_id, id),
  UNIQUE (workshop_id, created_by, request_id),
  UNIQUE (workshop_id, order_id),
  CHECK ((tax_cents IS NULL) = (total_cents IS NULL)),
  CHECK ((workshop_logo_mime_type IS NULL) = (workshop_logo_bytes IS NULL)),
  CHECK ((status = 'draft' AND issued_at IS NULL AND voided_at IS NULL AND void_reason IS NULL)
      OR (status = 'issued' AND issued_at IS NOT NULL AND voided_at IS NULL AND void_reason IS NULL)
      OR (status = 'void' AND voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (due_date IS NULL OR due_date >= issue_date)
);

CREATE INDEX administrative_invoices_list_idx
  ON administrative_invoices (workshop_id, created_at DESC, id DESC);

CREATE TABLE administrative_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
  quantity_milli integer NOT NULL CHECK (quantity_milli BETWEEN 1 AND 1000000000),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 99999999999),
  discount_cents bigint NOT NULL DEFAULT 0 CHECK (discount_cents BETWEEN 0 AND 99999999999),
  tax_treatment invoice_tax_treatment NOT NULL,
  tax_basis_points integer CHECK (tax_basis_points BETWEEN 0 AND 10000),
  subtotal_cents bigint NOT NULL CHECK (subtotal_cents BETWEEN 0 AND 99999999999),
  tax_cents bigint CHECK (tax_cents IS NULL OR tax_cents BETWEEN 0 AND 99999999999),
  FOREIGN KEY (workshop_id, invoice_id) REFERENCES administrative_invoices(workshop_id, id) ON DELETE CASCADE,
  UNIQUE (invoice_id, position),
  CHECK ((tax_treatment = 'taxable' AND (tax_basis_points IS NULL) = (tax_cents IS NULL))
      OR (tax_treatment = 'exempt' AND tax_basis_points = 0 AND tax_cents = 0)),
  CHECK (discount_cents <= round(quantity_milli::numeric * unit_price_cents / 1000))
);

CREATE TABLE administrative_invoice_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  kind administrative_invoice_revision_kind NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  changed_by uuid NOT NULL REFERENCES app_users(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workshop_id, invoice_id) REFERENCES administrative_invoices(workshop_id, id) ON DELETE CASCADE,
  UNIQUE (invoice_id, revision)
);

CREATE INDEX administrative_invoice_revisions_idx
  ON administrative_invoice_revisions (workshop_id, invoice_id, revision DESC);
