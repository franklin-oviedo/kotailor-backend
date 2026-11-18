CREATE TABLE calendar_authorization_flows (
  state_hash text PRIMARY KEY CHECK (length(state_hash) = 64),
  session_hash text NOT NULL CHECK (length(session_hash) = 64),
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX calendar_authorization_flows_expiry_idx ON calendar_authorization_flows (expires_at);

CREATE TABLE workshop_calendar_connections (
  workshop_id uuid PRIMARY KEY REFERENCES workshops(id) ON DELETE CASCADE,
  google_subject text NOT NULL,
  google_email text NOT NULL,
  encrypted_refresh_token bytea NOT NULL,
  connected_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
