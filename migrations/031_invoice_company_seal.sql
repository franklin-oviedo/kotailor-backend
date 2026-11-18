ALTER TABLE workshop_billing_profiles
  ADD COLUMN seal_mime_type text CHECK (seal_mime_type IN ('image/png', 'image/jpeg')),
  ADD COLUMN seal_bytes bytea CHECK (octet_length(seal_bytes) <= 61440),
  ADD CHECK ((seal_mime_type IS NULL) = (seal_bytes IS NULL));

ALTER TABLE administrative_invoices
  ADD COLUMN workshop_seal_mime_type text CHECK (workshop_seal_mime_type IN ('image/png', 'image/jpeg')),
  ADD COLUMN workshop_seal_bytes bytea CHECK (octet_length(workshop_seal_bytes) <= 61440),
  ADD CHECK ((workshop_seal_mime_type IS NULL) = (workshop_seal_bytes IS NULL));
