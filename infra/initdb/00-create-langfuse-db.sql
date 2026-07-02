-- Runs once on first postgres boot (fresh volume): give Langfuse its own database
-- so app tables and tracing tables never mix.
CREATE DATABASE langfuse;
