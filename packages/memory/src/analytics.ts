// Memory Analytics (Memory OS Phase 5): a single snapshot of the cognitive
// store's health — sizes, kinds, confidence distribution, growth, graph size,
// open contradictions — for the dashboard. All read-only aggregates.
import type pg from 'pg';
import { graphStats } from './graph.js';

export interface MemoryAnalytics {
  total: number;
  superseded: number;
  byType: Record<string, number>;
  confidence: { high: number; medium: number; low: number };
  createdLast7d: number;
  projects: number;
  workingMemory: number;
  contradictions: number;
  skills: number;
  knownIssues: number;
  graph: { nodes: number; edges: number; topNodes: Array<{ name: string; kind: string; mentions: number }> };
}

export async function memoryAnalytics(pool: pg.Pool): Promise<MemoryAnalytics> {
  const one = async (sql: string, params: unknown[] = []): Promise<number> => Number((await pool.query(sql, params)).rows[0]?.n ?? 0);

  const byTypeRows = (
    await pool.query<{ type: string; n: string }>(
      `SELECT type, count(*) AS n FROM memory_records WHERE superseded_by IS NULL GROUP BY type ORDER BY n DESC`,
    )
  ).rows;
  const byType = Object.fromEntries(byTypeRows.map((r) => [r.type, Number(r.n)]));

  const conf = (
    await pool.query<{ high: string; medium: string; low: string }>(
      `SELECT
         count(*) FILTER (WHERE confidence >= 0.7) AS high,
         count(*) FILTER (WHERE confidence >= 0.4 AND confidence < 0.7) AS medium,
         count(*) FILTER (WHERE confidence < 0.4) AS low
       FROM memory_records WHERE superseded_by IS NULL`,
    )
  ).rows[0]!;

  const [total, superseded, createdLast7d, projects, workingMemory, contradictionRows, skills, knownIssues, graph] = await Promise.all([
    one(`SELECT count(*) AS n FROM memory_records WHERE superseded_by IS NULL`),
    one(`SELECT count(*) AS n FROM memory_records WHERE superseded_by IS NOT NULL`),
    one(`SELECT count(*) AS n FROM memory_records WHERE created_at > now() - interval '7 days'`),
    one(`SELECT count(*) AS n FROM projects`),
    one(`SELECT count(*) AS n FROM working_memory`),
    pool.query(
      `SELECT count(DISTINCT subject) AS n FROM memory_records
       WHERE superseded_by IS NULL AND type='semantic' AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE 'conflict:%')`,
    ),
    one(`SELECT count(*) AS n FROM memory_records WHERE superseded_by IS NULL AND type='procedural' AND subject LIKE 'skill:%'`),
    one(`SELECT count(*) AS n FROM memory_records WHERE superseded_by IS NULL AND 'known-issue' = ANY(tags)`),
    graphStats(pool),
  ]);

  return {
    total,
    superseded,
    byType,
    confidence: { high: Number(conf.high), medium: Number(conf.medium), low: Number(conf.low) },
    createdLast7d,
    projects,
    workingMemory,
    contradictions: Number(contradictionRows.rows[0]?.n ?? 0),
    skills,
    knownIssues,
    graph,
  };
}
