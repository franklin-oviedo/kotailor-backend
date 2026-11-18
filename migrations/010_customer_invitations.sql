ALTER TABLE customers ADD CONSTRAINT customers_id_workshop_unique UNIQUE (id, workshop_id);

CREATE TABLE customer_account_links (
  customer_id uuid PRIMARY KEY,
  workshop_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_id, workshop_id) REFERENCES customers(id, workshop_id) ON DELETE CASCADE,
  UNIQUE (workshop_id, user_id)
);

CREATE TABLE customer_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  recipient_email text NOT NULL,
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES app_users(id),
  customer_id uuid,
  FOREIGN KEY (customer_id, workshop_id) REFERENCES customers(id, workshop_id),
  CHECK ((accepted_at IS NULL AND accepted_by IS NULL AND customer_id IS NULL)
      OR (accepted_at IS NOT NULL AND accepted_by IS NOT NULL AND customer_id IS NOT NULL))
);
