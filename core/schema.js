// Relational schema shared by the server (Node) and the browser demo.
// Money is stored in whole cents; timestamps are ISO-8601 strings in UTC.

export const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS lots (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  zone              TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('permit', 'paid', 'mixed')),
  capacity          INTEGER NOT NULL CHECK (capacity > 0),
  rate_cents_hour   INTEGER NOT NULL DEFAULT 0 CHECK (rate_cents_hour >= 0)
);

CREATE TABLE IF NOT EXISTS permits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plate       TEXT NOT NULL,
  holder      TEXT NOT NULL,
  permit_type TEXT NOT NULL,
  zones       TEXT NOT NULL,              -- comma separated zone codes, e.g. 'A,B'
  starts_on   TEXT NOT NULL,              -- YYYY-MM-DD, inclusive
  ends_on     TEXT NOT NULL,              -- YYYY-MM-DD, inclusive
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permits_plate ON permits (plate);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plate       TEXT NOT NULL,
  lot_id      TEXT NOT NULL REFERENCES lots (id),
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  paid_cents  INTEGER NOT NULL CHECK (paid_cents >= 0),
  channel     TEXT NOT NULL CHECK (channel IN ('pay_station', 'mobile'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_plate_lot ON sessions (plate, lot_id);

CREATE TABLE IF NOT EXISTS visits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plate       TEXT NOT NULL,
  lot_id      TEXT NOT NULL REFERENCES lots (id),
  entered_at  TEXT NOT NULL,
  exited_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_visits_open ON visits (lot_id, exited_at);

CREATE TABLE IF NOT EXISTS citations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       TEXT NOT NULL UNIQUE,
  plate        TEXT NOT NULL,
  lot_id       TEXT NOT NULL REFERENCES lots (id),
  violation    TEXT NOT NULL,
  fine_cents   INTEGER NOT NULL CHECK (fine_cents > 0),
  issued_at    TEXT NOT NULL,
  issued_on    TEXT NOT NULL,             -- YYYY-MM-DD, for the one-per-day rule
  officer      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'paid', 'appealed', 'voided')),
  paid_cents   INTEGER,
  closed_at    TEXT,
  note         TEXT,
  UNIQUE (plate, lot_id, issued_on)
);
CREATE INDEX IF NOT EXISTS idx_citations_status ON citations (status);

CREATE TABLE IF NOT EXISTS plate_reads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plate       TEXT NOT NULL,
  lot_id      TEXT NOT NULL REFERENCES lots (id),
  read_at     TEXT NOT NULL,
  result      TEXT NOT NULL,
  reason      TEXT NOT NULL
);
`;
