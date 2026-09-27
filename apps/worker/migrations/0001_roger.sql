-- Timestamps are milliseconds since the Unix epoch. GitHub users are identified
-- by their numeric id; logins are kept for display only.

CREATE TABLE responders (
  github_id     INTEGER PRIMARY KEY,
  login         TEXT NOT NULL,             -- latest login, for addressing and display
  ntfy_topic    TEXT,                      -- this person's push topic; NULL disables pushes
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX responders_login ON responders (lower(login));

CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,          -- SHA-256 of the cookie value
  github_id     INTEGER NOT NULL REFERENCES responders(github_id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,          -- credential id, base64url
  github_id     INTEGER NOT NULL REFERENCES responders(github_id),
  public_key    BLOB NOT NULL,             -- COSE key
  counter       INTEGER NOT NULL,
  transports    TEXT NOT NULL,             -- JSON array
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX passkeys_by_responder ON passkeys (github_id);

-- Single-use WebAuthn challenges, bound to what they authorize.
CREATE TABLE challenges (
  id            TEXT PRIMARY KEY,
  github_id     INTEGER NOT NULL REFERENCES responders(github_id),
  purpose       TEXT NOT NULL,             -- answer | register | step_up
  challenge     TEXT NOT NULL,
  binding       TEXT NOT NULL,             -- JSON of what the assertion permits
  expires_at    INTEGER NOT NULL
);
CREATE INDEX challenges_expiry ON challenges (expires_at);

CREATE TABLE requesters (
  id                  TEXT PRIMARY KEY,    -- ULID
  name                TEXT NOT NULL UNIQUE,
  pickup_minutes      INTEGER NOT NULL,    -- expected time from answer to delivered
  completion_minutes  INTEGER NOT NULL,    -- expected time from delivered to terminal
  created_by          INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  disabled_at         INTEGER
);

CREATE TABLE tokens (
  id            TEXT PRIMARY KEY,
  requester_id  TEXT NOT NULL REFERENCES requesters(id),
  hash          TEXT NOT NULL UNIQUE,      -- SHA-256; the token is shown once
  created_by    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX tokens_by_requester ON tokens (requester_id);

CREATE TABLE asks (
  id            TEXT PRIMARY KEY,          -- ULID
  requester_id  TEXT NOT NULL REFERENCES requesters(id),
  idem_key      TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  decision_key  TEXT NOT NULL,
  responder_id  INTEGER NOT NULL REFERENCES responders(github_id), -- the only person who can answer
  repo          TEXT,                      -- owner/name; kept
  supersedes    TEXT REFERENCES asks(id),
  kind          TEXT NOT NULL,
  urgency       TEXT NOT NULL,
  risk          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,                      -- purged by retention
  links         TEXT,                      -- JSON; purged by retention
  action        TEXT,                      -- JSON; kept
  options       TEXT NOT NULL,             -- JSON; kept
  resume        TEXT,                      -- JSON
  expires_at    INTEGER,
  push_due_at   INTEGER,                   -- when to push; NULL for inbox-only
  pushed_at     INTEGER,
  state         TEXT NOT NULL DEFAULT 'open',
  created_at    INTEGER NOT NULL,
  closed_at     INTEGER,
  UNIQUE (requester_id, idem_key)
);
CREATE UNIQUE INDEX asks_one_open ON asks (requester_id, decision_key) WHERE state = 'open';
CREATE UNIQUE INDEX asks_one_successor ON asks (supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX asks_inbox ON asks (responder_id, state, urgency, created_at);
CREATE INDEX asks_by_requester ON asks (requester_id, state, id);
CREATE INDEX asks_expiry ON asks (expires_at) WHERE state = 'open' AND expires_at IS NOT NULL;
CREATE INDEX asks_push ON asks (push_due_at) WHERE state = 'open' AND pushed_at IS NULL;
CREATE INDEX asks_retention ON asks (closed_at) WHERE body IS NOT NULL OR links IS NOT NULL;

CREATE TABLE answers (
  ask_id        TEXT PRIMARY KEY REFERENCES asks(id),
  option_id     TEXT NOT NULL,
  option_label  TEXT NOT NULL,
  decision      TEXT NOT NULL,
  input         TEXT,
  action        TEXT,                      -- JSON copied from the Ask
  responder_id  INTEGER NOT NULL,
  responder     TEXT NOT NULL,
  passkey_id    TEXT,
  answered_at   INTEGER NOT NULL
);

CREATE TABLE trace (
  id            TEXT PRIMARY KEY,          -- ULID, also the ordering
  ask_id        TEXT NOT NULL REFERENCES answers(ask_id),
  event         TEXT NOT NULL,
  refs          TEXT NOT NULL DEFAULT '{}',
  url           TEXT,
  note          TEXT,
  at            INTEGER NOT NULL
);
CREATE INDEX trace_by_ask ON trace (ask_id, id);
CREATE UNIQUE INDEX trace_one_terminal ON trace (ask_id)
  WHERE event IN ('applied', 'failed', 'not_applicable');
CREATE UNIQUE INDEX trace_one_delivered ON trace (ask_id) WHERE event = 'delivered';

-- Audit record of every state change, written in the same batch as the change.
-- Also the requester's event stream for `GET /v1/events`.
CREATE TABLE ask_events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  ask_id        TEXT NOT NULL REFERENCES asks(id),
  requester_id  TEXT NOT NULL REFERENCES requesters(id),
  state         TEXT NOT NULL,
  actor         TEXT NOT NULL,             -- requester:<id> | github:<id> | roger
  at            INTEGER NOT NULL
);
CREATE INDEX ask_events_by_requester ON ask_events (requester_id, seq);
CREATE UNIQUE INDEX ask_events_one_close ON ask_events (ask_id) WHERE state <> 'open';

CREATE TABLE digests (
  github_id     INTEGER NOT NULL REFERENCES responders(github_id),
  day           TEXT NOT NULL,             -- local date, YYYY-MM-DD
  sent_at       INTEGER NOT NULL,
  PRIMARY KEY (github_id, day)
);
