ALTER TABLE integrity RENAME COLUMN approved_by TO decided_by;
ALTER TABLE integrity RENAME COLUMN approved_at TO decided_at;
ALTER TABLE integrity ADD COLUMN reason TEXT;
