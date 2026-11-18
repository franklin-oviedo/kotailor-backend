ALTER TABLE workshops ADD COLUMN allow_invoices_without_tax boolean NOT NULL DEFAULT false;

ALTER TABLE administrative_invoices
  ADD COLUMN has_tax boolean NOT NULL DEFAULT true,
  ADD COLUMN tax_basis_points integer CHECK (tax_basis_points BETWEEN 0 AND 10000);

WITH treatments AS (
  SELECT workshop_id, invoice_id, bool_or(tax_treatment = 'taxable') AS has_tax,
         CASE WHEN count(DISTINCT tax_basis_points) FILTER (WHERE tax_treatment = 'taxable') = 1
              THEN max(tax_basis_points) FILTER (WHERE tax_treatment = 'taxable') END AS rate
  FROM administrative_invoice_lines
  GROUP BY workshop_id, invoice_id
)
UPDATE administrative_invoices i
SET has_tax = t.has_tax, tax_basis_points = CASE WHEN t.has_tax THEN t.rate ELSE 0 END
FROM treatments t WHERE i.workshop_id = t.workshop_id AND i.id = t.invoice_id;

ALTER TABLE administrative_invoices ADD CONSTRAINT administrative_invoice_tax_mode_check
  CHECK (has_tax OR (tax_basis_points IS NOT DISTINCT FROM 0
    AND tax_cents IS NOT DISTINCT FROM 0 AND total_cents IS NOT DISTINCT FROM subtotal_cents));
