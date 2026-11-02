-- A key names a mutable fact ("deploy/current"). At most one active memory per project holds it;
-- superseding or archiving a memory releases its key (the index is partial) while the row keeps it
-- as history. Keys stay plaintext under encryption, like tags and paths.
ALTER TABLE memories ADD COLUMN key text
  CHECK (key IS NULL OR key ~ '^[a-z0-9][a-z0-9._/:-]{0,79}$');
CREATE UNIQUE INDEX memories_active_key_idx ON memories (project_id, key) WHERE status = 'active';
