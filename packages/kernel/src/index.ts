// Kernel (blueprint §4.1) — M1: Session Manager (lite) + Executor Loop with
// durable checkpoints and resume. Planner and full Task Graph arrive in M4.
export { runTask, findOrphanedTasks, type TaskRunResult } from './executor.js';
export { ensureDefaultSession, addMessage, listMessages, type SessionMessage } from './sessions.js';
export { systemPrompt } from './prompts.js';
export { runHelloWorldTask, type HelloResult } from './hello-task.js';
export { assembleMemoryContext, compactHistory } from './context.js';
export { makePlan, type Plan, type PlannedStep } from './planner.js';
export {
  planAndStart,
  runGraph,
  pauseTask,
  resumeTask,
  redirectTask,
  decideApproval,
  type GraphResult,
} from './graph.js';
export { runResearch, type ResearchResult, type ResearchSource } from './research.js';
export {
  runCodingTask,
  commitApproved,
  llmProposer,
  type Proposer,
  type ProposedFix,
  type CodingResult,
  type CommitResult,
  type RepoFile,
} from './coding.js';
