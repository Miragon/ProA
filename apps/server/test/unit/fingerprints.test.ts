import type { Fact, FactKind, ProjectFacts } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import { headFingerprints } from '../../src/domain/fingerprints.ts';

function fact(ref: string, kind: FactKind, fingerprint: string): Fact {
  const [modelKey = '', elementId = ''] = ref.split('#');
  return {
    modelKey,
    ref: ref as Fact['ref'],
    kind,
    elementId,
    processId: 'P',
    scope: 'process',
    eventDef: 'multiple',
    label: '',
    keyRaw: '',
    keyNorm: '',
    fingerprint,
    attrs: {},
  };
}

const projectFacts: ProjectFacts = {
  models: [
    {
      modelKey: 'm/a',
      factsVersion: '1',
      processes: [],
      messageFlows: [],
      // One element with a message and a signal definition: two facts, one ref.
      facts: [
        fact('m/a#T', 'msg_throw', 'aaaaaaaaaaaa'),
        fact('m/a#T', 'sig_throw', 'bbbbbbbbbbbb'),
      ],
    },
    {
      modelKey: 'm/b',
      factsVersion: '1',
      processes: [],
      messageFlows: [],
      facts: [fact('m/b#C', 'msg_catch', 'cccccccccccc'), fact('m/b#P', 'process', 'dddddddddddd')],
    },
  ],
};

describe('headFingerprints', () => {
  const fps = headFingerprints(projectFacts);

  it('anchors a message relation to the msg_* fact and a signal relation to the sig_* fact of one element', () => {
    expect(fps.get('message', 'from', 'm/a#T')).toBe('aaaaaaaaaaaa');
    expect(fps.get('signal', 'from', 'm/a#T')).toBe('bbbbbbbbbbbb');
    expect(fps.get('message', 'to', 'm/b#C')).toBe('cccccccccccc');
  });

  it('treats a ref without a fact of the fitting kind as missing', () => {
    expect(fps.get('signal', 'to', 'm/b#C')).toBeUndefined();
    expect(fps.get('message', 'to', 'm/a#T')).toBeUndefined();
    expect(fps.get('call', 'to', 'm/b#P')).toBe('dddddddddddd');
    expect(fps.get('call', 'from', 'm/b#P')).toBeUndefined();
    expect(fps.get('message', 'from', 'm/x#T')).toBeUndefined();
  });

  it('accepts any kind for manual relations, first in FactKind order', () => {
    expect(fps.get('manual', 'from', 'm/a#T')).toBe('aaaaaaaaaaaa');
    expect(fps.get('manual', 'to', 'm/b#P')).toBe('dddddddddddd');
  });
});
