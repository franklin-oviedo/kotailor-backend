ALTER TABLE administrative_invoices
  DROP CONSTRAINT administrative_invoices_workshop_id_order_id_key;

CREATE UNIQUE INDEX administrative_invoices_one_active_order_idx
  ON administrative_invoices (workshop_id, order_id)
  WHERE order_id IS NOT NULL AND status <> 'void';
