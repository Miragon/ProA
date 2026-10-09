// Loads a scored landscape (loadLandscape: metadata, expected.yaml, models,
// facts from @proa/bpmn-facts) and runs the deterministic pipeline on it
// (runLandscape): rules, candidates and baseline-proa1 (@proa/relations).
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { FACTS_VERSION, extractFacts } from '@proa/bpmn-facts';
import { FindingKind, Ref, type Candidate, type DerivedRelation, type ProjectFacts } from '@proa/contracts';
import {
  baselineProa1,
  generateCandidates,
  runRules,
  type BaselineEvent,
  type BaselineEventPosition,
  type RuleResult,
} from '@proa/relations';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { extractFacts as extractValidatorFacts } from '../lib/facts.mjs';
import { createModdle } from '../lib/moddle.mjs';
import { loadModels, type CorpusModel } from './corpus.ts';

export const LINK_TYPES = ['call', 'message', 'signal', 'trigger'] as const;
export const EXPECT_VALUES = ['must_link', 'must_not_link', 'may_link'] as const;
export type Expect = (typeof EXPECT_VALUES)[number];

export const ExpectedRelation = z.object({
  type: z.enum(LINK_TYPES),
  from: Ref,
  to: Ref,
  expect: z.enum(EXPECT_VALUES),
  tags: z.array(z.string()).min(1),
  rationale: z.string(),
});
export type ExpectedRelation = z.infer<typeof ExpectedRelation>;

export const ExpectedFinding = z.object({
  kind: FindingKind,
  refs: z.array(Ref).min(1),
  tags: z.array(z.string()).optional(),
  rationale: z.string(),
});
export type ExpectedFinding = z.infer<typeof ExpectedFinding>;

/** The parts of expected.yaml this gate scores (the validator checks the full schema). */
export const Expected = z.object({
  relations: z.array(ExpectedRelation).default([]),
  expected_findings: z.array(ExpectedFinding).default([]),
});
export type Expected = z.infer<typeof Expected>;

export const LandscapeMeta = z.looseObject({
  name: z.string(),
  lang: z.string(),
  split: z.enum(['dev', 'holdout']),
  closed_world: z.boolean(),
});
export type LandscapeMeta = z.infer<typeof LandscapeMeta>;

/** Everything the scorer needs for one landscape. */
export interface LandscapeRun {
  meta: LandscapeMeta;
  expected: Expected;
  facts: ProjectFacts;
  rules: RuleResult;
  candidates: Candidate[];
  baseline: DerivedRelation[];
  /** Every start, end and intermediate event (input of the baseline, see {@link proa1Events}). */
  extraEvents: BaselineEvent[];
}

async function readYamlFile(file: string): Promise<unknown> {
  return parseYaml(await readFile(file, 'utf8')) as unknown;
}

const POSITIONS: Readonly<Record<string, BaselineEventPosition>> = {
  'bpmn:StartEvent': 'start',
  'bpmn:EndEvent': 'end',
  'bpmn:IntermediateThrowEvent': 'intermediate_throw',
  'bpmn:IntermediateCatchEvent': 'intermediate_catch',
};

/**
 * Every start, end and intermediate event of a model, as 1.x stored them,
 * from a full bpmn-moddle parse (the validator's extraction): facts leave
 * out the timer, conditional, error, escalation, link and compensation
 * events 1.x matched by label.
 */
export async function proa1Events(model: CorpusModel, engine: 'c7' | 'c8'): Promise<BaselineEvent[]> {
  const { rootElement } = await createModdle(engine).fromXML(model.xml);
  const facts = extractValidatorFacts(model.key, rootElement);
  const events: BaselineEvent[] = [];
  for (const el of facts.elements.values()) {
    const position = POSITIONS[el.type];
    if (position === undefined) continue;
    events.push({
      ref: Ref.parse(`${model.key}#${el.id}`),
      process: Ref.parse(`${model.key}#${el.processId}`),
      position,
      label: el.label,
    });
  }
  return events;
}

/** A corpus model with the engine its facts were extracted for. */
export interface LoadedModel extends CorpusModel {
  engine: 'c7' | 'c8' | null;
}

/** A landscape as loaded from the corpus: metadata, ground truth, facts and models. */
export interface LoadedLandscape {
  meta: LandscapeMeta;
  expected: Expected;
  facts: ProjectFacts;
  models: LoadedModel[];
}

/**
 * Loads `landscape.yaml`, `expected.yaml` and the models, and extracts the
 * facts (@proa/bpmn-facts; an extraction warning is an error). Shared by
 * eval:candidates, eval:replay and eval:placements.
 */
export async function loadLandscape(dir: string): Promise<LoadedLandscape> {
  const meta = LandscapeMeta.parse(await readYamlFile(path.join(dir, 'landscape.yaml')));
  const expected = Expected.parse(await readYamlFile(path.join(dir, 'expected.yaml')));
  const corpusModels = await loadModels(dir);
  const extracted = await Promise.all(corpusModels.map((m) => extractFacts(m.xml, { modelKey: m.key })));
  for (const r of extracted) {
    if (r.warnings.length > 0) {
      throw new Error(`${meta.name}/${r.modelKey}: extraction warnings: ${r.warnings.map((w) => w.message).join('; ')}`);
    }
  }
  const facts: ProjectFacts = {
    models: extracted.map((r) => ({
      modelKey: r.modelKey,
      factsVersion: FACTS_VERSION,
      processes: r.processes,
      facts: r.facts,
      messageFlows: r.messageFlows,
    })),
  };
  const models = corpusModels.map((m, i) => ({ ...m, engine: extracted[i]?.engine ?? null }));
  return { meta, expected, facts, models };
}

/** Loads a landscape ({@link loadLandscape}) and runs rules, candidates and the baseline. */
export async function runLandscape(dir: string): Promise<LandscapeRun> {
  const { meta, expected, facts, models } = await loadLandscape(dir);
  const extraEvents = (await Promise.all(models.map((m) => proa1Events(m, m.engine ?? 'c7')))).flat();
  return {
    meta,
    expected,
    facts,
    rules: runRules(facts),
    candidates: generateCandidates(facts),
    baseline: baselineProa1(facts, { extraEvents }),
    extraEvents,
  };
}
