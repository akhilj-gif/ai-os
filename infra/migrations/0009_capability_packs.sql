-- M9 Capability Packs (ADR-0012). Manifests live in code (@ai-os/packs);
-- this table holds INSTALL STATE only. Seed the three packs that reproduce the
-- pre-M9 tool surface, so nothing changes behavior at migration time.
-- support-ops is deliberately NOT seeded: it is installed live through the API,
-- proving "a new capability installs without kernel changes" (blueprint M9 exit).
CREATE TABLE capability_packs (
  name            text PRIMARY KEY,
  version         text NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  install_task_id uuid REFERENCES tasks (id),
  installed_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO capability_packs (name, version) VALUES
  ('google',   '1.0.0'),
  ('research', '1.0.0'),
  ('coding',   '1.0.0');
