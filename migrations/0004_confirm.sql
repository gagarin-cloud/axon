-- Freshness: when a memory was last asserted true (written, edited or confirmed), and when it was
-- flagged as probably wrong. Existing memories count as confirmed when they were written.
-- A dispute carries no free-text note, so nothing here adds to what encryption has to cover.
ALTER TABLE memories ADD COLUMN confirmed_at timestamptz;
UPDATE memories SET confirmed_at = created_at;
ALTER TABLE memories ALTER COLUMN confirmed_at SET DEFAULT now(), ALTER COLUMN confirmed_at SET NOT NULL;

ALTER TABLE memories ADD COLUMN disputed_at timestamptz;
