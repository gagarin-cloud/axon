CREATE EXTENSION IF NOT EXISTS vector;

-- array_to_string is only STABLE; generated columns need IMMUTABLE.
CREATE FUNCTION axon_join(text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN coalesce(array_to_string($1, ' '), '');

CREATE TABLE meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9._/-]{0,127}$'),
  next_seq   integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memories (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id       uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  seq              integer NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('overview', 'architecture', 'decision', 'convention', 'gotcha', 'howto', 'reference', 'state')),
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body             text NOT NULL,
  tags             text[] NOT NULL DEFAULT '{}',
  paths            text[] NOT NULL DEFAULT '{}',
  pinned           boolean NOT NULL DEFAULT false,
  importance       smallint NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived')),
  superseded_by    bigint REFERENCES memories (id) ON DELETE SET NULL,
  tokens           integer NOT NULL,
  source           text,
  -- Untyped so the embedding model (and its dimension) can change; the HNSW index is an
  -- expression index on embedding::vector(<dim>), managed by the app for the configured model.
  embedding        vector,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_accessed_at timestamptz,
  access_count     integer NOT NULL DEFAULT 0,
  fts              tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('simple', axon_join(tags) || ' ' || axon_join(paths)), 'B') ||
    setweight(to_tsvector('simple', body), 'C')
  ) STORED,
  UNIQUE (project_id, seq),
  UNIQUE (project_id, id)
);

CREATE INDEX memories_project_status_idx ON memories (project_id, status);
CREATE INDEX memories_fts_idx ON memories USING gin (fts);
CREATE INDEX memories_tags_idx ON memories USING gin (tags);
CREATE INDEX memories_paths_idx ON memories USING gin (paths);

-- Undirected associations between memories. Canonical ordering (a_id < b_id) makes A–B and B–A
-- the same row and rules out self-links; the composite foreign keys keep both ends in one project.
CREATE TABLE memory_links (
  project_id        uuid NOT NULL,
  a_id              bigint NOT NULL,
  b_id              bigint NOT NULL,
  note              text CHECK (note IS NULL OR char_length(note) <= 80),
  weight            real NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_traversed_at timestamptz,
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id),
  FOREIGN KEY (project_id, a_id) REFERENCES memories (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, b_id) REFERENCES memories (project_id, id) ON DELETE CASCADE
);

CREATE INDEX memory_links_b_idx ON memory_links (b_id);

-- Hebbian link strength: extra weight earned by traversal decays back towards 1
-- with a 60-day half-life since the link was last traversed.
CREATE FUNCTION axon_link_strength(weight real, last_traversed_at timestamptz, created_at timestamptz)
  RETURNS double precision
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN 1 + (weight - 1) * power(0.5, extract(epoch FROM now() - coalesce(last_traversed_at, created_at)) / 86400 / 60);
