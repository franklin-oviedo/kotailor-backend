ALTER TABLE order_payments ADD COLUMN invoice_id uuid;
ALTER TABLE order_payments ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE order_payments
  ADD CONSTRAINT order_payments_invoice_fk
  FOREIGN KEY (workshop_id, invoice_id)
  REFERENCES administrative_invoices(workshop_id, id),
  ADD CONSTRAINT order_payments_invoice_order_fk
  FOREIGN KEY (workshop_id, order_id, invoice_id)
  REFERENCES administrative_invoices(workshop_id, order_id, id),
  ADD CONSTRAINT order_payments_invoice_original_fk
  FOREIGN KEY (workshop_id, invoice_id, original_payment_id)
  REFERENCES order_payments(workshop_id, invoice_id, id),
  ADD CONSTRAINT order_payments_invoice_id_unique
  UNIQUE (workshop_id, invoice_id, id);

CREATE INDEX order_payments_invoice_idx
  ON order_payments (workshop_id, invoice_id, created_at, id)
  WHERE invoice_id IS NOT NULL;
