/**
 * `@proa/agent-sim`: the LLM-free simulation agent of M2 (item 8) and M4b.
 * It works the ProA analysis pipeline over MCP with an agent token — claim →
 * decide → submit until no task is left — with the deterministic policy
 * `sim-policy-1`: {@link decide} for relations tasks, {@link decidePlacements}
 * for placement tasks, and records claim inputs and submissions in the eval
 * layout for `eval:replay`.
 */
export {
  AGENT_NAME,
  ALL_KINDS,
  PROCEDURE_ID,
  PROCEDURE_IDS,
  REQUIRED_TOOLS,
  SimError,
  problemOf,
  runAgent,
  taskLine,
} from './agent.ts';
export type {
  AgentOptions,
  AgentReport,
  KindTotals,
  McpSession,
  PlacementTaskReport,
  Problem,
  RelationsTaskReport,
  TaskReport,
  ToolOutcome,
} from './agent.ts';
export {
  MAX_HINT_CONFIDENCE,
  NO_EVIDENCE,
  RULE_CONFIDENCE,
  STRONG_HINT_SCORE,
  WEAK_HINT_CONFIDENCE,
  decidePlacements,
  hintConfidence,
} from './placement-policy.ts';
export type {
  PlacementDecision,
  PlacementJudgement,
  PlacementProposal,
  PlacementVerdict,
  UnsureVerdict,
} from './placement-policy.ts';
export { CHECKOUT_BRIDGE, bridgeCommand, connect, mcpUrl } from './connect.ts';
export type { ClientInfo, Connection } from './connect.ts';
export { DEFAULT_POLICY, SIM_POLICY, decide, normalizeLabel } from './policy.ts';
export type { Decision, Judgement, NoLink, PolicyOptions, Proposal, Verdict } from './policy.ts';
export {
  createRecorder,
  placementRecordingLine,
  recordedPlacementResult,
  recordedResult,
  recordingLine,
  summarizeInput,
  summarizePlacementInput,
} from './recorder.ts';
export type {
  AnyRecordedTask,
  InputMode,
  RecordedPlacementTask,
  RecordedTask,
  Recorder,
  RecorderOptions,
} from './recorder.ts';
export { DEFAULT_URL, buildProgram, processIo, runSim, simulate } from './program.ts';
export type { SimIo, SimOptions } from './program.ts';
