ALTER TABLE workshops ADD COLUMN calendar_connection_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE calendar_authorization_flows ADD COLUMN connection_epoch bigint NOT NULL DEFAULT 0;
