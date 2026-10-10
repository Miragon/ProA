import type { Fact, ProcessInfo, Ref } from '@proa/client';

/** `vertrieb/auftrag#Task_1` → `{ modelKey: 'vertrieb/auftrag', elementId: 'Task_1' }`. */
export function splitRef(ref: string): { modelKey: string; elementId: string } {
  const at = ref.indexOf('#');
  if (at <= 0) return { modelKey: ref, elementId: '' };
  return { modelKey: ref.slice(0, at), elementId: ref.slice(at + 1) };
}

/** What the UI knows about one endpoint of a relation or finding. */
export interface RefLabel {
  ref: string;
  modelKey: string;
  elementId: string;
  /** Element label, process name or pool name; `null` if the element has none. */
  label: string | null;
  /** Fact kind (`process`, `call`, `msg_throw`, …) when known. */
  kind: Fact['kind'] | null;
  /** Name of the process the element lies in. */
  processName: string | null;
}

export type RefResolver = (ref: string) => RefLabel;

/** Index of everything the facts of the head revisions say about refs. */
export function buildRefIndex(
  facts: readonly Pick<Fact, 'ref' | 'kind' | 'label' | 'processId' | 'modelKey'>[],
  processes: readonly (ProcessInfo & { modelKey?: string })[],
): Map<string, Omit<RefLabel, 'ref' | 'modelKey' | 'elementId'>> {
  const processNames = new Map<string, string | null>();
  for (const p of processes) {
    processNames.set(p.ref, p.name ?? p.participantName ?? null);
  }
  const index = new Map<string, Omit<RefLabel, 'ref' | 'modelKey' | 'elementId'>>();
  for (const p of processes) {
    index.set(p.ref, {
      label: p.name ?? p.participantName ?? null,
      kind: 'process',
      processName: p.name ?? p.participantName ?? null,
    });
  }
  for (const f of facts) {
    if (f.kind === 'process' && index.has(f.ref)) continue;
    const processRef: Ref | null = f.processId === null ? null : `${f.modelKey}#${f.processId}`;
    index.set(f.ref, {
      label: f.label === '' ? null : f.label,
      kind: f.kind,
      processName: processRef === null ? null : (processNames.get(processRef) ?? f.processId),
    });
  }
  return index;
}

export function resolverOf(
  index: ReadonlyMap<string, Omit<RefLabel, 'ref' | 'modelKey' | 'elementId'>>,
): RefResolver {
  return (ref) => {
    const { modelKey, elementId } = splitRef(ref);
    const known = index.get(ref);
    return {
      ref,
      modelKey,
      elementId,
      label: known?.label ?? null,
      kind: known?.kind ?? null,
      processName: known?.processName ?? null,
    };
  };
}

/** Resolver that knows nothing but the ref itself (while facts are loading). */
export const bareResolver: RefResolver = resolverOf(new Map());
