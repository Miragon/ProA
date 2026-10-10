import { describe, expect, it } from 'vitest';

import { claudeCodeCommand, claudeDesktopNodeConfig, serverOrigin } from '../src/lib/agent-config';
import { provenanceOf } from '../src/lib/labels';
import { buildRefIndex, resolverOf, splitRef } from '../src/lib/refs';
import {
  compareRelations,
  filterRelations,
  parseRelationFilters,
} from '../src/lib/relation-filters';
import { isProjectKey, slugify } from '../src/lib/slug';
import { entriesFromFileList, filesOf, isBpmnPath, planUpload, stripRoot } from '../src/lib/upload';
import { relation, sampleRelations } from './support/fixtures';

describe('upload planning', () => {
  const file = (name: string, size = 10) => new File(['x'.repeat(size)], name);

  it('keeps the path below the dropped folder', () => {
    expect(stripRoot('models/vertrieb/auftrag.bpmn')).toBe('vertrieb/auftrag.bpmn');
    expect(stripRoot('auftrag.bpmn')).toBe('auftrag.bpmn');
    const f = file('auftrag.bpmn');
    Object.defineProperty(f, 'webkitRelativePath', { value: 'models/vertrieb/auftrag.bpmn' });
    expect(entriesFromFileList([f, file('lose.bpmn')]).map((e) => e.path)).toEqual([
      'vertrieb/auftrag.bpmn',
      'lose.bpmn',
    ]);
  });

  it('accepts the BPMN endings the server strips', () => {
    expect(['a.bpmn', 'a.BPMN', 'a.bpmn2', 'a.bpmn20.xml', 'a.xml'].every(isBpmnPath)).toBe(true);
    expect(['a.yaml', 'a.md', 'a.bpmn.bak'].some(isBpmnPath)).toBe(false);
  });

  it('skips non-BPMN, hidden and oversized files and splits by count and bytes', () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, i) => ({
        path: `m/${i}.bpmn`,
        file: file(`${i}.bpmn`, 40),
      })),
      { path: 'README.md', file: file('README.md') },
      { path: '.git/config.xml', file: file('config.xml') },
      { path: 'big.bpmn', file: file('big.bpmn', 200) },
    ];
    const plan = planUpload(entries, { maxFiles: 2, maxBytes: 100, maxModelBytes: 100 });
    expect(plan.skipped).toEqual([
      { path: 'big.bpmn', reason: 'too-large' },
      { path: 'README.md', reason: 'not-bpmn' },
    ]);
    expect(plan.batches.map((b) => b.map((e) => e.path))).toEqual([
      ['m/0.bpmn', 'm/1.bpmn'],
      ['m/2.bpmn', 'm/3.bpmn'],
      ['m/4.bpmn'],
    ]);
    const tight = planUpload(entries.slice(0, 3), {
      maxFiles: 50,
      maxBytes: 90,
      maxModelBytes: 100,
    });
    expect(tight.batches.map((b) => b.length)).toEqual([2, 1]);
  });

  it('names each multipart part after its path', () => {
    const [part] = filesOf([{ path: 'vertrieb/auftrag.bpmn', file: file('auftrag.bpmn') }]);
    expect(part!.name).toBe('vertrieb/auftrag.bpmn');
    expect(part!.size).toBe(10);
  });
});

describe('agent configuration', () => {
  it('points MCP clients at the server, also under the Vite dev server', () => {
    expect(serverOrigin({ protocol: 'http:', hostname: '127.0.0.1', port: '7400' }, false)).toBe(
      'http://127.0.0.1:7400',
    );
    expect(serverOrigin({ protocol: 'http:', hostname: 'localhost', port: '7401' }, true)).toBe(
      'http://localhost:7400',
    );
    expect(serverOrigin({ protocol: 'http:', hostname: '::1', port: '7400' }, false)).toBe(
      'http://[::1]:7400',
    );
  });

  it('quotes the token for the shell only when needed', () => {
    expect(claudeCodeCommand('http://localhost:7400', null).split('\n')[0]).toBe(
      "export PROA_TOKEN='proa_at_…'",
    );
    expect(claudeCodeCommand('http://localhost:7400', 'proa_at_abc123').split('\n')).toEqual([
      'export PROA_TOKEN=proa_at_abc123',
      'claude mcp add --transport http proa http://localhost:7400/mcp --header "Authorization: Bearer ${PROA_TOKEN}"',
    ]);
  });

  it('uses a placeholder until the checkout path is known', () => {
    const config = JSON.parse(claudeDesktopNodeConfig('http://localhost:7400', null, '  ')) as {
      mcpServers: { proa: { args: string[] } };
    };
    expect(config.mcpServers.proa.args[0]).toBe('/pfad/zu/ProA/apps/cli/src/main.ts');
  });
});

describe('project keys', () => {
  it('slugifies names like the server slugifies paths', () => {
    expect(slugify('Nordwind Handel GmbH')).toBe('nordwind-handel-gmbh');
    expect(slugify('Stadtwerke Auental – Netz & Messung')).toBe('stadtwerke-auental-netz-messung');
    expect(slugify('Größenprüfung für Ölfässer')).toBe('groessenpruefung-fuer-oelfaesser');
    expect(slugify('Café Crème')).toBe('cafe-creme');
    expect(slugify('x'.repeat(70)).length).toBe(64);
    expect(isProjectKey('nordwind-handel')).toBe(true);
    expect(isProjectKey('Nordwind')).toBe(false);
    expect(isProjectKey('a--b')).toBe(false);
    expect(isProjectKey('')).toBe(false);
  });
});

describe('refs', () => {
  it('splits refs at the first #', () => {
    expect(splitRef('vertrieb/auftrag#Task_1')).toEqual({
      modelKey: 'vertrieb/auftrag',
      elementId: 'Task_1',
    });
  });

  it('resolves labels and the enclosing process, falling back to the element id', () => {
    const resolve = resolverOf(
      buildRefIndex(
        [
          {
            modelKey: 'a',
            ref: 'a#T1',
            kind: 'task',
            label: '',
            processId: 'P',
          },
        ],
        [
          {
            ref: 'a#P',
            processId: 'P',
            name: null,
            participantName: 'Pool A',
            isExecutable: false,
          },
        ],
      ),
    );
    expect(resolve('a#T1')).toMatchObject({ label: null, kind: 'task', processName: 'Pool A' });
    expect(resolve('a#P')).toMatchObject({ label: 'Pool A', kind: 'process' });
    expect(resolve('b#X')).toEqual({
      ref: 'b#X',
      modelKey: 'b',
      elementId: 'X',
      label: null,
      kind: null,
      processName: null,
    });
  });
});

describe('relation filters', () => {
  it('accepts only known values from the URL', () => {
    expect(
      parseRelationFilters({ status: 'accepted', tier: 'nope', type: 'call', model: '', x: 1 }),
    ).toEqual({ status: 'accepted', type: 'call' });
    expect(parseRelationFilters({ model: 'vertrieb/auftrag' })).toEqual({
      model: 'vertrieb/auftrag',
    });
  });

  it('filters by model on either end and sorts stably', () => {
    const filtered = filterRelations(sampleRelations, { model: 'finance/payment-collection' });
    expect(filtered.map((r) => r.id)).toEqual([
      'rel_01CALL000000000000000000001',
      'rel_01STEM000000000000000000001',
    ]);
    const a = relation({ id: 'rel_a', from: 'a#1', to: 'b#1' });
    const b = relation({ id: 'rel_b', from: 'a#1', to: 'b#2' });
    expect([b, a].sort(compareRelations).map((r) => r.id)).toEqual(['rel_a', 'rel_b']);
  });

  it('falls back to tier and rule attributes without API provenance', () => {
    expect(provenanceOf({ tier: 'rule', type: 'call', attrs: {}, provenance: null })).toEqual({
      source: 'rule',
      label: 'proa-rules/1.0.0',
      detail: 'eindeutiger Aufruf',
    });
    expect(
      provenanceOf({
        tier: 'key',
        type: 'call',
        attrs: { match: 'duplicate-process-id' },
        provenance: null,
      }).detail,
    ).toBe('Prozess-ID mehrdeutig');
    expect(provenanceOf({ tier: 'key', type: 'signal', attrs: {}, provenance: null }).detail).toBe(
      'gleicher Signalname',
    );
    expect(
      provenanceOf({
        tier: 'lexical',
        type: 'call',
        attrs: { match: 'process-name' },
        provenance: null,
      }).source,
    ).toBe('rule');
    expect(
      provenanceOf({ tier: 'lexical', type: 'message', attrs: {}, provenance: null }).source,
    ).toBe('agent');
  });
});
