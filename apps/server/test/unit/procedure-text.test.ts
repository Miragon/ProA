/**
 * The relations procedure states the server's rules in prose (CONCEPT §7), and agents act on
 * them. These checks keep the text and the code from drifting apart: each checked limit must
 * appear as a whole number in its own phrase, the `invalid:<reason>` list must equal the
 * server's, and every MCP tool the text names must exist with the arguments it names (the
 * snapshot the MCP contract test enforces). Not checked yet, as the contracts keep them inline:
 * the `llmModel`, procedure id and version, and evidence entry limits.
 */
import { readFileSync } from 'node:fs';

import { MAX_DOCUMENTATION_LENGTH } from '@proa/bpmn-facts';
import {
  CLAIM_DOC_CHARS,
  INVALID_REASONS,
  NO_LINK_INVALID_REASONS,
  LEASE_MINUTES,
  MAX_ATTEMPTS,
  MAX_EVIDENCE_ITEMS,
  MAX_NO_LINK_REASON_CHARS,
  MAX_QUESTION_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_SUBMISSION_BYTES,
  MAX_SUBMISSION_NO_LINKS,
  MAX_SUBMISSION_RELATIONS,
  MAX_SUMMARY_CHARS,
} from '@proa/contracts';
import { getProcedure } from '@proa/procedures';
import { DEFAULT_COMPATIBLE_PER_ENDPOINT, DEFAULT_LEXICAL_PER_ENDPOINT } from '@proa/relations';
import { describe, expect, it } from 'vitest';

const procedure = getProcedure('proa-relations');
const text = procedure?.text ?? '';
const n = (v: number) => v.toLocaleString('en-US');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A phrase of the text whose values are whole numbers as the text writes them:
 * `` phrase`lasts ${5} minutes` `` matches "lasts 5 minutes", not "lasts 15 minutes" or
 * "lasts 5.5 minutes".
 */
function phrase(parts: TemplateStringsArray, ...values: number[]): RegExp {
  const numbers = values.map((v) => `(?<!\\d[.,]?)${escape(n(v))}(?![.,]?\\d)`);
  return new RegExp(parts.map((part, i) => escape(part) + (numbers[i] ?? '')).join(''));
}

const tools = new Map(
  (
    JSON.parse(
      readFileSync(new URL('../integration/__snapshots__/mcp-tools.json', import.meta.url), 'utf8'),
    ) as { tools: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] }
  ).tools.map((t) => [t.name, Object.keys(t.inputSchema?.properties ?? {})]),
);

describe('the relations procedure text', () => {
  it('exists and is released', () => {
    expect(procedure?.status).toBe('released');
  });

  it('matches whole numbers only', () => {
    expect('lasts 5 minutes').toMatch(phrase`lasts ${5} minutes`);
    expect('lasts 15 minutes').not.toMatch(phrase`lasts ${5} minutes`);
    expect('over 2,000, then').toMatch(phrase`over ${2000}, then`);
    expect('over 12,000, then').not.toMatch(phrase`over ${2000}, then`);
    expect('at most 1,000.5)').not.toMatch(phrase`at most ${1000}`);
  });

  it('states the contract limits', () => {
    expect(text).toMatch(phrase`The lease lasts ${LEASE_MINUTES} minutes`);
    expect(MAX_ATTEMPTS).toBe(3);
    expect(text).toContain('one expiring on the third attempt fails the task');
    expect(text).toMatch(
      phrase`more than ${MAX_SUBMISSION_RELATIONS} relations or ${MAX_SUBMISSION_NO_LINKS} noLinks`,
    );
    expect(text).toMatch(phrase`characters (at most ${MAX_RATIONALE_CHARS}): what each end is`);
    expect(text).toMatch(phrase`A question is German, at most ${MAX_QUESTION_CHARS} characters`);
    expect(text).toMatch(phrase`\`evidence\`: at most ${MAX_EVIDENCE_ITEMS} entries`);
    expect(text).toMatch(phrase`a summary over ${MAX_SUMMARY_CHARS} characters`);
    expect(text).toMatch(phrase`a no-link reason over ${MAX_NO_LINK_REASON_CHARS},`);
    expect(text).toMatch(phrase`(documentation; cut at ${CLAIM_DOC_CHARS} characters`);
    expect(text).toMatch(phrase`a body over ${MAX_SUBMISSION_BYTES / 1024 / 1024} MiB`);
  });

  it('states the documentation and candidate caps', () => {
    expect(text).toMatch(phrase`documentation up to ${MAX_DOCUMENTATION_LENGTH} characters`);
    expect(text).toMatch(phrase`the top ${DEFAULT_LEXICAL_PER_ENDPOINT} label matches`);
    expect(text).toMatch(phrase`up to ${DEFAULT_COMPATIBLE_PER_ENDPOINT} further type-compatible`);
    expect(text).toMatch(phrase`after the top ${DEFAULT_LEXICAL_PER_ENDPOINT} (`);
  });

  it('names exactly the invalid reasons the server answers', () => {
    const start = 'Per item, `invalid:<reason>` while the others apply:';
    const limits = text.slice(text.indexOf(start), text.indexOf('Other outcomes:'));
    expect(limits.startsWith(start)).toBe(true);
    const listed = [...limits.slice(start.length).matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
    // The text orders them for agents, so compare as sets.
    expect([...listed].sort()).toEqual([...INVALID_REASONS].sort());
  });

  it('names exactly the no-link invalid reasons the server answers', () => {
    const start = 'Per no-link, `invalid:<reason>` while the others apply:';
    const from = text.indexOf(start);
    const list = text.slice(from, text.indexOf('Other no-link outcomes:', from));
    expect(list.startsWith(start)).toBe(true);
    const listed = [...list.slice(start.length).matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
    expect([...listed].sort()).toEqual([...NO_LINK_INVALID_REASONS].sort());
  });

  it('names only MCP tools that exist', () => {
    const named = new Set(
      [
        ...text.matchAll(
          /`((?:get|find|which|claim|submit|release|propose|withdraw|decide|list)_[a-z_]+)/g,
        ),
      ].map((m) => m[1]),
    );
    expect(named.size).toBeGreaterThan(5);
    for (const name of named) expect([...tools.keys()], name).toContain(name);
  });

  it('names only arguments the tools take', () => {
    const calls = [...text.matchAll(/`([a-z_]+)\(\{([^}]*)\}\)/g)];
    expect(calls.length).toBeGreaterThan(5);
    for (const [, name = '', args = ''] of calls) {
      for (const arg of args.split(',')) {
        const key = arg.trim().replace(/[?:].*$/, '');
        expect(tools.get(name), `${name}({${args}})`).toContain(key);
      }
    }
  });
});
