// The importable API of @proa/eval-tools, for tests of other packages (the
// server's integration test reads a live project the way eval:live does).
// The commands themselves run as scripts: candidates.ts, replay.ts, live.ts.
// Only light modules are exported here: none of them loads the corpus
// toolchain (bpmn-moddle, bpmnlint).
export {
  DEFAULT_PROA_URL,
  LiveSourceError,
  agentOf,
  buildRecordings,
  fetchStoredAnalyses,
  recordingLineOf,
  type BuiltRecording,
  type LineOptions,
  type LiveSource,
  type StoredAnalysis,
} from './live-recordings.ts';
export {
  MAX_RECALL_DROP,
  MIN_LIVE_RUNS,
  SIM_AGENT,
  compareVersions,
  formatLiveGate,
  gateLabel,
  liveGates,
  splitProcedure,
  type LiveBaseline,
  type LiveGate,
  type LiveGateInput,
  type LiveGateStatus,
  type LiveRun,
} from './live-gate.ts';
export { RECORDINGS_DIR, RecordingError, loadRecordings, parseRecording, type RecordingFile } from './recordings.ts';
