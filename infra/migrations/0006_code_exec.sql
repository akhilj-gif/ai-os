-- M6 Coding engine: code_exec runs code in the Docker sandbox. Classed 'write'
-- (it's an action) but auto — the SANDBOX is the safety boundary (no net, no host
-- FS, non-root, limits). The structural gate still blocks it when untrusted
-- content is in context (an injected "run this" is refused, §8.3).
INSERT INTO trust_policies (tool, trust_class, auto_approve) VALUES ('code_exec', 'write', true)
  ON CONFLICT (tool) DO NOTHING;
