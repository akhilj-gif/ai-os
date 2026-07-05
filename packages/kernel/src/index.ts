// Kernel (blueprint §4.1) — M1: Session Manager (lite) + Executor Loop with
// durable checkpoints and resume. Planner and full Task Graph arrive in M4.
export { runTask, findOrphanedTasks, type TaskRunResult } from './executor.js';
export { ensureDefaultSession, addMessage, listMessages, type SessionMessage } from './sessions.js';
export { systemPrompt } from './prompts.js';
export { runHelloWorldTask, type HelloResult } from './hello-task.js';
export { assembleMemoryContext, compactHistory } from './context.js';
