-- M3 Memory v1 (blueprint §7, ADR-0006). memory_records exists from 0001 with a
-- dimensionless vector; pin it, add hybrid-search + conflict-resolution columns.

-- Table is empty pre-M3, so retyping the vector column is safe.
ALTER TABLE memory_records ALTER COLUMN embedding TYPE vector(768);

-- subject: a short stable key for conflict resolution / supersession (e.g.
-- 'reply-style', 'kb-location'). Writing a new active record with the same
-- subject supersedes the prior one (never a silent overwrite, §7.2).
ALTER TABLE memory_records ADD COLUMN subject text;

-- tags: project/domain scoping (blueprint §7.1 project store "loaded by project tag").
ALTER TABLE memory_records ADD COLUMN tags text[] NOT NULL DEFAULT '{}';

-- Full-text vector for the keyword half of hybrid retrieval.
ALTER TABLE memory_records
  ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

-- Indexes over ACTIVE records only (superseded/expired never rank).
CREATE INDEX memory_tsv_idx ON memory_records USING gin (content_tsv);
CREATE INDEX memory_subject_idx ON memory_records (subject) WHERE superseded_by IS NULL;
CREATE INDEX memory_tags_idx ON memory_records USING gin (tags);
CREATE INDEX memory_embedding_idx
  ON memory_records USING hnsw (embedding vector_cosine_ops)
  WHERE superseded_by IS NULL;
