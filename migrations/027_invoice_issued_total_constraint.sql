ALTER TABLE administrative_invoices
  ADD CONSTRAINT administrative_invoices_issued_total_check
  CHECK (status <> 'issued' OR total_cents IS NOT NULL);
