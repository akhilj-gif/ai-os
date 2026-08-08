// Project Memory (Memory OS Phase 2): isolated project "universes". A project
// is a row in `projects`; everything the OS records for it lands on the shared
// memory_records store tagged `project:<slug>` (+ `kind:<kind>`), so recall can
// scope to one project and global recall excludes it (isolation enforced in
// MemoryService.recall via excludeProjects). No parallel store — just a registry
// + a tagging convention, which is the whole point of a unified memory kernel.
import type pg from 'pg';
import { MemoryService } from '@ai-os/memory';
import type { ToolDef } from '../registry.js';

const RECORD_KINDS = ['note', 'decision', 'bug', 'todo', 'milestone', 'architecture'] as const;

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'
  );
}

async function resolveProject(pool: pg.Pool, ref: string): Promise<{ id: string; slug: string; name: string } | null> {
  const q = ref.trim().toLowerCase();
  const { rows } = await pool.query<{ id: string; slug: string; name: string }>(
    `SELECT id, slug, name FROM projects WHERE lower(slug) = $1 OR lower(name) = $1 LIMIT 1`,
    [q],
  );
  return rows[0] ?? null;
}

export const projectCreate: ToolDef = {
  name: 'project_create',
  untrustedOutput: false,
  description:
    'Create an isolated project workspace (its own memory universe). Use when the user starts or refers to a distinct project so its decisions, bugs, todos, and notes never mix with other projects. Returns the project slug to use with the other project_* tools.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Human project name, e.g. "AI OS" or "Portfolio site".' } },
    required: ['name'],
  },
  async execute(args, ctx) {
    const name = String(args.name ?? '').trim();
    if (!name) return { error: 'name is required' };
    const slug = slugify(name);
    const { rows } = await ctx.pool.query<{ id: string; slug: string; name: string; created: boolean }>(
      `INSERT INTO projects (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET updated_at = now()
       RETURNING id, slug, name, (xmax = 0) AS created`,
      [slug, name],
    );
    const p = rows[0]!;
    return { id: p.id, slug: p.slug, name: p.name, created: p.created, note: p.created ? 'project created' : 'project already existed' };
  },
};

export const projectList: ToolDef = {
  name: 'project_list',
  untrustedOutput: false,
  description: 'List the user\'s projects (isolated memory workspaces) with how many memories each holds. Use to find the right project slug before recording or recalling.',
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const { rows } = await ctx.pool.query(
      `SELECT p.slug, p.name, p.status,
              (SELECT count(*) FROM memory_records m WHERE m.tags && ARRAY['project:' || p.slug] AND m.superseded_by IS NULL) AS memories
       FROM projects p ORDER BY p.updated_at DESC LIMIT 50`,
    );
    return { projects: rows };
  },
};

export const projectRecord: ToolDef = {
  name: 'project_record',
  untrustedOutput: false,
  description:
    'Record a fact into a project\'s isolated memory: a decision, bug, todo, milestone, architecture note, or general note. Stored only under that project — it will never surface for other projects. Call this to persist anything worth remembering about a specific project.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project slug or name (from project_list / project_create).' },
      kind: { type: 'string', enum: RECORD_KINDS as unknown as string[], description: 'What kind of item this is.' },
      content: { type: 'string', description: 'The fact to remember, one clear sentence or two.' },
    },
    required: ['project', 'kind', 'content'],
  },
  async execute(args, ctx) {
    const content = String(args.content ?? '').trim();
    const kind = String(args.kind ?? 'note').trim();
    if (!content) return { error: 'content is required' };
    if (!RECORD_KINDS.includes(kind as (typeof RECORD_KINDS)[number])) return { error: `kind must be one of ${RECORD_KINDS.join(', ')}` };
    const proj = await resolveProject(ctx.pool, String(args.project ?? ''));
    if (!proj) return { error: `no such project "${args.project}" — create it with project_create or check project_list` };
    const memory = new MemoryService(ctx.pool);
    const rec = await memory.remember({
      type: 'project',
      content,
      tags: [`project:${proj.slug}`, `kind:${kind}`],
      confidence: 0.9,
      source: { task_id: ctx.taskId, user_stated: true },
    });
    return { ok: true, id: rec.id, project: proj.slug, kind };
  },
};

export const projectRecall: ToolDef = {
  name: 'project_recall',
  untrustedOutput: false,
  description:
    'Recall a project\'s memory — everything recorded for that project, optionally filtered by a query or kind. Returns ONLY that project\'s items (isolated). Use to answer "where are we on <project>", list its open bugs/todos, or resume work.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project slug or name.' },
      query: { type: 'string', description: 'Optional: what to look for (semantic). Omit to list recent items.' },
      kind: { type: 'string', enum: RECORD_KINDS as unknown as string[], description: 'Optional: only this kind (e.g. only "bug" or "todo").' },
    },
    required: ['project'],
  },
  async execute(args, ctx) {
    const proj = await resolveProject(ctx.pool, String(args.project ?? ''));
    if (!proj) return { error: `no such project "${args.project}" — check project_list` };
    const projectTag = `project:${proj.slug}`;
    const kind = args.kind ? String(args.kind) : null;
    const query = String(args.query ?? '').trim();

    if (query) {
      const memory = new MemoryService(ctx.pool);
      const hits = await memory.recall({ query, tags: [projectTag], limit: 20, minRelevance: 0.1 });
      const filtered = kind ? hits.filter((h) => h.tags.includes(`kind:${kind}`)) : hits;
      return { project: proj.slug, items: filtered.map((h) => ({ kind: (h.tags.find((t) => t.startsWith('kind:')) ?? 'kind:note').slice(5), content: h.content, score: Number(h.score?.toFixed?.(3) ?? 0) })) };
    }
    // No query → list most recent items for the project (optionally by kind).
    const params: unknown[] = [projectTag];
    let where = `tags && ARRAY[$1] AND superseded_by IS NULL`;
    if (kind) {
      params.push(`kind:${kind}`);
      where += ` AND tags && ARRAY[$2]`;
    }
    const { rows } = await ctx.pool.query(
      `SELECT content, tags, created_at FROM memory_records WHERE ${where} ORDER BY created_at DESC LIMIT 30`,
      params,
    );
    return {
      project: proj.slug,
      items: rows.map((r: { content: string; tags: string[] }) => ({ kind: (r.tags.find((t) => t.startsWith('kind:')) ?? 'kind:note').slice(5), content: r.content })),
    };
  },
};
