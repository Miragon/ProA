/**
 * `@proa/agent-sim`: the LLM-free simulation agent of M2 (item 8). It works
 * the ProA analysis pipeline over MCP with an agent token — claim → decide →
 * submit until no task is left — with the deterministic policy
 * {@link decide} (`sim-policy-1`), and records claim inputs and submissions
 * in the eval layout for `eval:replay`.
 */
export {
  AGENT_NAME,
  PROCEDURE_ID,
  REQUIRED_TOOLS,
  SimError,
  problemOf,
  runAgent,
  taskLine,
} from './agent.ts';
export type {
  AgentOptions,
  AgentReport,
  McpSession,
  Problem,
  TaskReport,
  ToolOutcome,
} from './agent.ts';
export { CHECKOUT_BRIDGE, bridgeCommand, connect, mcpUrl } from './connect.ts';
export type { ClientInfo, Connection } from './connect.ts';
export { DEFAULT_POLICY, SIM_POLICY, decide, normalizeLabel } from './policy.ts';
export type { Decision, Judgement, NoLink, PolicyOptions, Proposal, Verdict } from './policy.ts';
export { createRecorder, recordingLine, summarizeInput } from './recorder.ts';
export type { InputMode, RecordedTask, Recorder, RecorderOptions } from './recorder.ts';
export { DEFAULT_URL, buildProgram, processIo, runSim, simulate } from './program.ts';
export type { SimIo, SimOptions } from './program.ts';
