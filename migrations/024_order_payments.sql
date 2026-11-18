CREATE TYPE payment_kind AS ENUM ('payment', 'refund');
CREATE TYPE payment_method AS ENUM ('cash', 'transfer', 'card', 'other');

ALTER TABLE workshop_orders ADD CONSTRAINT workshop_orders_workshop_id_id_unique UNIQUE (workshop_id, id);

CREATE TABLE order_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL,
  order_id uuid NOT NULL,
  kind payment_kind NOT NULL,
  method payment_method NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 99999999999),
  original_payment_id uuid,
  reason text,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  FOREIGN KEY (workshop_id, order_id) REFERENCES workshop_orders(workshop_id, id) ON DELETE CASCADE,
  UNIQUE (workshop_id, order_id, id),
  UNIQUE (workshop_id, created_by, request_id),
  FOREIGN KEY (workshop_id, order_id, original_payment_id)
    REFERENCES order_payments(workshop_id, order_id, id),
  CHECK ((kind = 'payment' AND original_payment_id IS NULL AND reason IS NULL)
      OR (kind = 'refund' AND original_payment_id IS NOT NULL AND reason IS NOT NULL AND length(trim(reason)) BETWEEN 1 AND 500))
);

CREATE INDEX order_payments_order_idx ON order_payments (workshop_id, order_id, created_at, id);
