ALTER TABLE workshop_orders ADD COLUMN responsible_id uuid REFERENCES app_users(id) ON DELETE SET NULL;

CREATE INDEX workshop_orders_responsible_idx ON workshop_orders (workshop_id, responsible_id) WHERE status <> 'delivered';
