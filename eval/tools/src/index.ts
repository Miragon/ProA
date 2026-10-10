// The importable API of @proa/eval-tools, for tests of other packages (the
// server's integration test reads a live project the way eval:live does) and
// the placement scorer M4b (S5) plugs recorded submissions into.
// The commands themselves run as scripts: candidates.ts, replay.ts, live.ts,
// placements.ts. Only light modules are exported here: none of them loads the
// corpus toolchain (bpmn-moddle, bpmnlint), so `loadPlacementRun`
// (placements-load.ts, which extracts the corpus facts) is imported from its
// module inside eval/tools.
export {
  DEFAULT_PROA_URL,
  LiveSourceError,
  agentOf,
  buildRecordings,
  fetchStoredAnalyses,
  isStoredPlacement,
  lineOf,
  placementLineOf,
  recordingLineOf,
  type BuiltRecording,
  type LineOf,
  type LineOptions,
  type LiveSource,
  type StoredAnalysis,
  type StoredPlacementAnalysis,
  type StoredTask,
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
export {
  HOLDOUT_MIN_GROUP,
  HOLDOUT_NOTE,
  OUTSIDE,
  PLACEMENT_CLASSES,
  areaOf,
  baselineProposals,
  classifyArea,
  classifyPlacement,
  redactHoldout,
  rulePlacements,
  scorePlacementProposals,
  scorePlacementRun,
  type ChainStep,
  type Cut,
  type Golden,
  type GoldenPlacement,
  type GoldenStep,
  type Metrics,
  type PlacementClass,
  type PlacementGate,
  type PlacementProcess,
  type PlacementProposal,
  type PlacementRun,
  type PlacementScore,
  type RuleProposal,
  type ScoredItem,
  type SystemScore,
  type ValidatorResult,
} from './placements-score.ts';
