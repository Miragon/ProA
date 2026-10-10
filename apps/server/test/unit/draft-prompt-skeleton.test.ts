// M4 §3.3 (S5): the MCP prompt `draft_value_chain` shows agents a minimal `.vc.json` skeleton. It
// must be a chain ProA saves as it is (`prepareRevision`: schema-model's validation and the ProA
// rules), so an agent copying its shape never drafts a file the import or the save refuses. Its
// data is invented: no step id or name of the dev landscape's golden chain (the holdout's is never
// read here), so a drafted chain cannot score through the example. The rules it states in prose
// follow the contracts (each limit as a whole number in its own phrase, the reserved id, the kind
// colours), and every tool call it shows names an MCP tool and arguments that exist (the snapshot
// the MCP contract test enforces), as `placement-procedure-text.test.ts` checks the procedure.
import { readFileSync } from 'node:fs';

import {
  MAX_VALUE_CHAIN_CONNECTIONS,
  MAX_VALUE_CHAIN_COORDINATE,
  MAX_VALUE_CHAIN_DEPTH,
  MAX_VALUE_CHAIN_ELEMENTS,
  MAX_VALUE_CHAIN_ELEMENT_SIZE,
  MAX_VALUE_CHAIN_ID_CHARS,
  MAX_VALUE_CHAIN_NAME_CHARS,
  RESERVED_ELEMENT_IDS,
  STEP_KIND_COLORS,
} from '@proa/contracts';
import { renderDraftValueChainPrompt } from '@proa/procedures';
import { describe, expect, it } from 'vitest';

import { prepareRevision } from '../../src/domain/value-chain/document.ts';

const prompt = renderDraftValueChainPrompt({ projectId: 'demo' });
const n = (v: number) => v.toLocaleString('en-US');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A phrase whose values are whole numbers as the prompt writes them (`1,000`, never `1,0005`). */
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
const skeleton = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt)?.[1] ?? 'null') as {
  elements: { id: string; name: string; elementType: string; color?: string }[];
  connections: { connectionType: string }[];
};

describe('the draft_value_chain skeleton', () => {
  it('passes the ProA rules as a save checks them', () => {
    expect(() => prepareRevision(skeleton)).not.toThrow();
    const { prepared } = prepareRevision(skeleton);
    expect(prepared.content.byteLength).toBeGreaterThan(0);
  });

  it('shows a core sequence, sub-steps and the management and support colours', () => {
    const types = new Set(skeleton.connections.map((c) => c.connectionType));
    expect(types).toEqual(new Set(['sequence', 'hierarchy']));
    const colours = new Set(skeleton.elements.map((e) => e.color).filter(Boolean));
    expect(colours).toEqual(new Set(['hsl(287, 65%, 44%)', 'hsl(150, 86%, 34%)']));
    expect(prompt).toContain('`hsl(287, 65%, 44%)`');
    expect(prompt).toContain('`hsl(150, 86%, 34%)`');
  });

  it('is invented: no step id or name of the dev golden chain', () => {
    const golden = JSON.parse(
      readFileSync(
        new URL(
          '../../../../eval/value-chains/nordwind-handel/value-chain.vc.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { elements: { id: string; name: string }[] };
    const ids = new Set(golden.elements.map((e) => e.id));
    const names = new Set(golden.elements.map((e) => e.name.toLowerCase()));
    expect(skeleton.elements.filter((e) => ids.has(e.id)).map((e) => e.id)).toEqual([]);
    expect(
      skeleton.elements.filter((e) => names.has(e.name.toLowerCase())).map((e) => e.name),
    ).toEqual([]);
  });
});

describe('the draft_value_chain rules and tool calls', () => {
  it('states the limits a save enforces, as the contracts define them', () => {
    expect(prompt).toMatch(
      phrase`at most ${MAX_VALUE_CHAIN_ELEMENTS} elements (steps and org units) and ${MAX_VALUE_CHAIN_CONNECTIONS} connections`,
    );
    expect(prompt).toMatch(phrase`at most ${MAX_VALUE_CHAIN_ID_CHARS} characters`);
    expect(prompt).toMatch(phrase`names at most ${MAX_VALUE_CHAIN_NAME_CHARS} characters`);
    expect(prompt).toMatch(phrase`coordinates within ±${MAX_VALUE_CHAIN_COORDINATE}`);
    expect(prompt).toMatch(phrase`widths and heights at most ${MAX_VALUE_CHAIN_ELEMENT_SIZE}`);
    expect(prompt).toMatch(phrase`depth at most ${MAX_VALUE_CHAIN_DEPTH}`);
    expect(RESERVED_ELEMENT_IDS).toEqual(['vc-root']);
    for (const id of RESERVED_ELEMENT_IDS) expect(prompt).toContain(`never \`${id}\``);
    expect(prompt).toContain('never starting with `@`');
  });

  it('names the colours of the management and support steps', () => {
    expect(prompt).toContain(
      `Management steps (steering, planning, controlling) in \`${STEP_KIND_COLORS.management}\``,
    );
    expect(prompt).toContain(
      `support steps (finance, personnel, IT, central services) in \`${STEP_KIND_COLORS.support}\``,
    );
  });

  it('calls only MCP tools that exist, with arguments they take', () => {
    const calls = [...prompt.matchAll(/\b([a-z_]+)\(\{([^}]*)\}\)/g)];
    expect(calls.map((c) => c[1])).toEqual([
      'list_processes',
      'get_landscape',
      'get_value_chain',
      'get_process',
    ]);
    for (const [, name = '', args = ''] of calls) {
      expect([...tools.keys()], name).toContain(name);
      for (const arg of args.split(',')) {
        const key = arg.trim().replace(/[?:].*$/, '');
        expect(tools.get(name), `${name}({${args}})`).toContain(key);
      }
    }
    // The project id is filled in.
    expect(prompt).not.toContain('{{projectId}}');
    expect(prompt).toContain('list_processes({projectId: "demo"})');
  });
});
