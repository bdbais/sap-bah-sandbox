PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

-- One row per package seen on the Hub. Kept even after it disappears so the
-- change history stays readable.
CREATE TABLE IF NOT EXISTS packages (
  technical_name TEXT PRIMARY KEY,
  display_name   TEXT,
  version        TEXT,
  type           TEXT,
  sub_type       TEXT,
  vendor         TEXT,
  short_text     TEXT,
  modified_at    TEXT,
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  removed_at     TEXT
);

-- One row per artifact (API, IFlow, Event, ...) inside a package.
CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY,          -- <package>::<type>::<name>
  package_name  TEXT NOT NULL REFERENCES packages(technical_name),
  name          TEXT NOT NULL,
  display_name  TEXT,
  type          TEXT NOT NULL,             -- API | IFlow | Event | ...
  sub_type      TEXT,
  version       TEXT,
  reg_id        TEXT,
  description   TEXT,
  modified_at   TEXT,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  removed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_artifacts_pkg  ON artifacts(package_name);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);

-- Immutable snapshot of a specification. A new row appears only when the
-- canonical hash changes, so this table is the version history.
CREATE TABLE IF NOT EXISTS spec_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id  TEXT NOT NULL REFERENCES artifacts(id),
  hub_version  TEXT,
  content_hash TEXT NOT NULL,
  spec_format  TEXT NOT NULL,              -- openapi3 | swagger2 | edmx | unknown
  spec_text    TEXT NOT NULL,
  source       TEXT NOT NULL,              -- hub | import | recorded
  fetched_at   TEXT NOT NULL,
  UNIQUE (artifact_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_spec_versions_artifact ON spec_versions(artifact_id);

-- ---------------------------------------------------------------------------
-- Sync runs and change reports
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sync_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL,           -- running | ok | error
  packages_seen   INTEGER DEFAULT 0,
  artifacts_seen  INTEGER DEFAULT 0,
  added           INTEGER DEFAULT 0,
  changed         INTEGER DEFAULT 0,
  removed         INTEGER DEFAULT 0,
  specs_fetched   INTEGER DEFAULT 0,
  error           TEXT,
  report_path     TEXT
);

CREATE TABLE IF NOT EXISTS changes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  artifact_id     TEXT,
  package_name    TEXT,
  scope           TEXT NOT NULL,           -- package | artifact | spec
  change_type     TEXT NOT NULL,           -- added | changed | removed
  breaking        INTEGER NOT NULL DEFAULT 0,
  from_version    TEXT,
  to_version      TEXT,
  from_spec_id    INTEGER,
  to_spec_id      INTEGER,
  summary         TEXT,
  detail_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_changes_run ON changes(run_id);

-- ---------------------------------------------------------------------------
-- Mock servers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mocks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,      -- mounted at /mock/<slug>
  title         TEXT NOT NULL,
  artifact_id   TEXT REFERENCES artifacts(id),
  spec_id       INTEGER NOT NULL REFERENCES spec_versions(id),
  enabled       INTEGER NOT NULL DEFAULT 1,
  strategy      TEXT NOT NULL DEFAULT 'faker',   -- faker | fixture | ai | proxy
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  error_rate    REAL NOT NULL DEFAULT 0,
  proxy_target  TEXT,
  row_count     INTEGER NOT NULL DEFAULT 25,
  created_at    TEXT NOT NULL
);

-- Materialised rows backing a collection (OData entity set, or the response of
-- one operation). Generated once and reused so test data stays stable.
CREATE TABLE IF NOT EXISTS datasets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mock_id     INTEGER NOT NULL REFERENCES mocks(id) ON DELETE CASCADE,
  collection  TEXT NOT NULL,
  source      TEXT NOT NULL,               -- faker | fixture | ai
  rows_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (mock_id, collection)
);

-- Explicit overrides: pin an exact response for one operation.
CREATE TABLE IF NOT EXISTS overrides (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mock_id       INTEGER NOT NULL REFERENCES mocks(id) ON DELETE CASCADE,
  method        TEXT NOT NULL,
  path_pattern  TEXT NOT NULL,
  status        INTEGER NOT NULL DEFAULT 200,
  headers_json  TEXT,
  body          TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  UNIQUE (mock_id, method, path_pattern)
);

-- ---------------------------------------------------------------------------
-- Traffic log (the F12 network tab)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS traffic (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL,
  mock_slug      TEXT,
  client_ip      TEXT,
  method         TEXT NOT NULL,
  path           TEXT NOT NULL,
  query          TEXT,
  req_headers    TEXT,
  req_body       TEXT,
  req_bytes      INTEGER DEFAULT 0,
  status         INTEGER,
  res_headers    TEXT,
  res_body       TEXT,
  res_bytes      INTEGER DEFAULT 0,
  duration_ms    REAL,
  matched_op     TEXT,
  outcome        TEXT,                     -- ok | no-match | error | proxied
  note           TEXT
);

CREATE INDEX IF NOT EXISTS idx_traffic_ts   ON traffic(ts);
CREATE INDEX IF NOT EXISTS idx_traffic_slug ON traffic(mock_slug);

-- ---------------------------------------------------------------------------
-- Test runs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS test_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  target      TEXT NOT NULL,               -- base URL that was exercised
  mock_id     INTEGER,
  total       INTEGER DEFAULT 0,
  passed      INTEGER DEFAULT 0,
  failed      INTEGER DEFAULT 0,
  status      TEXT NOT NULL                -- running | ok | failed | error
);

CREATE TABLE IF NOT EXISTS test_results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  operation_id TEXT,
  method       TEXT,
  path         TEXT,
  status       INTEGER,
  expected     TEXT,
  passed       INTEGER NOT NULL,
  duration_ms  REAL,
  errors_json  TEXT,
  response_snippet TEXT
);

CREATE INDEX IF NOT EXISTS idx_test_results_run ON test_results(run_id);
