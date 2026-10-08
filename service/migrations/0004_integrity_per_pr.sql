-- A decision belongs to one PR, one base branch and one commit; flagged hunks stay flagged across a PR's commits.
DROP TABLE integrity;
CREATE TABLE integrity (
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  issue TEXT,
  state TEXT NOT NULL,
  result TEXT NOT NULL,
  findings TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  reason TEXT,
  PRIMARY KEY (repo, pr, sha)
);
CREATE TABLE flags (
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (repo, pr, hash)
);
