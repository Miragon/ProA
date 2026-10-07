// Shared constants for the ProA eval tooling: engines, tags, finding kinds.

/**
 * Supported engines. `defaultVersion` is what a landscape uses when it does
 * not pin a version; `lintVersions` are the bpmnlint-plugin-camunda-compat
 * configs the generator/validator accept (major.minor).
 */
export const ENGINES = {
  c7: {
    label: 'Camunda 7',
    executionPlatform: 'Camunda Platform',
    defaultVersion: '7.24.0',
    lintPrefix: 'camunda-platform',
    lintVersions: ['7.19', '7.20', '7.21', '7.22', '7.23', '7.24'],
    dockerImage: 'camunda/camunda-bpm-platform:run-7.24.0'
  },
  c8: {
    label: 'Camunda 8',
    executionPlatform: 'Camunda Cloud',
    defaultVersion: '8.9.0',
    lintPrefix: 'camunda-cloud',
    // zeebe:userTask (Camunda user tasks) and signal catch events need >= 8.6 here
    lintVersions: ['8.6', '8.7', '8.8', '8.9', '8.10'],
    dockerImage: 'camunda/camunda:8.9.22'
  }
};

export function majorMinor(version) {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  return m ? `${m[1]}.${m[2]}` : null;
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function lintConfigFor(engine, version) {
  const mm = majorMinor(version);
  const def = ENGINES[engine];
  if (!def || !mm || !def.lintVersions.includes(mm)) return null;
  return `plugin:camunda-compat/${def.lintPrefix}-${mm.replace('.', '-')}`;
}

export function engineFromExecutionPlatform(platform) {
  for (const [engine, def] of Object.entries(ENGINES)) {
    if (def.executionPlatform === platform) return engine;
  }
  return null;
}

/** Trap catalog (see eval/README.md). Every landscape tags each applicable trap at least once. */
export const TRAP_TAGS = [
  'near-miss',
  'transliteration',
  'de-en',
  'event-def-mismatch',
  'subprocess-scope',
  'call-unique',
  'call-dynamic',
  'call-ambiguous',
  'call-unresolved',
  'cross-engine-message',
  'generic-name',
  'signal-broadcast',
  'collaboration',
  'data-store-variants',
  'self-link',
  'trigger',
  'dangling-throw',
  'unmatched-catch'
];

/** Tags for entries that are not traps but still need a category. */
export const EXTRA_TAGS = [
  'exact-key', // plain key-tier link: identical message/signal name, nothing tricky
  'lexical', // label-similar link without an identical key
  'semantic', // same meaning, different words, same language
  'distractor' // must_not_link pair that is plausible for another reason than a catalog trap
];

export const ALL_TAGS = [...TRAP_TAGS, ...EXTRA_TAGS];

export const RELATION_TYPES = ['call', 'message', 'signal', 'trigger'];
export const EXPECT_VALUES = ['must_link', 'must_not_link', 'may_link'];

export const FINDING_KINDS = [
  'unresolved-call',
  'dynamic-call',
  'duplicate-process-id',
  'dangling-throw',
  'unmatched-catch'
];

export const GENERATOR = {
  exporter: 'ProA eval generator',
  exporterVersion: '1.0.0'
};
