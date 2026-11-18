CREATE TYPE membership_role AS ENUM ('owner', 'manager', 'staff');

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workshops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workshop_memberships (
  workshop_id uuid NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role membership_role NOT NULL,
  PRIMARY KEY (workshop_id, user_id)
);

CREATE INDEX workshop_memberships_user_idx ON workshop_memberships(user_id);

CREATE TABLE sessions (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);

CREATE INDEX sessions_expire_idx ON sessions(expire);
