-- Links are stored once, canonically (a_id < b_id). Most queries want them from one memory's point of
-- view instead: "the links of m, and the memory at the other end". memory_edges lists every link in
-- both directions, so those queries join on `src` rather than repeating
-- `l.a_id = m.id OR l.b_id = m.id` and `CASE WHEN l.a_id = m.id THEN l.b_id ELSE l.a_id END`.
-- A filter on src reaches each branch of the UNION ALL, where it uses the primary key (a_id, ...)
-- or memory_links_b_idx.
CREATE VIEW memory_edges AS
  SELECT project_id, a_id AS src, b_id AS dst, note, weight, created_at, last_traversed_at FROM memory_links
  UNION ALL
  SELECT project_id, b_id AS src, a_id AS dst, note, weight, created_at, last_traversed_at FROM memory_links;
