import {
  putValueChainContent,
  type SaveValueChainResult,
  type ValueChainViolation,
} from '@proa/client';
import { useEffect, useReducer, useRef } from 'react';

import { ApiError, api, errorMessage, unwrap } from './api';
import { VALUE_CHAIN_KEY } from './limits';
import { toast } from './toast';
import { impactSentence, needsConfirmation, precheck, sameImpact } from './value-chain';

/**
 * Saving the value chain from the web (M4 §4 "Save"), as an explicit state
 * machine that knows nothing about the canvas: it gets the canonical text
 * from `exportCanonical`, compares it with the base the edit started from,
 * pre-checks size and counts, runs the dry run with the precondition
 * (`If-Match: "r<base>"`, or `If-None-Match: *` for a chain not created
 * yet), asks for confirmation when placements would be stranded, sent to
 * re-confirm or withdrawn, saves with the same precondition and reports the
 * save's own impact (which can differ from the dry run's). A 412 is a
 * conflict (ProA never merges and the web never forces), a 422 lists the
 * violations, a 428 is a bug.
 */

export interface SaveBase {
  /** The revision the edit started from; 0 for a chain that does not exist yet. */
  rev: number;
  /** Its canonical text; `null` for a new chain. */
  text: string | null;
}

export type SaveState =
  | { phase: 'idle' }
  | { phase: 'checking'; text: string }
  | { phase: 'confirm'; text: string; dry: SaveValueChainResult }
  /** `confirmed`: the user confirmed the impact dialog (it stays open, disabled, while saving). */
  | { phase: 'saving'; text: string; dry: SaveValueChainResult; confirmed: boolean }
  /** The save's own impact differs from the confirmed dry run. */
  | { phase: 'result'; saved: SaveValueChainResult; dry: SaveValueChainResult }
  /** 412 `revision-conflict`: someone saved `headRev` meanwhile. */
  | { phase: 'conflict'; text: string; headRev: number | null }
  /** 422 `value-chain-invalid`. */
  | { phase: 'invalid'; violations: ValueChainViolation[]; truncated: boolean }
  /** A refusal the user can only read (size, version, deleted chain, internal). */
  | { phase: 'error'; title: string; description: string; reload: boolean };

type Action = { type: 'set'; state: SaveState } | { type: 'reset' };

/**
 * The dry run the impact dialog shows: while it asks, and while a confirmed
 * save runs. A save that needed no confirmation never opens it.
 */
export function impactDialogOf(state: SaveState): SaveValueChainResult | null {
  if (state.phase === 'confirm') return state.dry;
  if (state.phase === 'saving' && state.confirmed) return state.dry;
  return null;
}

function reducer(_state: SaveState, action: Action): SaveState {
  return action.type === 'reset' ? { phase: 'idle' } : action.state;
}

export interface ChainSaveOptions {
  project: string;
  base: SaveBase;
  exportCanonical: () => string;
  /** A save (or an `unchanged` answer): the new base is `result.valueChain.headRev` and `text`. */
  onSaved: (result: SaveValueChainResult, text: string) => void;
}

function precondition(base: SaveBase): { 'if-match': string } | { 'if-none-match': '*' } {
  return base.rev > 0 ? { 'if-match': `"r${base.rev}"` } : { 'if-none-match': '*' };
}

/** What a refused save means for the state machine (`null`: a toast suffices). */
export function stateOfError(error: unknown, text: string): SaveState | null {
  if (!(error instanceof ApiError)) return null;
  const problem = error.problem as Record<string, unknown>;
  const code = error.problem.code;
  if (error.status === 412 && code === 'revision-conflict') {
    return {
      phase: 'conflict',
      text,
      headRev: typeof problem['headRev'] === 'number' ? problem['headRev'] : null,
    };
  }
  if (error.status === 428 || code === 'precondition-required') {
    return {
      phase: 'error',
      title: 'Interner Fehler: Revision unbekannt',
      description:
        'Der Speichervorgang kam ohne Revision beim Server an. Lade die Seite neu; deine Änderungen bleiben als Entwurf erhalten.',
      reload: true,
    };
  }
  if (error.status === 422 && code === 'value-chain-invalid') {
    return {
      phase: 'invalid',
      violations: Array.isArray(problem['violations'])
        ? (problem['violations'] as ValueChainViolation[])
        : [],
      truncated: problem['truncated'] === true,
    };
  }
  if (error.status === 422 && code === 'value-chain-unsupported-version') {
    return {
      phase: 'error',
      title: 'Format zu neu',
      description: `Das Dokument hat die Formatversion ${String(problem['schemaVersion'])}, ProA kennt höchstens ${String(problem['supported'])}.`,
      reload: false,
    };
  }
  if (error.status === 413 || code === 'payload-too-large') {
    return {
      phase: 'error',
      title: 'Kette zu groß',
      description: 'Der Server nimmt höchstens 2 MB entgegen; gespeichert wird höchstens 1 MB.',
      reload: false,
    };
  }
  if (error.status === 404) {
    return {
      phase: 'error',
      title: 'Die Kette gibt es nicht mehr',
      description:
        'Jemand hat die Wertschöpfungskette inzwischen gelöscht. Lade die Seite neu; deine Änderungen kannst du vorher herunterladen.',
      reload: true,
    };
  }
  return null;
}

export function useChainSave({ project, base, exportCanonical, onSaved }: ChainSaveOptions) {
  const [state, dispatch] = useReducer(reducer, { phase: 'idle' });
  // The latest options, so a confirmation after a re-render uses the current base.
  const latest = useRef({ base, onSaved });
  useEffect(() => {
    latest.current = { base, onSaved };
  });
  const set = (next: SaveState) => dispatch({ type: 'set', state: next });

  async function put(text: string, dryRun: boolean): Promise<SaveValueChainResult> {
    return unwrap(
      putValueChainContent({
        client: api,
        path: { project, key: VALUE_CHAIN_KEY },
        query: dryRun ? { dryRun: 'true' } : {},
        headers: precondition(latest.current.base),
        // hey-api sends it as JSON; the server canonicalizes again.
        body: JSON.parse(text) as Record<string, unknown>,
      }),
    );
  }

  function fail(error: unknown, text: string) {
    const next = stateOfError(error, text);
    if (next) set(next);
    else {
      set({ phase: 'idle' });
      toast({ tone: 'danger', title: 'Nicht gespeichert', description: errorMessage(error) });
    }
  }

  function unchanged(result: SaveValueChainResult, text: string) {
    set({ phase: 'idle' });
    toast({
      tone: 'info',
      title: 'Keine Änderungen',
      description: 'Die Kette ist schon so gespeichert.',
    });
    latest.current.onSaved(result, text);
  }

  async function commit(text: string, dry: SaveValueChainResult, confirmed: boolean) {
    set({ phase: 'saving', text, dry, confirmed });
    try {
      const saved = await put(text, false);
      if (saved.outcome === 'unchanged') {
        unchanged(saved, text);
        return;
      }
      latest.current.onSaved(saved, text);
      const rev = saved.valueChain?.headRev;
      toast({
        tone: 'success',
        title:
          saved.outcome === 'revived'
            ? `Wiederhergestellt als r${rev}`
            : saved.outcome === 'created'
              ? `Angelegt als r${rev}`
              : `Gespeichert als r${rev}`,
        description: impactSentence(saved.impact),
      });
      set(
        sameImpact(saved.impact, dry.impact) ? { phase: 'idle' } : { phase: 'result', saved, dry },
      );
    } catch (error) {
      fail(error, text);
    }
  }

  /** Starts a save: export, no-op check, pre-check, dry run, then confirm or save. */
  async function save() {
    if (state.phase !== 'idle' && state.phase !== 'invalid') return;
    let text: string;
    try {
      text = exportCanonical();
    } catch (error) {
      set({
        phase: 'error',
        title: 'Die Zeichnung ist so kein gültiges Dokument',
        description: errorMessage(error),
        reload: false,
      });
      return;
    }
    if (latest.current.base.text !== null && text === latest.current.base.text) {
      set({ phase: 'idle' });
      toast({
        tone: 'info',
        title: 'Keine Änderungen',
        description: 'Seit dem letzten Speichern hat sich nichts geändert.',
      });
      return;
    }
    const check = precheck(text);
    if (check.problems.length > 0) {
      set({
        phase: 'error',
        title: 'Kette zu groß',
        description: check.problems.join(' '),
        reload: false,
      });
      return;
    }
    set({ phase: 'checking', text });
    let dry: SaveValueChainResult;
    try {
      dry = await put(text, true);
    } catch (error) {
      fail(error, text);
      return;
    }
    if (dry.outcome === 'unchanged') {
      unchanged(dry, text);
      return;
    }
    if (needsConfirmation(dry.impact)) set({ phase: 'confirm', text, dry });
    else await commit(text, dry, false);
  }

  /** Saves after the impact dialog. */
  async function confirm() {
    if (state.phase !== 'confirm') return;
    await commit(state.text, state.dry, true);
  }

  return {
    state,
    save: () => void save(),
    confirm: () => void confirm(),
    reset: () => dispatch({ type: 'reset' }),
    busy: state.phase === 'checking' || state.phase === 'saving',
  };
}
