// Knowledge Graph (Memory OS Phase 3). Extracts entities + typed relations from
// task text and upserts them into kg_nodes / kg_edges, so the OS can reason over
// CONNECTIONS ("who owns what", "what uses what") — not just semantic similarity.
// Best-effort + fire-and-forget, like the other capture paths: never blocks a task.
import type pg from 'pg';
import { callModel } from '@ai-os/model-router';

const KINDS = ['person', 'project', 'tool', 'file', 'org', 'concept', 'event', 'other'];

const SYSTEM = `Extract a small knowledge graph from a personal AI-OS exchange.
Return ONLY JSON: {"entities":[{"name","kind"}],"relations":[{"src","rel","dst"}]}.
- kind ∈ ${KINDS.join('|')}. Use canonical names ("AI OS", "Gemini", "Akhil"), not pronouns.
- rel is a short lowercase verb phrase ("owns","uses","hosted on","works at","depends on","assigned to").
- src/dst MUST be names that also appear in entities. Prefer few, durable, factual edges.
- Skip transient/one-off trivia. If nothing durable, return {"entities":[],"relations":[]}.`;

interface Graph {
  entities?: Array<{ name?: string; kind?: string }>;
  relations?: Array<{ src?: string; rel?: string; dst?: string }>;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);

async function upsertNode(pool: pg.Pool, name: string, kind: string): Promise<string | null> {
  const n = norm(name);
  if (!n) return null;
  const k = KINDS.includes(kind) ? kind : 'other';
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO kg_nodes (kind, name, norm) VALUES ($1, $2, $3)
     ON CONFLICT (norm) DO UPDATE SET mentions = kg_nodes.mentions + 1, last_seen_at = now(),
       kind = CASE WHEN kg_nodes.kind = 'other' THEN EXCLUDED.kind ELSE kg_nodes.kind END
     RETURNING id`,
    [k, name.trim().slice(0, 120), n],
  );
  return rows[0]?.id ?? null;
}

/** Extract + persist the knowledge graph for a finished exchange. Returns
 *  {nodes, edges} counts touched. */
export async function updateKnowledgeGraph(
  pool: pg.Pool,
  opts: { taskId: string; traceId: string; userText: string; assistantText: string },
): Promise<{ nodes: number; edges: number }> {
  try {
    const res = await callModel({
      role: 'routing',
      system: SYSTEM,
      prompt: `USER:\n${opts.userText.slice(0, 900)}\n\nASSISTANT:\n${opts.assistantText.slice(0, 900)}`,
      maxTokens: 400,
      traceId: opts.traceId,
      taskId: opts.taskId,
      name: 'kg-extract',
    });
    const json = res.text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return { nodes: 0, edges: 0 };
    const g = JSON.parse(json) as Graph;

    const ids = new Map<string, string>(); // norm(name) → node id
    for (const e of g.entities ?? []) {
      if (!e.name?.trim()) continue;
      const id = await upsertNode(pool, e.name, e.kind ?? 'other');
      if (id) ids.set(norm(e.name), id);
    }

    let edges = 0;
    for (const r of g.relations ?? []) {
      if (!r.src?.trim() || !r.dst?.trim() || !r.rel?.trim()) continue;
      // Upsert endpoints on the fly too (a relation may reference an entity the
      // LLM forgot to list). Keeps the graph consistent.
      const s = ids.get(norm(r.src)) ?? (await upsertNode(pool, r.src, 'other'));
      const d = ids.get(norm(r.dst)) ?? (await upsertNode(pool, r.dst, 'other'));
      if (!s || !d || s === d) continue;
      await pool.query(
        `INSERT INTO kg_edges (src, rel, dst) VALUES ($1, $2, $3)
         ON CONFLICT (src, rel, dst) DO UPDATE SET weight = kg_edges.weight + 1, last_seen_at = now()`,
        [s, norm(r.rel), d],
      );
      edges++;
    }
    return { nodes: ids.size, edges };
  } catch (err) {
    console.warn('[memory] knowledge-graph update failed (non-fatal):', err instanceof Error ? err.message : err);
    return { nodes: 0, edges: 0 };
  }
}

export interface GraphRelation {
  subject: string;
  rel: string;
  object: string;
  weight: number;
}

/** Relations touching any node whose name matches `name` (substring, case-insensitive).
 *  Returned as readable subject-rel-object triples for context/tooling. */
export async function graphNeighborhood(pool: pg.Pool, name: string, limit = 12): Promise<GraphRelation[]> {
  const q = norm(name);
  if (!q) return [];
  const { rows } = await pool.query<GraphRelation>(
    `SELECT s.name AS subject, e.rel AS rel, d.name AS object, e.weight AS weight
     FROM kg_edges e JOIN kg_nodes s ON s.id = e.src JOIN kg_nodes d ON d.id = e.dst
     WHERE s.norm LIKE '%' || $1 || '%' OR d.norm LIKE '%' || $1 || '%'
     ORDER BY e.weight DESC, e.last_seen_at DESC
     LIMIT $2`,
    [q, limit],
  );
  return rows;
}

/** Any relations whose subject or object name appears in the given text — the
 *  auto-context path (no explicit entity needed). Matches known node names
 *  against the goal so the graph surfaces itself when relevant. */
export async function graphForText(pool: pg.Pool, text: string, limit = 8): Promise<GraphRelation[]> {
  const t = text.toLowerCase();
  // Candidate nodes: those whose (multi-word or ≥4-char) name appears in the text.
  const { rows: nodes } = await pool.query<{ norm: string }>(
    `SELECT norm FROM kg_nodes WHERE length(norm) >= 4 ORDER BY mentions DESC LIMIT 200`,
  );
  const hit = nodes.find((n) => t.includes(n.norm));
  if (!hit) return [];
  return graphNeighborhood(pool, hit.norm, limit);
}

export async function graphStats(pool: pg.Pool): Promise<{ nodes: number; edges: number; topNodes: Array<{ name: string; kind: string; mentions: number }> }> {
  const nodes = Number((await pool.query(`SELECT count(*) AS n FROM kg_nodes`)).rows[0]?.n ?? 0);
  const edges = Number((await pool.query(`SELECT count(*) AS n FROM kg_edges`)).rows[0]?.n ?? 0);
  const topNodes = (await pool.query(`SELECT name, kind, mentions FROM kg_nodes ORDER BY mentions DESC LIMIT 8`)).rows as Array<{ name: string; kind: string; mentions: number }>;
  return { nodes, edges, topNodes };
}
