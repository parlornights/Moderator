-- The fingerprint of the PR's own diff (merge base to head), so an approval survives a push that only brings in the base.
ALTER TABLE integrity ADD COLUMN diff_hash TEXT;
