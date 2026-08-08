-- Memory OS Phase 3: Knowledge Graph. Vectors + keyword answer "what's similar";
-- the graph answers "what's connected" (Akhil → owns → AI OS → uses → Gemini),
-- which enables relational reasoning the embedding store can't. Nodes are
-- entities (people/projects/tools/files/orgs/concepts), edges are typed
-- relations. Auto-populated from task text; queried by name; its neighborhood
-- is injected into task context. Deliberately small + denormalized — a
-- reasoning aid over the same memory kernel, not a separate graph database.
CREATE TABLE IF NOT EXISTS kg_nodes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL DEFAULT 'other',
  name         text NOT NULL,
  norm         text NOT NULL UNIQUE,           -- lowercased/trimmed key for dedup + lookup
  mentions     int  NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kg_edges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  src          uuid NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  rel          text NOT NULL,
  dst          uuid NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  weight       int  NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (src, rel, dst)
);

CREATE INDEX IF NOT EXISTS kg_edges_src_idx ON kg_edges (src);
CREATE INDEX IF NOT EXISTS kg_edges_dst_idx ON kg_edges (dst);
CREATE INDEX IF NOT EXISTS kg_nodes_norm_trgm_idx ON kg_nodes (norm);
