// Memory Service (blueprint §7) — built in M3: typed CRUD over memory_records
// with provenance, subject-based conflict resolution, confidence decay, and
// confidence×recency-weighted hybrid retrieval. See ADR-0006.
export {
  MemoryService,
  type MemoryType,
  type MemoryRecord,
  type MemorySource,
  type RememberInput,
  type RecallOptions,
  type RecalledMemory,
} from './service.js';
export { extractAndStore } from './extract.js';
export { recordExperience } from './experience.js';
export { updateKnowledgeGraph, graphNeighborhood, graphForText, graphStats, type GraphRelation } from './graph.js';
export { memoryAnalytics, type MemoryAnalytics } from './analytics.js';
export { consolidateInsights, cognitiveBriefing, type CognitiveBriefing } from './cognition.js';
export { runReflection, type ReflectionReport } from './reflect.js';
