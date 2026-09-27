-- Machine login (`roger login` through GitHub's device flow) and per-automation requesters.
-- Additive only: static tokens and existing requesters are unchanged.

-- A logged-in machine. Its credential acts as any of the owner's requesters
-- whose `machine` is this name. An active name belongs to one person.
CREATE TABLE machines (
  id            TEXT PRIMARY KEY,          -- ULID
  name          TEXT NOT NULL,             -- from `roger login --machine`, such as studio
  owner         INTEGER NOT NULL REFERENCES responders(github_id),
  hash          TEXT NOT NULL UNIQUE,      -- SHA-256 of the credential; shown once
  generation    INTEGER NOT NULL,          -- per owner and name, assigned in the issuing
                                           -- statement: 1 more than any earlier login
  replacing     INTEGER NOT NULL DEFAULT 1, -- 1 until first used; that use revokes the
                                           -- owner's lower generations of the same name
  source        TEXT NOT NULL,             -- IP address and country of the login
  user_agent    TEXT,                      -- of the login, at most 200 characters
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX machines_active ON machines (name, owner) WHERE revoked_at IS NULL;
CREATE INDEX machines_by_owner ON machines (owner, name) WHERE revoked_at IS NULL;
CREATE INDEX machines_generations ON machines (owner, name, generation);

-- The machine name whose credentials act as this requester: set for
-- requesters created on first use as `<machine>/<name>` and for ones adopted
-- in Settings.
ALTER TABLE requesters ADD COLUMN machine TEXT;
CREATE INDEX requesters_by_machine ON requesters (created_by, machine) WHERE machine IS NOT NULL;
CREATE INDEX requesters_by_machine_name ON requesters (machine) WHERE machine IS NOT NULL;
