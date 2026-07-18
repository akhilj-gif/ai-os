// Filesystem workspace, scoped per task (blueprint §8.2: the filesystem tool is
// scoped to per-task workspaces — never the host FS at large).
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import type { ToolDef, ToolContext } from '../registry.js';

function workspaceDir(ctx: ToolContext): string {
  const root = process.env.AIOS_WORKSPACES_DIR ?? join(process.cwd(), 'workspaces');
  const dir = join(root, ctx.taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safePath(ctx: ToolContext, p: string): string {
  const base = workspaceDir(ctx);
  const full = resolve(base, p);
  const rel = relative(base, full);
  // Containment check. `isAbsolute(rel)` is the critical guard on Windows: an
  // absolute or cross-DRIVE input (e.g. "D:\\evil", "C:\\Windows\\...", a UNC
  // "\\\\host\\share") makes relative() return an ABSOLUTE path that does NOT
  // start with ".." — so the startsWith check alone lets it escape (review
  // finding). An empty rel means the path IS the workspace dir, not a file.
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('path escapes the task workspace — refused');
  }
  return full;
}

export const workspaceList: ToolDef = {
  name: 'workspace_list',
  description:
    "List files in this task's INTERNAL scratch workspace — a private area the user cannot see. This is NOT the user's real computer; for the user's actual folders use fs_list (computer pack).",
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const base = workspaceDir(ctx);
    const walk = (dir: string, depth: number): string[] => {
      if (depth > 4) return [];
      return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        const rel = relative(base, full);
        return statSync(full).isDirectory() ? [rel + '/', ...walk(full, depth + 1)] : [rel];
      });
    };
    return { files: walk(base, 0) };
  },
};

export const workspaceRead: ToolDef = {
  name: 'workspace_read',
  description:
    "Read a text file from this task's INTERNAL scratch workspace (not the user's real files — use fs_read for those).",
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Relative path inside the workspace' } },
    required: ['path'],
  },
  async execute(args, ctx) {
    const full = safePath(ctx, String(args.path ?? ''));
    if (!existsSync(full)) throw new Error(`no such file: ${args.path}`);
    return { path: args.path, content: readFileSync(full, 'utf8').slice(0, 20000) };
  },
};

export const workspaceWrite: ToolDef = {
  name: 'workspace_write',
  description:
    "Write a scratch file into this task's INTERNAL workspace — the user CANNOT see files written here (2026-07-11 incident: a user-requested HTML file 'created' here was never found). When the user asks you to create/save a file FOR THEM, use fs_write instead (their real computer, e.g. Downloads/...) and tell them the absolute path. Use this only for intermediate work products no one asked to keep.",
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path inside the workspace' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const full = safePath(ctx, String(args.path ?? ''));
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, String(args.content ?? ''), 'utf8');
    return { path: args.path, bytes: Buffer.byteLength(String(args.content ?? '')) };
  },
};
