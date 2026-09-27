-- Machine login (RFC 8628 device authorization) and per-automation requesters.
-- Additive only: static tokens and existing requesters are unchanged.

-- A logged-in machine. Its credential acts as any of the owner's requesters
-- whose `machine` is this name.
CREATE TABLE machines (
  id            TEXT PRIMARY KEY,          -- ULID
  name          TEXT NOT NULL,             -- chosen when approving, such as studio
  owner         INTEGER NOT NULL REFERENCES responders(github_id),
  hash          TEXT NOT NULL UNIQUE,      -- SHA-256 of the credential; shown once
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
-- One active machine per name across everyone; a name belongs to one person.
CREATE UNIQUE INDEX machines_one_active ON machines (name) WHERE revoked_at IS NULL;
CREATE INDEX machines_by_name ON machines (name);
CREATE INDEX machines_by_owner ON machines (owner);

-- A pending `roger login`. Deleted by the sweep once expired.
CREATE TABLE device_codes (
  id            TEXT PRIMARY KEY,          -- ULID
  device_hash   TEXT NOT NULL UNIQUE,      -- SHA-256 of the device code the CLI polls with
  user_hash     TEXT NOT NULL UNIQUE,      -- SHA-256 of the normalized user code
  suggested     TEXT,                      -- machine name the CLI suggested
  state         TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | issued
  owner         INTEGER REFERENCES responders(github_id), -- who approved or denied
  machine       TEXT,                      -- name chosen when approving
  interval_ms   INTEGER NOT NULL,          -- grows by 5 s on each too-fast poll
  polled_at     INTEGER,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX device_codes_expiry ON device_codes (expires_at);

-- The machine name whose credentials act as this requester: set for
-- requesters created on first use as `<machine>/<name>` and for adopted ones.
ALTER TABLE requesters ADD COLUMN machine TEXT;
CREATE INDEX requesters_by_machine ON requesters (created_by, machine) WHERE machine IS NOT NULL;
