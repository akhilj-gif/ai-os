-- Memory OS Phase 2: Project Memory. Each project is an isolated "universe" —
-- its memories are tagged `project:<slug>` on the existing memory_records store
-- (tags are already GIN-indexed and recall already filters by them), so this
-- needs no parallel store: just a registry of projects + a scoping convention.
-- Isolation is enforced at recall time (global recall excludes project-tagged
-- rows; project recall includes only its own tag).
CREATE TABLE IF NOT EXISTS projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text UNIQUE NOT NULL,
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
