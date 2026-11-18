ALTER TABLE order_payments
  ADD COLUMN reference text,
  ADD CONSTRAINT order_payments_reference_length
    CHECK (reference IS NULL OR length(trim(reference)) BETWEEN 1 AND 120);
