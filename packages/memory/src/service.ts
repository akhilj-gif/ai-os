// Memory Service (blueprint §7, ADR-0006). Typed CRUD over memory_records with
// mandatory provenance, subject-based conflict resolution (never silent
// overwrite), confidence + recency-weighted hybrid retrieval, and decay.
import type pg from 'pg';
import { embedOne } from '@ai-os/model-router';

export type MemoryType = 'episodic' | 'semantic' | 'preference' | 'procedural' | 'project' | 'document' | 'failure';

export interface MemorySource {
  task_id?: string;
  tool_call_id?: string;
  user_stated?: boolean;
}

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  content: string;
  source: MemorySource;
  confidence: number;
  subject: string | null;
  tags: string[];
  created_at: Date;
  last_confirmed_at: Date;
  expires_at: Date | null;
  superseded_by: string | null;
}

export interface RememberInput {
  type: MemoryType;
  content: string;
  source: MemorySource; // provenance is mandatory (§7.2)
  subject?: string;
  tags?: string[];
  confidence?: number;
  expiresAt?: Date | null;
}

export interface RecallOptions {
  query: string;
  types?: MemoryType[];
  tags?: string[];
  limit?: number;
  minRelevance?: number;
  /** Project isolation: when true, records tagged `project:<slug>` are excluded
   *  (global recall). Project-scoped recall instead passes tags: ['project:<slug>']. */
  excludeProjects?: boolean;
}

export interface RecalledMemory extends MemoryRecord {
  relevance: number;
  recency: number;
  score: number;
}

const HALFLIFE_DAYS = 30; // recency weight halves every 30 days (retrieval down-ranks stale)
const DEFAULT_LIMIT = 8;
const DEFAULT_MIN_RELEVANCE = 0.25;

function vecLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

export class MemoryService {
  constructor(private readonly pool: pg.Pool) {}

  /** Store a memory. Provenance required. If `subject` is set, this supersedes any
   *  active record with the same (type, subject) — auditable, never overwritten. */
  async remember(m: RememberInput): Promise<MemoryRecord> {
    if (!m.source.task_id && !m.source.tool_call_id && !m.source.user_stated) {
      throw new Error('MemorySource must cite a task, a tool call, or an explicit user statement (§7.2)');
    }
    let embedding: number[] | null = null;
    try {
      embedding = await embedOne(m.content);
    } catch (err) {
      // Best-effort: a record with no embedding still keyword-matches (ADR-0006).
      console.warn('[memory] embed failed, storing without vector:', err instanceof Error ? err.message : err);
    }

    const { rows } = await this.pool.query(
      `INSERT INTO memory_records (type, content, embedding, source, confidence, subject, tags, expires_at)
       VALUES ($1, $2, ${embedding ? '$8::vector' : 'NULL'}, $3, $4, $5, $6, $7)
       RETURNING id, type, content, source, confidence, subject, tags, created_at, last_confirmed_at, expires_at, superseded_by`,
      embedding
        ? [m.type, m.content, JSON.stringify(m.source), m.confidence ?? 1.0, m.subject ?? null, m.tags ?? [], m.expiresAt ?? null, vecLiteral(embedding)]
        : [m.type, m.content, JSON.stringify(m.source), m.confidence ?? 1.0, m.subject ?? null, m.tags ?? [], m.expiresAt ?? null],
    );
    const rec = rows[0] as MemoryRecord;

    if (m.subject) {
      // Contradiction detection (§16): an AUTO-EXTRACTED fact that materially
      // disagrees with an existing same-subject fact must NOT silently overwrite
      // it. Flag both (tag `conflict:<subject>`) and leave both active so the
      // assistant asks the user which is current. Only semantic facts, and only
      // when the new one wasn't the user explicitly stating it — an explicit
      // user statement RESOLVES the conflict (falls through to supersede).
      let flaggedConflict = false;
      if (m.type === 'semantic' && !m.source.user_stated) {
        // A subject-keyed fact is single-valued, so a DIFFERENT existing value
        // for the same subject is a contradiction — even when the two sentences
        // embed almost identically ("lives in Delhi" vs "lives in Hyderabad"),
        // which is exactly why cosine is the wrong test here. Compare content:
        // conflict when neither string contains the other (a substring is just a
        // rephrase/refinement → supersede, not a conflict).
        const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
        const nNew = norm(m.content);
        const existing = await this.pool.query<{ content: string }>(
          `SELECT content FROM memory_records
           WHERE subject = $1 AND type = 'semantic' AND superseded_by IS NULL AND id <> $2`,
          [m.subject, rec.id],
        );
        const clashes = existing.rows.some((r) => {
          const nOld = norm(r.content);
          return nOld !== nNew && !nOld.includes(nNew) && !nNew.includes(nOld);
        });
        if (clashes) {
          await this.pool.query(
            `UPDATE memory_records
             SET tags = array(SELECT DISTINCT unnest(tags || ARRAY[$2]))
             WHERE subject = $1 AND type = 'semantic' AND superseded_by IS NULL`,
            [m.subject, `conflict:${m.subject}`],
          );
          flaggedConflict = true;
        }
      }
      if (!flaggedConflict) {
        // Normal conflict resolution: point prior active same-(type,subject)
        // records at the new one (an explicit user statement lands here too,
        // resolving any earlier flagged conflict since only the winner survives).
        await this.pool.query(
          `UPDATE memory_records SET superseded_by = $1
           WHERE subject = $2 AND type = $3 AND superseded_by IS NULL AND id <> $1`,
          [rec.id, m.subject, m.type],
        );
      }
    }
    return rec;
  }

  /** Hybrid retrieval: relevance (cosine ⋁ keyword) × confidence × recency, top-k.
   *  Falls back to keyword-only if the query can't be embedded (ADR-0006). */
  async recall(opts: RecallOptions): Promise<RecalledMemory[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const minRel = opts.minRelevance ?? DEFAULT_MIN_RELEVANCE;
    let queryVec: number[] | null = null;
    // Perf (2026-07-16): a 1-2 word query ("hi", "thanks", "ok", "yes") carries
    // no semantic signal worth an ~800ms embedding round-trip — and this sits on
    // the reply's critical path (memory context is injected before the model
    // call). Skip the embed for such queries and let the keyword (ts_rank) path
    // below serve any literal match; real recall queries are full sentences
    // (≥3 words) and still embed. Cuts ~800ms off greetings/acknowledgements.
    const worthEmbedding = opts.query.trim().split(/\s+/).filter(Boolean).length >= 3;
    if (worthEmbedding) {
      try {
        queryVec = await embedOne(opts.query);
      } catch {
        queryVec = null; // keyword-only fallback
      }
    }

    // NB the keyword-only branch must not leave an unreferenced $1 in params:
    // Postgres cannot infer the type of a parameter no SQL expression touches
    // ("could not determine data type of parameter $1") — hit live 2026-07-16
    // when the short-query fast path made queryVec=null the COMMON case, and
    // the throw took the WHOLE memory block (preferences included) with it.
    const relExpr = queryVec
      ? `GREATEST(1 - (embedding <=> $1::vector), COALESCE(ts_rank(content_tsv, plainto_tsquery('english', $2)) * 4, 0))`
      : `COALESCE(ts_rank(content_tsv, plainto_tsquery('english', $1)) * 4, 0)`;

    const params: unknown[] = queryVec ? [vecLiteral(queryVec), opts.query] : [opts.query];
    let p = params.length;
    const typeClause = opts.types?.length ? `AND type = ANY($${++p}::memory_type[])` : '';
    if (opts.types?.length) params.push(opts.types);
    const tagClause = opts.tags?.length ? `AND tags && $${++p}::text[]` : '';
    if (opts.tags?.length) params.push(opts.tags);
    // Project isolation: exclude any record carrying a `project:*` tag so one
    // project's universe never bleeds into global (or another project's) recall.
    const projectClause = opts.excludeProjects ? `AND NOT EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE 'project:%')` : '';
    const minRelP = `$${++p}`;
    params.push(minRel);
    const limitP = `$${++p}`;
    params.push(limit);

    const sql = `
      WITH scored AS (
        SELECT id, type, content, source, confidence, subject, tags, created_at, last_confirmed_at, expires_at, superseded_by,
          ${relExpr} AS relevance,
          exp(-EXTRACT(EPOCH FROM now() - last_confirmed_at) / 86400.0 / ${HALFLIFE_DAYS}) AS recency
        FROM memory_records
        WHERE superseded_by IS NULL
          AND (expires_at IS NULL OR expires_at > now())
          ${typeClause}
          ${tagClause}
          ${projectClause}
      )
      SELECT *, (relevance * confidence * recency) AS score
      FROM scored
      WHERE relevance >= ${minRelP}
      ORDER BY score DESC
      LIMIT ${limitP}`;

    const { rows } = await this.pool.query(sql, params);
    return rows as RecalledMemory[];
  }

  /** Always-loaded preference memory (small set — blueprint §7.3). */
  async getPreferences(limit = 25): Promise<MemoryRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT id, type, content, source, confidence, subject, tags, created_at, last_confirmed_at, expires_at, superseded_by
       FROM memory_records
       WHERE type = 'preference' AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > now())
       ORDER BY last_confirmed_at DESC LIMIT $1`,
      [limit],
    );
    return rows as MemoryRecord[];
  }

  /** Reinforce a confirmed memory: refresh recency and nudge confidence up. */
  async reinforce(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE memory_records
       SET last_confirmed_at = now(), confidence = LEAST(1.0, confidence + 0.1)
       WHERE id = $1`,
      [id],
    );
  }

  async list(opts: { includeSuperseded?: boolean; limit?: number } = {}): Promise<MemoryRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT id, type, content, source, confidence, subject, tags, created_at, last_confirmed_at, expires_at, superseded_by
       FROM memory_records
       ${opts.includeSuperseded ? '' : 'WHERE superseded_by IS NULL'}
       ORDER BY created_at DESC LIMIT $1`,
      [opts.limit ?? 500],
    );
    return rows as MemoryRecord[];
  }

  /** Unresolved contradictions (§16): subjects with ≥2 active semantic facts
   *  flagged `conflict:*`. The assistant surfaces these and asks which is
   *  current; an explicit user statement (remember with user_stated) resolves. */
  async getContradictions(): Promise<Array<{ subject: string; options: string[] }>> {
    const { rows } = await this.pool.query<{ subject: string; options: string[] }>(
      `SELECT subject, array_agg(content ORDER BY last_confirmed_at DESC) AS options
       FROM memory_records
       WHERE superseded_by IS NULL AND type = 'semantic' AND subject IS NOT NULL
         AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE 'conflict:%')
       GROUP BY subject HAVING count(*) >= 2`,
    );
    return rows;
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM memory_records WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
