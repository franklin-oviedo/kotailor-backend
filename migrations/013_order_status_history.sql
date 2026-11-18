ALTER TABLE workshop_orders ADD CONSTRAINT workshop_orders_workshop_id_id_key UNIQUE (workshop_id, id);

CREATE TABLE order_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL,
  order_id uuid NOT NULL,
  previous_status order_status NOT NULL,
  new_status order_status NOT NULL,
  changed_by uuid NOT NULL REFERENCES app_users(id),
  changed_by_name text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workshop_id, order_id) REFERENCES workshop_orders(workshop_id, id) ON DELETE CASCADE,
  CHECK (previous_status <> new_status)
);

CREATE INDEX order_status_history_order_idx ON order_status_history (workshop_id, order_id, changed_at DESC, id DESC);
