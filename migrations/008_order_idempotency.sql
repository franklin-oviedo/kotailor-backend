ALTER TABLE workshop_orders ADD COLUMN request_id uuid;
ALTER TABLE workshop_orders ADD COLUMN request_hash text;
ALTER TABLE workshop_orders ADD CONSTRAINT order_request_pair_check
  CHECK ((request_id IS NULL) = (request_hash IS NULL));
CREATE UNIQUE INDEX workshop_orders_request_idx
  ON workshop_orders (workshop_id, created_by, request_id) WHERE request_id IS NOT NULL;
