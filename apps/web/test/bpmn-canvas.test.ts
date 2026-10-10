import { describe, expect, it } from 'vitest';

import {
  focusViewbox,
  isInView,
  resolveElement,
  type DiagramElement,
} from '../src/lib/bpmn-elements';

type El = DiagramElement;

function registry(elements: El[]) {
  return {
    get: (id: string) => elements.find((e) => e.id === id),
    filter: (fn: (e: El) => boolean) => elements.filter(fn),
  };
}

describe('resolveElement', () => {
  const root: El = { id: 'Process_A', type: 'bpmn:Process' };
  const collaboration: El = { id: 'Collab', type: 'bpmn:Collaboration' };
  const pool: El = {
    id: 'Participant_B',
    type: 'bpmn:Participant',
    parent: collaboration,
    businessObject: { processRef: { id: 'Process_B' } },
  };
  const task: El = { id: 'Task_1', type: 'bpmn:Task', parent: pool };

  it('finds elements by id', () => {
    expect(resolveElement(registry([collaboration, pool, task]), 'Task_1')).toBe(task);
  });

  it('maps a process id to its pool in a collaboration', () => {
    expect(resolveElement(registry([collaboration, pool, task]), 'Process_B')).toBe(pool);
  });

  it('cannot highlight the root of a plain process diagram', () => {
    expect(resolveElement(registry([root]), 'Process_A')).toBeNull();
    expect(resolveElement(registry([root]), 'Missing')).toBeNull();
  });
});

describe('focus', () => {
  const outer = { width: 1000, height: 800 };
  const task = { x: 900, y: 400, width: 100, height: 80 };

  it('centres an element at a readable zoom', () => {
    expect(focusViewbox({ scale: 0.4, outer }, task)).toEqual({
      x: 950 - 500,
      y: 440 - 400,
      width: 1000,
      height: 800,
    });
    // a user who zoomed in further keeps the zoom
    expect(focusViewbox({ scale: 2, outer }, task)).toMatchObject({ width: 500, height: 400 });
    expect(focusViewbox({ scale: 1, outer }, { x: 1 })).toBeNull();
  });

  it('leaves the view alone when the element is visible and readable', () => {
    const view = { x: 0, y: 0, width: 1200, height: 900, scale: 1 };
    expect(isInView(view, task)).toBe(true);
    expect(isInView({ ...view, scale: 0.5 }, task)).toBe(false);
    expect(isInView({ ...view, width: 950 }, task)).toBe(false);
  });
});
