// Knowledge-graph query tool (Memory OS Phase 3): look up how an entity is
// connected — "what does Akhil own", "what is AI OS built on". Read-only over
// kg_nodes/kg_edges. Complements semantic recall (similarity) with relational
// reasoning (connections).
import { graphNeighborhood } from '@ai-os/memory';
import type { ToolDef } from '../registry.js';

export const graphQuery: ToolDef = {
  name: 'graph_query',
  untrustedOutput: false,
  description:
    'Query the knowledge graph for how an entity (person, project, tool, file, org, concept) is connected to others. Returns subject→relation→object facts. Use for relational questions ("what does X use", "who works on Y", "what depends on Z") that similarity search answers poorly.',
  inputSchema: {
    type: 'object',
    properties: { entity: { type: 'string', description: 'Entity name to look up, e.g. "AI OS", "Akhil", "Gemini".' } },
    required: ['entity'],
  },
  async execute(args, ctx) {
    const entity = String(args.entity ?? '').trim();
    if (!entity) return { error: 'entity is required' };
    const relations = await graphNeighborhood(ctx.pool, entity, 20);
    if (!relations.length) return { entity, relations: [], note: 'no connections known yet for that entity' };
    return { entity, relations: relations.map((r) => `${r.subject} → ${r.rel} → ${r.object}`) };
  },
};
