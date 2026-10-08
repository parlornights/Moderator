CREATE TABLE integrity (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  pr INTEGER NOT NULL,
  title TEXT NOT NULL,
  issue TEXT,
  state TEXT NOT NULL,
  findings TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  PRIMARY KEY (repo, sha)
);
