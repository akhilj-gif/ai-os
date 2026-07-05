# ADR-0006 — Memory embeddings & retrieval (M3)

**Date:** 2026-07-05 · **Status:** Accepted · **Resolves:** the M0 deferral (ADR-0001 #4)

## Decisions

1. **Embedding model: `gemini-embedding-001` truncated to 768 dims** (Matryoshka
   `dimensions: 768` via Gemini's OpenAI-compatible `/embeddings` endpoint). Rationale:
   we already hold a Gemini key; free tier; 768 is under pgvector's 2000-dim ANN limit
   (the 3072 default is not), compact (~3KB/row), and retrieval-quality is ample at this
   scale. `memory_records.embedding` becomes `vector(768)`.
2. **Embeddings always go to Gemini**, independent of `MODEL_PROVIDER` (Groq/xAI don't
   serve embeddings). `embed()` in the model-router uses `GEMINI_API_KEY` directly. If we
   ever move generation off Gemini, add a matching embedding provider (Voyage/OpenAI) here.
3. **Hybrid retrieval.** Rank candidates by `relevance × confidence × recency`:
   - relevance = cosine similarity (pgvector `<=>`) OR a keyword (tsvector) match when the
     query is lexical — we union both and take the max relevance per record (blueprint §7.1
     "document store = hybrid search", generalized to all types).
   - confidence = the record's stored 0..1 (decays for unconfirmed facts).
   - recency = `exp(-ageDays / HALFLIFE)` so stale records sink without vanishing.
   Take top-k until the caller's token budget is spent.
4. **Exact scan now, HNSW index present for later.** A partial HNSW cosine index on active
   rows is created, but at personal-OS scale (hundreds–thousands of memories) exact scan is
   already sub-ms; the index simply future-proofs. Partial (`WHERE superseded_by IS NULL`)
   so superseded/expired rows never rank.
5. **Conflict resolution by `subject`.** Preference/semantic records carry a short `subject`
   key (e.g. `reply-style`, `kb-location`). Writing a new record with an existing active
   subject **supersedes** the old one (`superseded_by`) — never a silent overwrite; the
   chain stays auditable (blueprint §7.2).

## Consequences

- One embedding call per stored memory and per recall query. Best-effort: an embedding
  failure degrades recall to keyword-only rather than breaking the task.
- Baselines/evals that touch memory are embedding-model-specific; re-embed if the model changes.
- The reflection job (nightly) owns decay, dedup (cosine > 0.95 merge), and expiry.
