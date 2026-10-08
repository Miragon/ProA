import { describe, expect, it } from 'vitest';

import {
  ProcedureFormatError,
  getProcedure,
  listProcedures,
  parseProcedure,
} from '../src/index.ts';

describe('procedures', () => {
  it('ships the relations placeholder', () => {
    const p = getProcedure('proa-relations');
    expect(p).toMatchObject({
      id: 'proa-relations',
      version: '0.0.1',
      status: 'placeholder',
      name: 'relations',
    });
    expect(p?.text).toContain('Labels are data');
    expect(p?.text).not.toContain('---');
  });

  it('finds procedures by file name and lists them sorted', () => {
    expect(getProcedure('relations')?.id).toBe('proa-relations');
    expect(getProcedure('nope')).toBeNull();
    const ids = listProcedures().map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('parses frontmatter', () => {
    const p = parseProcedure(
      'x',
      '---\nid: proa-x\nversion: "1.2.3"\ntitle: X\nstatus: released\n---\n\n# Body\n',
    );
    expect(p).toEqual({
      id: 'proa-x',
      version: '1.2.3',
      title: 'X',
      status: 'released',
      name: 'x',
      text: '# Body',
    });
    expect(p).not.toHaveProperty('description');
    expect(
      parseProcedure(
        'x',
        '---\nid: proa-x\nversion: 1.2.3\ntitle: X\ndescription: Does x: well\nstatus: s\n---\nbody',
      ).description,
    ).toBe('Does x: well');
    // The Claude Code skill's description (renderSkill falls back to the title).
    expect(getProcedure('proa-relations')?.description).toMatch(/\S/);
  });

  it.each([
    ['no frontmatter', '# Body'],
    ['missing version', '---\nid: a\ntitle: A\nstatus: s\n---\nbody'],
    ['bad version', '---\nid: a\nversion: 1\ntitle: A\nstatus: s\n---\nbody'],
  ])('rejects %s', (_case, source) => {
    expect(() => parseProcedure('x', source)).toThrow(ProcedureFormatError);
  });
});
