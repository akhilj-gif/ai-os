// Memory Service (blueprint §7, ADR-0006). Typed CRUD over memory_records with
// mandatory provenance, subject-based conflict resolution (never silent
// overwrite), confidence + recency-weighted hybrid retrieval, and decay.
import type pg from 'pg';
import { embedOne } from '@ai-os/model-router';

export type MemoryType = 'episodic' | 'semantic' | 'preference' | 'procedural' | 'project' | 'document';

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
      // Conflict resolution: point prior active same-(type,subject) records at the new one.
      await this.pool.query(
        `UPDATE memory_records SET superseded_by = $1
         WHERE subject = $2 AND type = $3 AND superseded_by IS NULL AND id <> $1`,
        [rec.id, m.subject, m.type],
      );
    }
    return rec;
  }

  /** Hybrid retrieval: relevance (cosine ⋁ keyword) × confidence × recency, top-k.
   *  Falls back to keyword-only if the query can't be embedded (ADR-0006). */
  async recall(opts: RecallOptions): Promise<RecalledMemory[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const minRel = opts.minRelevance ?? DEFAULT_MIN_RELEVANCE;
    let queryVec: number[] | null = null;
    try {
      queryVec = await embedOne(opts.query);
    } catch {
      queryVec = null; // keyword-only fallback
    }

    const relExpr = queryVec
      ? `GREATEST(1 - (embedding <=> $1::vector), COALESCE(ts_rank(content_tsv, plainto_tsquery('english', $2)) * 4, 0))`
      : `COALESCE(ts_rank(content_tsv, plainto_tsquery('english', $2)) * 4, 0)`;

    const params: unknown[] = queryVec ? [vecLiteral(queryVec), opts.query] : [null, opts.query];
    let p = params.length;
    const typeClause = opts.types?.length ? `AND type = ANY($${++p}::memory_type[])` : '';
    if (opts.types?.length) params.push(opts.types);
    const tagClause = opts.tags?.length ? `AND tags && $${++p}::text[]` : '';
    if (opts.tags?.length) params.push(opts.tags);
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

  async remove(id: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM memory_records WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }
}
