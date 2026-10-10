import type { Fact } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import { EVENT_DEF_COMPATIBILITY, canLink, endpointRole, indexLandscape } from '../src/index.ts';
import {
  call,
  end,
  model,
  msgCatch,
  msgThrow,
  project,
  sigCatch,
  start,
  task,
} from './support/facts.ts';

const roleOf = (factFn: (modelKey: string, processId: string) => Fact) => {
  const role = endpointRole(factFn('a/b', 'Process_A'));
  return role === null ? null : `${role.type}:${role.side}`;
};

describe('endpointRole (CONCEPT §2 endpoint rules)', () => {
  it('gives calls, processes, throws, catches, labelled none ends and starts their role', () => {
    expect(roleOf(call('Call_X', 'Process_X'))).toBe('call:from');
    expect(roleOf(msgThrow('T', 'M'))).toBe('message:from');
    expect(roleOf(msgThrow('T', 'M', { element: 'bpmn:SendTask' }))).toBe('message:from');
    expect(roleOf(msgCatch('C', 'M', { element: 'bpmn:ReceiveTask' }))).toBe('message:to');
    expect(roleOf(msgCatch('C', 'M', { element: 'bpmn:BoundaryEvent' }))).toBe('message:to');
    expect(roleOf(end('End_X', 'Done'))).toBe('trigger:from');
    expect(roleOf(start('Start_X', 'Begun'))).toBe('trigger:to');
    expect(roleOf(task('Task_X', 'Work'))).toBeNull();
  });

  it('never makes start or end events inside an embedded subprocess endpoints', () => {
    expect(roleOf(start('Start_Sub', 'Begun', { scope: 'subprocess' }))).toBeNull();
    expect(roleOf(end('End_Sub', 'Done', { scope: 'subprocess' }))).toBeNull();
    expect(roleOf(msgCatch('Start_Sub', 'M', { scope: 'subprocess' }))).toBeNull();
    expect(
      roleOf(msgThrow('End_Sub', 'M', { element: 'bpmn:EndEvent', scope: 'subprocess' })),
    ).toBeNull();
  });

  it('allows the typed start of an event subprocess, never its end', () => {
    expect(roleOf(msgCatch('Start_Evt', 'M', { scope: 'event_subprocess' }))).toBe('message:to');
    expect(roleOf(sigCatch('Start_Sig', 'S', { scope: 'event_subprocess' }))).toBe('signal:to');
    expect(
      roleOf(msgThrow('End_Evt', 'M', { element: 'bpmn:EndEvent', scope: 'event_subprocess' })),
    ).toBeNull();
    expect(roleOf(end('End_Evt', 'Done', { scope: 'event_subprocess' }))).toBeNull();
  });

  it('keeps intermediate and boundary events and tasks endpoints in every scope', () => {
    expect(
      roleOf(
        msgCatch('Event_Sub', 'M', { element: 'bpmn:IntermediateCatchEvent', scope: 'subprocess' }),
      ),
    ).toBe('message:to');
    expect(
      roleOf(msgThrow('Task_Sub', 'M', { element: 'bpmn:SendTask', scope: 'event_subprocess' })),
    ).toBe('message:from');
  });

  it('never links timer or conditional starts, terminate ends or unlabelled none events', () => {
    expect(roleOf(start('Start_Timer', 'Monthly', { eventDef: 'timer' }))).toBeNull();
    expect(roleOf(start('Start_Cond', 'Ready', { eventDef: 'conditional' }))).toBeNull();
    expect(roleOf(end('End_Term', 'Stopped', { eventDef: 'terminate' }))).toBeNull();
    expect(roleOf(end('End_NoLabel', ''))).toBeNull();
    expect(roleOf(start('Start_NoLabel', '  '))).toBeNull();
  });

  it('documents the compatibility matrix', () => {
    expect(EVENT_DEF_COMPATIBILITY.trigger).toEqual({ from: ['none'], to: ['none'] });
    expect(EVENT_DEF_COMPATIBILITY.message.to).not.toContain('timer');
    expect(EVENT_DEF_COMPATIBILITY.signal.from).not.toContain('none');
  });
});

describe('canLink', () => {
  const m = model('ops/collab', {
    processes: [{ id: 'Process_A' }, { id: 'Process_B' }],
    facts: [
      msgThrow('Task_A', 'M', { element: 'bpmn:SendTask', processId: 'Process_A' }),
      msgCatch('Start_B', 'M', { processId: 'Process_B' }),
      msgCatch('Event_A', 'M', { element: 'bpmn:IntermediateCatchEvent', processId: 'Process_A' }),
      msgCatch('Event_B', 'M', { element: 'bpmn:IntermediateCatchEvent', processId: 'Process_B' }),
    ],
    messageFlows: [{ id: 'Flow_1', from: 'Task_A', to: 'Start_B' }],
  });
  const index = indexLandscape(project(m));
  const [from] = index.endpoints.message.from;
  const byRef = new Map(index.endpoints.message.to.map((e) => [e.ref, e]));

  it('requires different processes and no message flow in the file between the two', () => {
    if (from === undefined) throw new Error('no throw');
    expect(canLink(index, from, byRef.get('ops/collab#Start_B')!)).toBe(false);
    expect(canLink(index, from, byRef.get('ops/collab#Event_A')!)).toBe(false);
    expect(canLink(index, from, byRef.get('ops/collab#Event_B')!)).toBe(true);
  });
});
