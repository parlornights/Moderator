-- The commit whose PR comment told the owner about this run's pending findings. A later run with the same findings
-- stays quiet only when the comment was actually posted.
ALTER TABLE integrity ADD COLUMN notified TEXT;
