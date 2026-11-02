-- Title, body and source may be stored encrypted (AES-256-GCM, base64) by the app; `encrypted` marks those rows.
ALTER TABLE memories ADD COLUMN encrypted boolean NOT NULL DEFAULT false;

-- Ciphertext is longer than a title may be; plaintext titles keep the limit.
ALTER TABLE memories DROP CONSTRAINT memories_title_check;
ALTER TABLE memories ADD CONSTRAINT memories_title_check
  CHECK (encrypted OR char_length(title) BETWEEN 1 AND 120);

-- Ciphertext must not be indexed as words: encrypted rows keep only their (plaintext) tags and paths
-- in the keyword lane, and are otherwise found by vector search.
ALTER TABLE memories DROP COLUMN fts;
ALTER TABLE memories ADD COLUMN fts tsvector GENERATED ALWAYS AS (
  CASE WHEN encrypted THEN
    setweight(to_tsvector('simple', axon_join(tags) || ' ' || axon_join(paths)), 'B')
  ELSE
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('simple', axon_join(tags) || ' ' || axon_join(paths)), 'B') ||
    setweight(to_tsvector('simple', body), 'C')
  END
) STORED;
CREATE INDEX memories_fts_idx ON memories USING gin (fts);

CREATE INDEX memories_encrypted_idx ON memories (id) WHERE encrypted;
