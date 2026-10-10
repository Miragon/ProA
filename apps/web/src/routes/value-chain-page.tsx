import type { SaveValueChainResult } from '@proa/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker } from '@tanstack/react-router';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileUpIcon,
  ImageDownIcon,
  MaximizeIcon,
  PencilIcon,
  Redo2Icon,
  SaveIcon,
  TriangleAlertIcon,
  Undo2Icon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import { lazy, Suspense, useMemo, useRef, useState } from 'react';

import { MiragonMark } from '@/components/page-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import type {
  CanvasElementInfo,
  CanvasOverlay,
  ChainCanvasDocument,
  ChainCanvasHandle,
} from '@/components/value-chain/chain-canvas-types';
import { ChainOverview } from '@/components/value-chain/chain-overview';
import { EmptyChain } from '@/components/value-chain/empty-chain';
import type { PlacementOutcome } from '@/components/value-chain/placement-decision-panel';
import {
  ConflictDialog,
  DiscardDialog,
  DraftDialog,
  ImpactDialog,
  ImportConfirmDialog,
  MessageDialog,
  ResultDialog,
  ViolationsPanel,
} from '@/components/value-chain/save-dialogs';
import { StepPanel } from '@/components/value-chain/step-panel';
import { ApiError, errorMessage } from '@/lib/api';
import { downloadText } from '@/lib/download';
import { clearDraft, draftOffer, listDrafts, writeDraft, type DraftRef } from '@/lib/drafts';
import { formatDateTime } from '@/lib/labels';
import { OUTSIDE_STEP } from '@/lib/limits';
import {
  chainRevisionQuery,
  keys,
  modelsQuery,
  placementsQuery,
  projectQuery,
  unplacedQuery,
  valueChainContentQuery,
  valueChainQuery,
} from '@/lib/queries';
import { toast } from '@/lib/toast';
import { useProjectFacts } from '@/lib/use-project-facts';
import { useShortcuts } from '@/lib/use-shortcuts';
import {
  documentFileName,
  drillDownTarget,
  placementQueue,
  processOptions,
  queueNeighbours,
  stepBadge,
  stepOptions as buildStepOptions,
  stepsMissingFromCanvas,
  type DrillDownTarget,
} from '@/lib/value-chain';
import { IMPORT_ACCEPT, importErrorText, readImportFile } from '@/lib/value-chain-import';
import { impactDialogOf, useChainSave } from '@/lib/value-chain-save';

import { valueChainRoute } from './value-chain';

const ChainCanvas = lazy(() => import('@/components/value-chain/canvas/chain-canvas'));

interface EditBase {
  /** The revision the edit started from; 0 before the chain exists. */
  rev: number;
  text: string | null;
  /** `vch_…`, or `new` for a chain not created yet (draft key). */
  chainId: string;
}

/** Finding labels on the canvas; "nichts angenommen" also on a step with proposals or holds. */
const FINDING_LABELS = {
  'step-without-process': 'nichts angenommen',
  'unresolved-link': 'Link ungelöst',
} as const;

/** The page of `valueChainRoute` (see there). */
export function ValueChainPage() {
  const { project } = valueChainRoute.useParams();
  const search = valueChainRoute.useSearch();
  const navigate = valueChainRoute.useNavigate();
  const queryClient = useQueryClient();
  const canvas = useRef<ChainCanvasHandle>(null);

  const info = useQuery(projectQuery(project));
  const canReview = info.data !== undefined && info.data.role !== 'viewer';
  const detailQ = useQuery(valueChainQuery(project));
  const detail = detailQ.data;
  const missing = detailQ.error instanceof ApiError && detailQ.error.status === 404;
  const exists = detail !== undefined;
  const contentQ = useQuery({ ...valueChainContentQuery(project), enabled: exists });
  const placementsQ = useQuery({ ...placementsQuery(project), enabled: exists });
  const unplacedQ = useQuery({ ...unplacedQuery(project), enabled: exists });
  const revisionQ = useQuery({ ...chainRevisionQuery(project), enabled: exists });
  const models = useQuery(modelsQuery(project));
  const { byModel } = useProjectFacts(project, models.data);
  const processes = useMemo(() => processOptions(byModel.values()), [byModel]);
  const modelKeys = useMemo(() => new Set((models.data ?? []).map((m) => m.key)), [models.data]);
  const placements = useMemo(() => placementsQ.data ?? [], [placementsQ.data]);
  const steps = useMemo(() => detail?.steps ?? [], [detail]);
  const stepChoices = useMemo(() => buildStepOptions(steps, { outside: true }), [steps]);

  // ------------------------------------------------------------ edit state
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [base, setBase] = useState<EditBase | null>(null);
  // The same, for callbacks that run before the next render (a save's answer, a debounced change).
  const baseRef = useRef<EditBase | null>(null);
  const updateBase = (next: EditBase | null) => {
    baseRef.current = next;
    setBase(next);
  };
  const [editDoc, setEditDoc] = useState<{ n: number; text: string | null; relayout?: boolean }>({
    n: 0,
    text: null,
  });
  /** The number of the last edit document (its key is `edit:<n>`). */
  const docSeq = useRef(0);
  /** An imported file whose document the canvas has not reported imported yet. */
  const importing = useRef<{ key: string; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * A checked file waiting for the user to confirm that it replaces the
   * drawing, or (`draftSavedAt`) the stored draft of a new chain.
   */
  const [pendingImport, setPendingImport] = useState<{
    name: string;
    text: string;
    draftSavedAt?: string;
  } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [canvasInfo, setCanvasInfo] = useState<CanvasElementInfo | null>(null);
  const [canvasIds, setCanvasIds] = useState<ReadonlySet<string> | null>(null);
  const [chainName, setChainName] = useState('');
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [warnings, setWarnings] = useState<number | null>(null);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [draftPrompt, setDraftPrompt] = useState<{
    kind: 'restore' | 'download';
    baseRev: number;
    savedAt: string;
    headRev: number;
    text: string;
  } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [panelFocus, setPanelFocus] = useState(false);
  /** The refused save whose violations the user closed (a new refusal shows again). */
  const [closedInvalid, setClosedInvalid] = useState<object | null>(null);

  const draftRef = (b: EditBase): DraftRef => ({ project, chainId: b.chainId, baseRev: b.rev });
  const emptyName = info.data?.name
    ? `${info.data.name} – Wertschöpfungskette`
    : 'Wertschöpfungskette';

  /**
   * Shows `text` as the next edit document; an imported file (`imported`: its
   * name) is re-laid out by the canvas and reported when it is on the canvas.
   */
  function loadDoc(text: string | null, imported?: string) {
    const n = ++docSeq.current;
    setEditDoc(imported === undefined ? { n, text } : { n, text, relayout: true });
    importing.current = imported === undefined ? null : { key: `edit:${n}`, name: imported };
  }

  const canvasDoc: ChainCanvasDocument | null =
    mode === 'edit' && base
      ? {
          key: `edit:${editDoc.n}`,
          text: editDoc.text,
          emptyName,
          ...(editDoc.relayout ? { relayout: true } : {}),
        }
      : contentQ.data
        ? { key: `view:r${contentQ.data.rev}`, text: contentQ.data.text, emptyName }
        : null;

  /** Reads what the panel shows from the canvas (edit mode): selection, ids, name, undo. */
  function readCanvas(selected: string | null) {
    const handle = canvas.current;
    if (mode !== 'edit' || !handle) return;
    try {
      setCanvasInfo(selected ? handle.elementInfo(selected) : null);
      setCanvasIds(new Set(handle.elementIds()));
      setChainName(handle.chainName());
      setHistory({ undo: handle.canUndo(), redo: handle.canRedo() });
    } catch {
      // the canvas is being replaced
    }
  }

  /** The drawing as canonical text; `null` while it is not a valid document. */
  function exportOrNull(): string | null {
    try {
      return canvas.current?.exportCanonical() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Compares the drawing with its base now, sets `dirty` and keeps the draft
   * (written while dirty, cleared when the drawing equals its base again).
   * A new chain's base is the empty document. While the draft dialog asks,
   * drafts are left alone: its answer decides about them.
   */
  function recomputeDirty(): boolean {
    const b = baseRef.current;
    const handle = canvas.current;
    if (mode !== 'edit' || !b) return false;
    if (!handle) return dirty;
    const text = exportOrNull();
    let clean = b.text;
    try {
      clean ??= handle.emptyText(emptyName);
    } catch {
      // the canvas is being replaced; keep comparing with the base text
    }
    const isDirty = text === null || text !== clean;
    setDirty(isDirty);
    if (text !== null && draftPrompt === null) {
      if (isDirty) writeDraft(draftRef(b), text);
      else clearDraft(draftRef(b));
    }
    return isDirty;
  }

  function onCanvasChange(): boolean {
    readCanvas(selectedId);
    return recomputeDirty();
  }

  /**
   * Whether there are unsaved changes right now. The canvas reports changes
   * 300 ms late; an edit committed by the click that asks (a name field left
   * by clicking „Fertig“ or a link) is taken at once.
   */
  function dirtyNow(): boolean {
    if (mode !== 'edit') return false;
    return canvas.current?.takePendingChange() ? onCanvasChange() : dirty;
  }

  const save = useChainSave({
    project,
    base: base ?? { rev: 0, text: null },
    exportCanonical: () => {
      if (!canvas.current) throw new Error('Die Zeichnung ist noch nicht geladen.');
      return canvas.current.exportCanonical();
    },
    onSaved: (result: SaveValueChainResult, text: string) => {
      const chain = result.valueChain;
      const before = baseRef.current;
      if (!chain || !before) return;
      clearDraft(draftRef(before));
      const next = { rev: chain.headRev, text, chainId: chain.id };
      updateBase(next);
      // `text` is what was saved; an edit made while the request ran stays unsaved (and a draft).
      canvas.current?.takePendingChange();
      onCanvasChange();
      void queryClient.invalidateQueries({ queryKey: keys.project(project) });
      // The stored bytes are canonical like ours; if they ever differ, show what was stored.
      void queryClient
        .fetchQuery({ ...valueChainContentQuery(project), staleTime: 0 })
        .then((stored) => {
          const now = baseRef.current;
          if (stored.rev !== next.rev || stored.text === text || now?.rev !== next.rev) return;
          const untouched = exportOrNull() === text;
          updateBase({ ...now, text: stored.text });
          // Never replace an edit made since the save.
          if (untouched) loadDoc(stored.text);
          else recomputeDirty();
        })
        .catch(() => undefined);
    },
  });
  const saveState = save.state;
  const invalidShown = saveState.phase === 'invalid' && saveState !== closedInvalid;

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname && dirtyNow(),
    // The draft survives a reload; only leaving within the app asks.
    enableBeforeUnload: false,
    withResolver: true,
  });

  // ------------------------------------------------------------ selection
  const queue = useMemo(() => placementQueue(placements, steps), [placements, steps]);
  const activePlacement = search.placement
    ? placements.find((p) => p.id === search.placement)
    : undefined;
  const selectedId =
    search.step ??
    (activePlacement && activePlacement.stepLive && activePlacement.elementId !== OUTSIDE_STEP
      ? activePlacement.elementId
      : null);
  const activeId =
    activePlacement && (search.step === undefined || activePlacement.elementId === search.step)
      ? activePlacement.id
      : selectedId
        ? (queue.find((p) => p.elementId === selectedId)?.id ?? null)
        : null;
  const nav = queueNeighbours(queue, activeId);
  const shortcuts = mode === 'view' || panelFocus;

  /** The tree item that takes the focus when the overview opens again ("Zur Übersicht"). */
  const [returnFocus, setReturnFocus] = useState<string | null>(null);

  const selectStep = (id: string | null) => {
    // The canvas echoes the page's own selection (also the active placement's step): no change.
    if (id === selectedId) return;
    if (id !== null) setReturnFocus(null);
    void navigate({ search: id ? { step: id } : {}, replace: true });
  };
  /** "Zur Übersicht" or Escape in the step panel: back to the overview, focus on that step. */
  const backToOverview = () => {
    setReturnFocus(selectedId);
    void navigate({ search: {}, replace: true });
  };
  const selectPlacement = (id: string) =>
    void navigate({ search: { placement: id }, replace: true });

  useShortcuts(
    {
      j: () => nav.next && selectPlacement(nav.next.id),
      k: () => nav.previous && selectPlacement(nav.previous.id),
    },
    shortcuts,
  );

  function onDecided(placementId: string, outcome: PlacementOutcome) {
    const n = queueNeighbours(queue, placementId);
    if (n.index < 0) return;
    if (n.next) selectPlacement(n.next.id);
    else {
      toast({
        tone: 'info',
        title: 'Alles geprüft',
        description:
          outcome === 'hold'
            ? 'Vorgemerkte Platzierungen bleiben auf ihren Schritten sichtbar.'
            : 'Keine Platzierung wartet mehr auf dich.',
      });
      void navigate({ search: {}, replace: true });
    }
  }

  const reload = () => void queryClient.invalidateQueries({ queryKey: keys.project(project) });

  function openTarget(target: DrillDownTarget) {
    if (target.kind === 'model') {
      void navigate({
        to: '/projects/$project/models/$',
        params: { project, _splat: target.modelKey },
        search: { element: target.elementId },
      });
    } else {
      void navigate({
        to: '/projects/$project/value-chain/steps/$elementId',
        params: { project, elementId: target.elementId },
      });
    }
  }

  // ------------------------------------------------------------ edit flow
  /**
   * Edits `next`; with `imported`, the drawing starts as that file (a new
   * chain from a draft) and becomes the draft once it is on the canvas: the
   * import asked before it replaced a stored draft, so none is offered here.
   */
  function startEdit(next: EditBase, imported?: { name: string; text: string }) {
    updateBase(next);
    if (imported) loadDoc(imported.text, imported.name);
    else loadDoc(next.text);
    setDirty(false);
    save.reset();
    setMode('edit');
    if (imported) return;
    const offer = draftOffer(listDrafts(project, next.chainId), next.rev);
    if (offer.kind !== 'none') {
      setDraftPrompt({
        kind: offer.kind,
        baseRev: offer.draft.baseRev,
        savedAt: offer.draft.savedAt,
        headRev: next.rev,
        text: offer.draft.text,
      });
    }
  }

  function enterEdit() {
    if (!detail || !contentQ.data) return;
    startEdit({ rev: contentQ.data.rev, text: contentQ.data.text, chainId: detail.valueChain.id });
  }

  function finishEdit() {
    setMode('view');
    updateBase(null);
    setDirty(false);
    setCanvasInfo(null);
    setCanvasIds(null);
    save.reset();
  }

  function discard() {
    const b = baseRef.current;
    if (b) clearDraft(draftRef(b));
    setLeaving(false);
    finishEdit();
    if (!exists) void navigate({ search: {}, replace: true });
  }

  async function loadNewer(localText: string | null) {
    const b = baseRef.current;
    if (!b) return;
    if (localText !== null) {
      downloadText(documentFileName(project, b.rev || null, true), localText, 'application/json');
    }
    clearDraft(draftRef(b));
    save.reset();
    try {
      const [fresh, chain] = await Promise.all([
        queryClient.fetchQuery({ ...valueChainContentQuery(project), staleTime: 0 }),
        queryClient.fetchQuery({ ...valueChainQuery(project), staleTime: 0 }),
      ]);
      updateBase({ rev: fresh.rev, text: fresh.text, chainId: chain.valueChain.id });
      loadDoc(fresh.text);
      setDirty(false);
      toast({
        tone: 'info',
        title: `r${fresh.rev} geladen`,
        description: 'Du bearbeitest jetzt die neueste Revision.',
      });
    } catch (error) {
      toast({
        tone: 'danger',
        title: 'Neuere Revision nicht geladen',
        description: errorMessage(error),
      });
    }
    reload();
  }

  // ------------------------------------------------------------ import
  function importFailed(description: string) {
    toast({ tone: 'danger', title: 'Import nicht möglich', description });
  }

  /** Whether the drawing has elements (the canvas is being replaced: none). */
  function hasContent(): boolean {
    try {
      return (canvas.current?.elementIds().length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** Replaces the drawing with a checked file (edit mode), or starts a new chain from it. */
  function applyImport(name: string, text: string) {
    setPendingImport(null);
    if (mode === 'edit' && baseRef.current) loadDoc(text, name);
    else startEdit({ rev: 0, text: null, chainId: 'new' }, { name, text });
  }

  /**
   * A file chosen for the import (M4 §3.3): at most 2 MB of JSON, then the
   * schema check of the canvas chunk; errors in German. A drawing with
   * content or unsaved edits is replaced only after the user confirms.
   */
  async function onImportFile(file: File) {
    const read = await readImportFile(file);
    if (!read.ok) {
      importFailed(read.message);
      return;
    }
    let problem: string | null;
    try {
      const { checkDocument } = await import('@/components/value-chain/canvas/check-document');
      problem = importErrorText(file.name, checkDocument(read.json));
    } catch (error) {
      problem = errorMessage(error);
    }
    if (problem !== null) {
      importFailed(problem);
      return;
    }
    if (mode === 'edit' && (dirtyNow() || hasContent())) {
      setPendingImport({ name: file.name, text: read.text });
      return;
    }
    // A new chain from the file over a stored draft of a new chain: ask, as for any drawing.
    const stored = mode === 'edit' ? null : draftOffer(listDrafts(project, 'new'), 0);
    if (stored && stored.kind !== 'none') {
      setPendingImport({ name: file.name, text: read.text, draftSavedAt: stored.draft.savedAt });
      return;
    }
    applyImport(file.name, read.text);
  }

  function downloadDocument() {
    const editing = mode === 'edit';
    const text = editing ? exportOrNull() : (contentQ.data?.text ?? null);
    if (text === null) {
      if (editing)
        toast({
          tone: 'danger',
          title: 'Nicht heruntergeladen',
          description: 'Die Zeichnung ist so kein gültiges Dokument.',
        });
      return;
    }
    const draft = editing && dirtyNow();
    const rev = mode === 'edit' ? (base?.rev ?? null) : (contentQ.data?.rev ?? null);
    downloadText(documentFileName(project, rev || null, draft), text, 'application/json');
  }

  function downloadSvg() {
    try {
      const svg = canvas.current?.saveSVG();
      if (svg) downloadText(`${project}-wertschoepfungskette.svg`, svg, 'image/svg+xml');
    } catch (error) {
      toast({ tone: 'danger', title: 'SVG nicht erzeugt', description: errorMessage(error) });
    }
  }

  // ------------------------------------------------------------ overlays
  const overlays = useMemo<CanvasOverlay[]>(() => {
    if (!detail) return [];
    const findings = new Map<string, string[]>();
    for (const f of detail.findings) {
      if (f.kind === 'process-without-step' || f.elementId === null) continue;
      findings.set(f.elementId, [...(findings.get(f.elementId) ?? []), FINDING_LABELS[f.kind]]);
    }
    return detail.steps.map((s) => {
      const badge = stepBadge(s.elementId, detail.placements);
      return {
        elementId: s.elementId,
        badge: badge ? { text: badge.text, tone: badge.tone } : null,
        findings: findings.get(s.elementId) ?? [],
      };
    });
  }, [detail]);

  const invalidIds = useMemo(
    () =>
      saveState.phase === 'invalid' && invalidShown
        ? saveState.violations.flatMap((v) =>
            [v.elementId, v.connectionId].filter((x): x is string => x !== null),
          )
        : [],
    [saveState, invalidShown],
  );

  // ------------------------------------------------------------ render
  const selectedStep = selectedId ? steps.find((s) => s.elementId === selectedId) : undefined;
  const selectedOrg = selectedId
    ? detail?.orgUnits.find((o) => o.elementId === selectedId)
    : undefined;
  const panelForSelection =
    selectedId !== null &&
    (selectedStep !== undefined ||
      selectedOrg !== undefined ||
      (mode === 'edit' && canvasInfo?.id === selectedId));
  const headAhead =
    mode === 'edit' && base && base.rev > 0 && contentQ.data && contentQ.data.rev > base.rev
      ? contentQ.data.rev
      : null;
  const unplacedCount = unplacedQ.data?.length ?? null;
  const newest = revisionQ.data;
  const loadError =
    detailQ.error && !missing ? detailQ.error : (contentQ.error ?? placementsQ.error);
  const showCanvas = canvasDoc !== null && (exists || mode === 'edit');
  const empty = missing && mode === 'view';

  return (
    <div
      className="relative h-svh w-full overflow-hidden bg-paper bg-[radial-gradient(var(--cd-linie)_1px,transparent_1px)] [background-size:16px_16px]"
      data-testid="value-chain-page"
      data-mode={mode}
    >
      {showCanvas ? (
        // `isolate`: the modeler's context pad and popups (z-index 100) stay below dialogs.
        <div className="absolute inset-y-0 right-0 left-0 isolate lg:right-[468px]">
          <Suspense
            fallback={
              <div className="absolute inset-0 grid place-items-center">
                <Spinner />
              </div>
            }
          >
            <ChainCanvas
              ref={canvas}
              mode={mode}
              document={canvasDoc}
              overlays={overlays}
              selectedId={selectedId}
              invalidIds={invalidIds}
              dirty={dirty}
              onSelect={(id) => {
                readCanvas(id);
                selectStep(id);
              }}
              onOpen={(id) => {
                const step = steps.find((s) => s.elementId === id);
                openTarget(step ? drillDownTarget(step) : { kind: 'step', elementId: id });
              }}
              onChange={onCanvasChange}
              onImported={({ key, warnings: count }) => {
                setWarnings(count);
                setCanvasError(null);
                readCanvas(selectedId);
                const imported = importing.current;
                if (imported?.key === key) {
                  importing.current = null;
                  // The imported drawing differs from the base: unsaved, kept as a draft.
                  recomputeDirty();
                  toast({
                    tone: 'info',
                    title: `„${imported.name}“ importiert`,
                    description:
                      'Prüfe die Zeichnung und speichere sie; gespeichert wird erst mit „Speichern“.',
                  });
                }
              }}
              onError={(message) => {
                setCanvasError(message);
                toast({
                  tone: 'danger',
                  title: 'Kette konnte nicht angezeigt werden',
                  description: message,
                });
              }}
            />
          </Suspense>
          {/* bottom right: zoom */}
          <div
            className="absolute right-4 bottom-16 z-30 flex flex-col gap-1 rounded-lg border bg-card p-1 shadow-sm"
            role="group"
            aria-label="Zoom"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Vergrößern"
              onClick={() => canvas.current?.zoom(1.2)}
            >
              <ZoomInIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Verkleinern"
              onClick={() => canvas.current?.zoom(1 / 1.2)}
            >
              <ZoomOutIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Ganze Kette zeigen"
              onClick={() => canvas.current?.fit()}
            >
              <MaximizeIcon />
            </Button>
          </div>
          {/* bottom left: legend */}
          <div
            className="absolute bottom-4 left-4 z-30 flex max-w-[calc(100%-96px)] flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm"
            data-testid="chain-legend"
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="proa-vc-badge" data-tone="neutral">
                2 Prozesse
              </span>
              angenommen oder vorgemerkt
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="proa-vc-badge" data-tone="warning">
                1 offen
              </span>
              zu prüfen
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="proa-vc-badge" data-tone="finding">
                nichts angenommen
              </span>
              Befund
            </span>
            <span>Lila = Management, Grün = Unterstützung, Vorgänger-Kette = Kern</span>
            {mode === 'view' ? <span>Doppelklick öffnet den Schritt.</span> : null}
          </div>
        </div>
      ) : null}

      {empty ? (
        <div className="absolute inset-0 z-20 grid place-items-center overflow-y-auto p-4 pt-36">
          <div className="w-[min(560px,100%)]">
            <EmptyChain
              project={project}
              canReview={canReview}
              onCreate={() => startEdit({ rev: 0, text: null, chainId: 'new' })}
              onImport={() => fileInput.current?.click()}
            />
          </div>
        </div>
      ) : null}

      {/* top left: where am I, revision, mode */}
      <header className="absolute top-4 left-4 z-30 flex max-w-[calc(100vw-32px)] flex-col gap-2 rounded-xl border bg-card/90 p-2 text-sm shadow-md backdrop-blur-sm lg:max-w-[calc(100vw-516px)]">
        <div className="flex flex-wrap items-center gap-1">
          <Link to="/" aria-label="Zu den Projekten" className="px-1">
            <MiragonMark className="size-5" />
          </Link>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/projects/$project" params={{ project }}>
              <ChevronLeftIcon data-icon="inline-start" />
              <span className="max-w-48 truncate">{info.data?.name ?? project}</span>
            </Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/projects/$project" params={{ project }}>
              Modelle
            </Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/projects/$project/review" params={{ project }}>
              Prüfen
            </Link>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-1">
          <h1 className="truncate text-base font-semibold" data-testid="chain-name">
            {mode === 'edit' && chainName
              ? chainName
              : (detail?.valueChain.name ?? 'Wertschöpfungskette')}
          </h1>
          {mode === 'edit' && base ? (
            <Badge variant="outline" data-testid="chain-rev">
              {base.rev > 0 ? `r${base.rev}` : 'neu'}
            </Badge>
          ) : detail ? (
            <Badge variant="outline" data-testid="chain-rev">
              r{detail.valueChain.headRev}
            </Badge>
          ) : null}
          {mode === 'view' && newest ? (
            <span className="text-xs text-muted-foreground">
              gespeichert von <span className="font-mono">{newest.handle}</span> ·{' '}
              {formatDateTime(newest.createdAt)}
            </span>
          ) : null}
          {mode === 'edit' && dirty ? (
            <Badge
              variant="outline"
              className="border-warning bg-warning-soft text-warning"
              data-testid="unsaved"
            >
              Ungespeichert
            </Badge>
          ) : null}
          {mode === 'view' && unplacedCount !== null && unplacedCount > 0 ? (
            <button
              type="button"
              onClick={() => void navigate({ search: {}, replace: true })}
              className="rounded-sm bg-warning-soft px-1.5 text-xs text-warning hover:underline"
              data-testid="unplaced-chip"
            >
              {unplacedCount === 1
                ? '1 Prozess ohne Schritt'
                : `${unplacedCount} Prozesse ohne Schritt`}
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {mode === 'view' ? (
            <>
              {canReview && exists ? (
                <Button
                  size="sm"
                  onClick={enterEdit}
                  disabled={!contentQ.data}
                  data-testid="edit-chain"
                >
                  <PencilIcon data-icon="inline-start" />
                  Bearbeiten
                </Button>
              ) : null}
              {exists ? (
                <>
                  <Button variant="ghost" size="sm" onClick={downloadDocument}>
                    <DownloadIcon data-icon="inline-start" />
                    .vc.json
                  </Button>
                  <Button variant="ghost" size="sm" onClick={downloadSvg}>
                    <ImageDownIcon data-icon="inline-start" />
                    SVG
                  </Button>
                </>
              ) : null}
              {exists ? (
                <span
                  className="ml-1 hidden items-center gap-1 text-xs text-muted-foreground xl:inline-flex"
                  data-testid="key-hint"
                >
                  <Kbd>J</Kbd>
                  <Kbd>K</Kbd> Platzierungen
                  {canReview ? (
                    <>
                      {' '}
                      · <Kbd>A</Kbd> <Kbd>R</Kbd> <Kbd>H</Kbd> <Kbd>C</Kbd> entscheiden
                    </>
                  ) : null}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <Button size="sm" onClick={save.save} disabled={save.busy} data-testid="save-chain">
                {save.busy ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <SaveIcon data-icon="inline-start" />
                )}
                Speichern
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Rückgängig"
                title="Rückgängig (Strg+Z)"
                disabled={!history.undo}
                onClick={() => canvas.current?.undo()}
              >
                <Undo2Icon />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Wiederholen"
                title="Wiederholen (Strg+Y)"
                disabled={!history.redo}
                onClick={() => canvas.current?.redo()}
              >
                <Redo2Icon />
              </Button>
              <Button variant="ghost" size="sm" onClick={downloadDocument}>
                <DownloadIcon data-icon="inline-start" />
                .vc.json
              </Button>
              {canReview ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                  data-testid="import-chain"
                >
                  <FileUpIcon data-icon="inline-start" />
                  Importieren
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                data-testid="finish-edit"
                onClick={() => (dirtyNow() ? setLeaving(true) : finishEdit())}
              >
                Fertig
              </Button>
            </>
          )}
        </div>
      </header>

      {/* right: the panel */}
      {empty ? null : (
        <aside
          aria-label="Wertschöpfungskette: Details"
          onFocus={() => setPanelFocus(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setPanelFocus(false);
          }}
          className="absolute top-4 right-4 bottom-4 z-30 flex w-[440px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border bg-card/95 shadow-md backdrop-blur-sm"
        >
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
            {warnings !== null && warnings > 0 ? (
              <Alert data-testid="import-warnings">
                <TriangleAlertIcon />
                <AlertTitle className="flex items-center gap-2">
                  {warnings === 1 ? '1 Element übersprungen' : `${warnings} Elemente übersprungen`}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="ml-auto"
                    aria-label="Hinweis schließen"
                    onClick={() => setWarnings(null)}
                  >
                    <XIcon />
                  </Button>
                </AlertTitle>
                <AlertDescription>Der Renderer konnte nicht alles anzeigen.</AlertDescription>
              </Alert>
            ) : null}
            {headAhead !== null ? (
              <Alert className="border-warning bg-warning-soft" data-testid="head-ahead">
                <TriangleAlertIcon className="text-warning" />
                <AlertTitle>Inzwischen gibt es r{headAhead}</AlertTitle>
                <AlertDescription className="text-foreground">
                  Du bearbeitest r{base?.rev}. Speichern führt zu einem Konflikt; ProA führt nichts
                  zusammen.
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => void loadNewer(dirtyNow() ? exportOrNull() : null)}
                  >
                    Neuere Revision laden
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {saveState.phase === 'invalid' && invalidShown ? (
              <ViolationsPanel
                violations={saveState.violations}
                truncated={saveState.truncated}
                nameOf={(id) => {
                  try {
                    return canvas.current?.elementInfo(id)?.name ?? null;
                  } catch {
                    return null;
                  }
                }}
                onSelect={(id) => {
                  if (canvas.current?.elementInfo(id)) selectStep(id);
                }}
                onClose={() => setClosedInvalid(saveState)}
              />
            ) : null}
            {canvasError ? (
              <Alert variant="destructive">
                <AlertTitle>Die Kette lässt sich nicht anzeigen</AlertTitle>
                <AlertDescription>{canvasError}</AlertDescription>
              </Alert>
            ) : null}

            {loadError ? (
              <Alert variant="destructive">
                <AlertTitle>Die Kette konnte nicht geladen werden</AlertTitle>
                <AlertDescription>{errorMessage(loadError)}</AlertDescription>
              </Alert>
            ) : panelForSelection && selectedId ? (
              <StepPanel
                key={selectedId}
                project={project}
                elementId={selectedId}
                step={selectedStep}
                orgUnit={selectedOrg}
                detail={detail}
                placements={placements}
                mode={mode}
                canReview={canReview}
                canvasInfo={mode === 'edit' && canvasInfo?.id === selectedId ? canvasInfo : null}
                processes={processes}
                stepOptions={stepChoices}
                modelKeys={modelKeys}
                activePlacementId={activeId}
                shortcuts={shortcuts}
                onSelectStep={selectStep}
                onBack={backToOverview}
                onSelectPlacement={selectPlacement}
                onDecided={onDecided}
                onReload={reload}
                onOpen={openTarget}
                onSetName={(name) => canvas.current?.setName(selectedId, name)}
                onSetColor={(color) => canvas.current?.setColor(selectedId, color)}
                onSetLink={(link) => canvas.current?.setLink(selectedId, link)}
              />
            ) : detail || mode === 'edit' ? (
              <ChainOverview
                project={project}
                detail={detail}
                placements={placements}
                unplaced={unplacedQ.data}
                modelKeys={modelKeys}
                stepOptions={stepChoices}
                canReview={canReview}
                mode={mode}
                activePlacementId={activeId}
                shortcuts={shortcuts}
                onSelectStep={selectStep}
                onSelectPlacement={selectPlacement}
                onDecided={onDecided}
                onReload={reload}
                chainName={chainName}
                onChainName={(name) => canvas.current?.setChainName(name)}
                missingSteps={detail && canvasIds ? stepsMissingFromCanvas(detail, canvasIds) : []}
                focusStepId={returnFocus}
              />
            ) : (
              <div className="grid h-full place-items-center">
                <Spinner className="size-6" />
              </div>
            )}
          </div>
          {activeId && queue.length > 0 ? (
            <div className="flex items-center gap-2 border-t bg-card px-4 py-2 text-xs text-muted-foreground">
              <span className="tabular-nums" data-testid="queue-position">
                {nav.index >= 0
                  ? `${nav.index + 1} von ${queue.length} offen`
                  : `${queue.length} offen`}
              </span>
              <Button
                variant="outline"
                size="icon-xs"
                className="ml-auto"
                aria-label="Vorherige Platzierung (K)"
                disabled={!nav.previous}
                onClick={() => nav.previous && selectPlacement(nav.previous.id)}
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                variant="outline"
                size="icon-xs"
                aria-label="Nächste Platzierung (J)"
                disabled={!nav.next}
                onClick={() => nav.next && selectPlacement(nav.next.id)}
              >
                <ChevronRightIcon />
              </Button>
            </div>
          ) : null}
        </aside>
      )}

      {canReview ? (
        <input
          ref={fileInput}
          type="file"
          accept={IMPORT_ACCEPT}
          className="hidden"
          data-testid="import-file"
          aria-label="Wertschöpfungskette importieren (.vc.json)"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            // The same file can be chosen again after a refusal.
            e.currentTarget.value = '';
            if (file) void onImportFile(file);
          }}
        />
      ) : null}
      <ImportConfirmDialog
        fileName={pendingImport?.name ?? null}
        draftSavedAt={pendingImport?.draftSavedAt ?? null}
        onReplace={() => pendingImport && applyImport(pendingImport.name, pendingImport.text)}
        onCancel={() => setPendingImport(null)}
      />
      <ImpactDialog
        dry={impactDialogOf(saveState)}
        pending={saveState.phase === 'saving'}
        onConfirm={save.confirm}
        onCancel={save.reset}
      />
      <ResultDialog
        saved={saveState.phase === 'result' ? saveState.saved : null}
        onClose={save.reset}
      />
      <ConflictDialog
        open={saveState.phase === 'conflict'}
        baseRev={base?.rev ?? 0}
        headRev={saveState.phase === 'conflict' ? saveState.headRev : null}
        onLoadNewer={() => void loadNewer(saveState.phase === 'conflict' ? saveState.text : null)}
        onKeepEditing={save.reset}
      />
      <MessageDialog
        message={saveState.phase === 'error' ? saveState : null}
        onClose={save.reset}
        extra={
          saveState.phase === 'error' && saveState.reload && mode === 'edit' ? (
            <Button variant="outline" onClick={downloadDocument}>
              <DownloadIcon data-icon="inline-start" />
              Deine Fassung herunterladen
            </Button>
          ) : null
        }
      />
      <DraftDialog
        draft={draftPrompt}
        onRestore={() => {
          if (!draftPrompt) return;
          // The draft stays stored until it is saved or discarded; the import never touches it.
          loadDoc(draftPrompt.text);
          setDirty(true);
        }}
        onDownload={() => {
          if (!draftPrompt) return;
          downloadText(
            documentFileName(project, draftPrompt.baseRev || null, true),
            draftPrompt.text,
            'application/json',
          );
        }}
        onDiscard={() => {
          if (!draftPrompt) return;
          clearDraft({
            project,
            chainId: baseRef.current?.chainId ?? 'new',
            baseRev: draftPrompt.baseRev,
          });
        }}
        onClose={() => setDraftPrompt(null)}
      />
      <DiscardDialog
        open={leaving || blocker.status === 'blocked'}
        title={blocker.status === 'blocked' ? 'Seite verlassen?' : 'Bearbeitung beenden?'}
        onDiscard={() => {
          const b = baseRef.current;
          if (b) clearDraft(draftRef(b));
          if (blocker.status === 'blocked') {
            setDirty(false);
            blocker.proceed();
          } else discard();
        }}
        onStay={() => {
          setLeaving(false);
          if (blocker.status === 'blocked') blocker.reset();
        }}
      />
    </div>
  );
}
