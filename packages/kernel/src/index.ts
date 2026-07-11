// Kernel (blueprint §4.1) — M1: Session Manager (lite) + Executor Loop with
// durable checkpoints and resume. Planner and full Task Graph arrive in M4.
export { runTask, findOrphanedTasks, type TaskRunResult } from './executor.js';
export {
  runAgentTask,
  resumeAgentTask,
  classifyGoal,
  orchestrate,
  parsePlan,
  topoWaves,
  isRateLimitPressure,
  AGENTS,
  type Subtask,
  type ChildResult,
  type AgentDef,
  type AgentTaskOptions,
  type OrchestrateDeps,
} from './agents.js';
export { ensureDefaultSession, addMessage, listMessages, type SessionMessage } from './sessions.js';
export { systemPrompt } from './prompts.js';
export { runHelloWorldTask, type HelloResult } from './hello-task.js';
export { assembleMemoryContext, compactHistory, shrinkToolResults } from './context.js';
export { tickRemote, parseRemoteCommand, formatApprovalPrompt, type RemoteDeps, type RemoteCursor, type RemoteMessage, type PendingSummary } from './remote.js';
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
export {
  computeNextRun,
  createJob,
  tick,
  startScheduler,
  type Schedule,
  type JobRow,
  type JobExecutor,
  type ExecutorContext,
  type ExecutorResult,
  type TickReport,
} from './scheduler.js';
export { briefingExecutor, watchExecutor, reflectExecutor, actExecutor, makeActExecutor, learnExecutor, defaultExecutors, type ActRunner } from './jobs.js';
export {
  runLearningCycle,
  gatherFailureSignals,
  llmProposer as learningProposer,
  gymVerifier,
  type FailureSignal,
  type ImprovementCandidate,
  type Playbook,
  type Verdict,
  type Proposer as LearningProposer,
  type Verifier as LearningVerifier,
  type LearningResult,
} from './learning.js';
export {
  tick as coordinatorTick,
  startCoordinator,
  type CoordinatorOptions,
  type CoordinatorReport,
  type StuckTaskFinding,
  type ApprovalBacklogFinding,
  type JobStreakFinding,
  type ProviderHealthFinding,
} from './coordinator.js';
