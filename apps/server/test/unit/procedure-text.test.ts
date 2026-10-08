/**
 * The relations procedure states the server's rules in prose (CONCEPT §7), and agents act on
 * them. These checks keep the text and the code from drifting apart: every limit, every
 * `invalid:<reason>` and every MCP tool the text names must match the contracts and the tool
 * list (the snapshot the MCP contract test enforces).
 */
import { readFileSync } from 'node:fs';

import {
  CLAIM_DOC_CHARS,
  INVALID_REASONS,
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
import { describe, expect, it } from 'vitest';

const procedure = getProcedure('proa-relations');
const text = procedure?.text ?? '';
const n = (v: number) => v.toLocaleString('en-US');

const tools = (
  JSON.parse(
    readFileSync(new URL('../integration/__snapshots__/mcp-tools.json', import.meta.url), 'utf8'),
  ) as { tools: { name: string }[] }
).tools.map((t) => t.name);

describe('the relations procedure text', () => {
  it('exists and is released', () => {
    expect(procedure?.status).toBe('released');
  });

  it('states the contract limits', () => {
    expect(text).toContain(`${LEASE_MINUTES} minutes`);
    expect(MAX_ATTEMPTS).toBe(3);
    expect(text).toContain('third attempt');
    expect(text).toContain(
      `more than ${n(MAX_SUBMISSION_RELATIONS)} relations or ${n(MAX_SUBMISSION_NO_LINKS)} noLinks`,
    );
    expect(text).toContain(`at most ${n(MAX_RATIONALE_CHARS)}`);
    expect(text).toContain(`at most ${n(MAX_QUESTION_CHARS)} characters`);
    expect(text).toContain(`at most ${n(MAX_EVIDENCE_ITEMS)} entries`);
    expect(text).toContain(`a summary over ${n(MAX_SUMMARY_CHARS)} characters`);
    expect(text).toContain(`a no-link reason over ${n(MAX_NO_LINK_REASON_CHARS)}`);
    expect(text).toContain(`cut at ${n(CLAIM_DOC_CHARS)} characters`);
    expect(text).toContain(`${MAX_SUBMISSION_BYTES / 1024 / 1024} MiB`);
  });

  it('names every invalid reason the server answers', () => {
    for (const reason of INVALID_REASONS) expect(text, reason).toContain(`\`${reason}\``);
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
    for (const name of named) expect(tools, name).toContain(name);
  });
});
