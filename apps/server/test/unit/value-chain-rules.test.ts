/**
 * The rule tier's key proposals of placements (M4 §2 "Tiers", S2):
 * `derivedRulePlacements` over synthetic chains (links, equal names, pasted
 * links, unknown and malformed links, stable rationales), and over the dev
 * landscape's golden chain with its real process facts, where every rule
 * proposal must be the process's `must` or one of its `may` steps. The
 * holdout is never read.
 */
import { readFileSync } from 'node:fs';

import { extractFacts } from '@proa/bpmn-facts';
import type { Fact, Ref } from '@proa/contracts';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { prepareRevision } from '../../src/domain/value-chain/document.ts';
import { derivedRulePlacements, rulesActor } from '../../src/domain/value-chain/rules.ts';
import { corpusFiles } from '../support/corpus.ts';
import {
  NORDWIND_CHAIN,
  NORDWIND_PLACEMENTS,
  chain,
  type StepSpec,
} from '../support/value-chain.ts';

const processFact = (ref: string, label: string) => ({
  kind: 'process' as const,
  ref: ref as Ref,
  label,
});

const PROCESSES = [
  processFact('finanzen/mahnwesen#P_Mahn', 'Mahnwesen'),
  processFact('finanzen/rechnung#P_Rechnung', 'Rechnungsprüfung'),
  processFact('lager/versand#P_Versand', 'Versand'),
  processFact('logistik/versand#P_Versand', 'VERSAND'),
  processFact('x/leer#P_Leer', ''),
];

const stepsOf = (steps: StepSpec[]) => prepareRevision(chain({ steps })).structure.steps;

describe('derivedRulePlacements', () => {
  it('proposes a process on a step whose link names it, and on a step with its name', () => {
    const derived = derivedRulePlacements(
      stepsOf([
        { id: 'step-a', name: 'Sonderfälle', link: 'proa:process/finanzen/mahnwesen#P_Mahn' },
        { id: 'step-b', name: 'Rechnungspruefung' },
        { id: 'step-c', name: 'Vertrieb' },
      ]),
      PROCESSES,
    );
    expect(derived).toEqual([
      {
        elementId: 'step-a',
        processRef: 'finanzen/mahnwesen#P_Mahn',
        byLink: true,
        byName: false,
        rationale:
          'Schlüsselregel: der Link des Schritts nennt diesen Prozess (proa:process/finanzen/mahnwesen#P_Mahn).',
        evidence: ['finanzen/mahnwesen#P_Mahn', 'step:step-a'],
      },
      {
        elementId: 'step-b',
        processRef: 'finanzen/rechnung#P_Rechnung',
        byLink: false,
        byName: true,
        rationale:
          'Schlüsselregel: der Name des Schritts entspricht dem Prozessnamen (normalisiert: „rechnungspruefung“).',
        evidence: ['finanzen/rechnung#P_Rechnung', 'step:step-b'],
      },
    ]);
  });

  it('gives one proposal per pair: both reasons at once, every process with the name', () => {
    const derived = derivedRulePlacements(
      stepsOf([{ id: 's', name: 'Versand', link: 'proa:process/lager/versand#P_Versand' }]),
      PROCESSES,
    );
    expect(derived.map((d) => [d.processRef, d.byLink, d.byName])).toEqual([
      ['lager/versand#P_Versand', true, true],
      ['logistik/versand#P_Versand', false, true],
    ]);
    expect(derived[0]?.rationale).toBe(
      'Schlüsselregel: der Link des Schritts nennt diesen Prozess (proa:process/lager/versand#P_Versand); der Name des Schritts entspricht dem Prozessnamen (normalisiert: „versand“).',
    );
  });

  it('repeats a pasted link per step, in code point order of the steps', () => {
    const link = 'proa:process/finanzen/mahnwesen#P_Mahn';
    const derived = derivedRulePlacements(
      stepsOf([
        { id: 'step-z', name: 'Kopie', link },
        { id: 'step-a', name: 'Original', link },
      ]),
      PROCESSES,
    );
    expect(derived.map((d) => d.elementId)).toEqual(['step-a', 'step-z']);
  });

  it('ignores unknown and malformed links, other link kinds and empty names', () => {
    expect(
      derivedRulePlacements(
        stepsOf([
          { id: 'a', name: 'Eins', link: 'proa:process/finanzen/fehlt#P_Fehlt' },
          { id: 'b', name: 'Zwei', link: 'proa:process/kein-ref' },
          { id: 'c', name: 'Drei', link: 'https://example.org/finanzen/mahnwesen#P_Mahn' },
          { id: 'd', name: 'Vier', link: 'finanzen/mahnwesen#P_Mahn' },
          { id: 'e', name: '' },
        ]),
        PROCESSES,
      ),
    ).toEqual([]);
    // A process fact other than `process` never matches.
    expect(
      derivedRulePlacements(stepsOf([{ id: 'a', name: 'Mahnwesen' }]), [
        { kind: 'task', ref: 'finanzen/mahnwesen#Task_Mahn', label: 'Mahnwesen' },
      ]),
    ).toEqual([]);
  });

  it('keeps the rationale while the normalized name stays (case and umlaut spelling)', () => {
    const [a] = derivedRulePlacements(stepsOf([{ id: 's', name: 'Rechnungsprüfung' }]), PROCESSES);
    const [b] = derivedRulePlacements(stepsOf([{ id: 's', name: 'RECHNUNGSPRUEFUNG' }]), PROCESSES);
    expect(a?.rationale).toBe(b?.rationale);
  });

  it('records under the rule tier as a non-interactive actor', () => {
    expect(rulesActor('prn_rules')).toMatchObject({
      kind: 'service',
      interactive: false,
      clientId: null,
      handle: 'proa-rules',
    });
  });
});

describe('the golden dev chain with the dev landscape', () => {
  it('proposes only must or may steps (M4 §6)', async () => {
    const structure = prepareRevision(JSON.parse(readFileSync(NORDWIND_CHAIN, 'utf8'))).structure;
    const facts: Fact[] = [];
    for (const f of await corpusFiles('nordwind-handel')) {
      facts.push(...(await extractFacts(f.bytes, { modelKey: f.key })).facts);
    }
    const expected = parse(readFileSync(NORDWIND_PLACEMENTS, 'utf8')) as {
      placements: { process: string; must: string; may?: string[] }[];
    };
    const allowed = new Map(
      expected.placements.map((p) => [p.process, [p.must, ...(p.may ?? [])]]),
    );
    const derived = derivedRulePlacements(structure.steps, facts);
    // The golden chains carry no links: equal names only.
    expect(derived.every((d) => d.byName && !d.byLink)).toBe(true);
    expect(derived.length).toBeGreaterThan(0);
    for (const d of derived) {
      expect(allowed.get(d.processRef), `${d.processRef} → ${d.elementId}`).toContain(d.elementId);
    }
  });
});
