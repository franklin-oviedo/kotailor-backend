CREATE TYPE administrator_invitation_kind AS ENUM ('workshop_creator', 'workshop_member');

CREATE TABLE platform_administrators (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workshop_creation_grants (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL UNIQUE,
  used_at timestamptz,
  PRIMARY KEY (user_id, invitation_id)
);

CREATE TABLE administrator_invitation_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  ttl_hours integer NOT NULL CHECK (ttl_hours BETWEEN 1 AND 720)
);
INSERT INTO administrator_invitation_policy (ttl_hours) VALUES (168);

CREATE TABLE administrator_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  recipient_email text NOT NULL,
  kind administrator_invitation_kind NOT NULL,
  workshop_id uuid REFERENCES workshops(id) ON DELETE CASCADE,
  role membership_role,
  created_by uuid NOT NULL REFERENCES app_users(id),
  issued_by_platform boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES app_users(id),
  CHECK ((kind = 'workshop_creator' AND workshop_id IS NULL AND role IS NULL AND issued_by_platform)
    OR (kind = 'workshop_member' AND workshop_id IS NOT NULL AND role IS NOT NULL)),
  CHECK ((accepted_at IS NULL) = (accepted_by IS NULL))
);
ALTER TABLE workshop_creation_grants ADD CONSTRAINT creation_grant_invitation_fk
  FOREIGN KEY (invitation_id) REFERENCES administrator_invitations(id);
