-- Machine login (RFC 8628 device authorization) and per-automation requesters.
-- Additive only: static tokens and existing requesters are unchanged.

-- A logged-in machine. Its credential acts as any of the owner's requesters
-- whose `machine` is this name. An active name belongs to one person.
CREATE TABLE machines (
  id            TEXT PRIMARY KEY,          -- ULID; later logins sort after earlier ones
  name          TEXT NOT NULL,             -- chosen when approving, such as studio
  owner         INTEGER NOT NULL REFERENCES responders(github_id),
  hash          TEXT NOT NULL UNIQUE,      -- SHA-256 of the credential; shown once
  replacing     INTEGER NOT NULL DEFAULT 1, -- 1 until first used; that use revokes the
                                           -- owner's older machines of the same name
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX machines_active ON machines (name, owner) WHERE revoked_at IS NULL;
CREATE INDEX machines_by_owner ON machines (owner, name) WHERE revoked_at IS NULL;

-- A pending `roger login`. Expired rows are deleted as new logins start and by the sweep.
CREATE TABLE device_codes (
  id            TEXT PRIMARY KEY,          -- ULID
  device_hash   TEXT NOT NULL UNIQUE,      -- SHA-256 of the device code the CLI polls with
  user_hash     TEXT NOT NULL UNIQUE,      -- SHA-256 of the normalized user code
  suggested     TEXT,                      -- machine name the CLI suggested
  source        TEXT,                      -- requesting IP and country, shown when approving
  user_agent    TEXT,                      -- requesting User-Agent, at most 200 characters
  state         TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | issued
  owner         INTEGER REFERENCES responders(github_id), -- who approved or denied
  machine       TEXT,                      -- name chosen when approving
  interval_ms   INTEGER NOT NULL,          -- grows by 5 s on each too-fast poll
  polled_at     INTEGER,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX device_codes_expiry ON device_codes (expires_at);
CREATE INDEX device_codes_pending ON device_codes (expires_at) WHERE state = 'pending';
CREATE INDEX device_codes_approved ON device_codes (machine) WHERE state = 'approved';

-- Code lookups, approvals, and denials per person, for RFC 8628 section 5.1.
CREATE TABLE device_attempts (
  id            TEXT PRIMARY KEY,          -- ULID
  github_id     INTEGER NOT NULL REFERENCES responders(github_id),
  at            INTEGER NOT NULL
);
CREATE INDEX device_attempts_by_person ON device_attempts (github_id, at);
CREATE INDEX device_attempts_by_time ON device_attempts (at);

-- The machine name whose credentials act as this requester: set for
-- requesters created on first use as `<machine>/<name>` and for ones adopted
-- in Settings.
ALTER TABLE requesters ADD COLUMN machine TEXT;
CREATE INDEX requesters_by_machine ON requesters (created_by, machine) WHERE machine IS NOT NULL;
CREATE INDEX requesters_by_machine_name ON requesters (machine) WHERE machine IS NOT NULL;
