-- Test files whose flagged changes the owner approved on a PR and base, by their content: the approval carries to a
-- later commit of that PR whose copy of the file has the same changes (owner, Q48 A).
CREATE TABLE approved_files (
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  base_ref TEXT NOT NULL,
  hash TEXT NOT NULL,
  file TEXT NOT NULL,
  sha TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  PRIMARY KEY (repo, pr, base_ref, hash)
);
-- Each run's test files with their fingerprints, so an approval records the files exactly as they were.
ALTER TABLE integrity ADD COLUMN test_files TEXT;
