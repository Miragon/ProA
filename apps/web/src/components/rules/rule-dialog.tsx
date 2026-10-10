import type {
  AgentToken,
  AutoAcceptCriteria,
  AutoAcceptKind,
  AutoAcceptRelationType,
  AutoAcceptRule,
  AutoAcceptRuleDraft,
  AutoAcceptTier,
} from '@proa/client';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { InfoIcon, PowerIcon, SaveIcon } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, errorMessage } from '@/lib/api';
import {
  AUTO_ACCEPT_KINDS,
  AUTO_ACCEPT_RELATION_TYPES,
  parsePercent,
  percentInput,
  relationTypeLabel,
  revisionChanges,
  tierLabel,
  tiersOf,
} from '@/lib/auto-accept-rules';
import { useCreateRule, useReviseRule } from '@/lib/auto-accept-rule-actions';
import {
  MAX_AUTO_ACCEPT_MODEL_CHARS,
  MAX_AUTO_ACCEPT_NAME_CHARS,
  MAX_AUTO_ACCEPT_NOTE_CHARS,
} from '@/lib/limits';
import { autoAcceptPreviewQuery, autoAcceptRuleQuery } from '@/lib/auto-accept-queries';
import { toast } from '@/lib/toast';
import { useDebounced } from '@/lib/use-debounced';

import { RulePreview } from './rule-preview';

/**
 * German texts of the server's `validation-failed` reasons for a rule (the
 * ones the domain sends; what the schema refuses comes back as `errors`,
 * which the form prevents anyway).
 */
const SAVE_PROBLEMS: Record<string, string> = {
  'name-taken': 'Eine andere Annahmeregel dieses Projekts heißt schon so.',
  'unknown-agent': 'Dieser Agent gehört nicht zu diesem Projekt.',
  'kind-changed': 'Die Art einer Regel ändert sich nie; lege eine neue Regel an.',
};

function saveProblem(error: unknown): string {
  if (error instanceof ApiError) {
    const reason = (error.problem as Record<string, unknown>)['reason'];
    if (typeof reason === 'string' && SAVE_PROBLEMS[reason]) return SAVE_PROBLEMS[reason];
  }
  return errorMessage(error);
}

const ANY = '';

/** What the preview query is keyed on while the form is invalid (it does not run then). */
const NO_CRITERIA: AutoAcceptCriteria = {
  kind: 'relation',
  tier: 'key',
  minConfidence: 1,
  relationType: null,
  agentPrincipalId: null,
  llmModel: null,
  includeAdHoc: false,
};

interface FormState {
  name: string;
  kind: AutoAcceptKind;
  tier: AutoAcceptTier;
  percent: string;
  relationType: AutoAcceptRelationType | typeof ANY;
  agentPrincipalId: string;
  llmModel: string;
  includeAdHoc: boolean;
  note: string;
}

function initialState(rule: AutoAcceptRule | null): FormState {
  if (!rule) {
    return {
      name: '',
      kind: 'relation',
      tier: 'key',
      percent: '95',
      relationType: ANY,
      agentPrincipalId: ANY,
      llmModel: '',
      includeAdHoc: false,
      note: '',
    };
  }
  return {
    name: rule.name,
    kind: rule.kind,
    tier: rule.tier,
    percent: percentInput(rule.minConfidence),
    relationType: rule.relationType ?? ANY,
    agentPrincipalId: rule.agentPrincipalId ?? ANY,
    llmModel: rule.llmModel ?? '',
    includeAdHoc: rule.includeAdHoc,
    note: rule.note ?? '',
  };
}

/**
 * The minimum confidence of the form: the rule's own value while the field
 * still shows it (never re-read from the rounded text), else what was typed.
 */
function minConfidenceOf(f: FormState, base: AutoAcceptRule | null): number | null {
  if (base && f.percent === percentInput(base.minConfidence)) return base.minConfidence;
  return parsePercent(f.percent);
}

/** The criteria of a valid form (the preview's body), else `null`. */
function criteriaOfForm(f: FormState, base: AutoAcceptRule | null): AutoAcceptCriteria | null {
  const minConfidence = minConfidenceOf(f, base);
  if (minConfidence === null || !tiersOf(f.kind).includes(f.tier)) return null;
  const model = f.llmModel.trim();
  if (model.length > MAX_AUTO_ACCEPT_MODEL_CHARS) return null;
  return {
    kind: f.kind,
    tier: f.tier,
    minConfidence,
    relationType: f.kind === 'relation' && f.relationType !== ANY ? f.relationType : null,
    agentPrincipalId: f.agentPrincipalId === ANY ? null : f.agentPrincipalId,
    llmModel: model === '' ? null : model,
    includeAdHoc: f.includeAdHoc,
  };
}

export interface RuleDialogProps {
  project: string;
  /** The rule to edit (its head revision); `null` creates a new rule. */
  rule: AutoAcceptRule | null;
  /** The project's agent tokens (revoked ones marked). */
  tokens: readonly AgentToken[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a save that wrote a revision. */
  onSaved?: (rule: AutoAcceptRule) => void;
}

function RuleForm({ project, rule, tokens, onOpenChange, onSaved }: Omit<RuleDialogProps, 'open'>) {
  const id = useId();
  const queryClient = useQueryClient();
  /** The revision the form edits: the rule as opened, or the newer one loaded after a 412. */
  const [base, setBase] = useState<AutoAcceptRule | null>(rule);
  const [form, setForm] = useState<FormState>(() => initialState(rule));
  const [conflict, setConflict] = useState<number | null>(null);
  /** After loading a newer revision: what the other owner changed. */
  const [reloaded, setReloaded] = useState<{ revision: number; changes: string[] } | null>(null);
  const [touched, setTouched] = useState(false);
  const create = useCreateRule(project);
  const revise = useReviseRule(project);
  const saving = create.isPending || revise.isPending;
  const saveError = create.error ?? revise.error;

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const criteria = useMemo(() => criteriaOfForm(form, base), [form, base]);
  const debounced = useDebounced(criteria, 300);
  const preview = useQuery({
    ...autoAcceptPreviewQuery(project, debounced ?? NO_CRITERIA),
    enabled: debounced !== null,
    placeholderData: keepPreviousData,
  });

  const name = form.name.trim();
  const nameError =
    name === ''
      ? 'Gib der Regel einen Namen.'
      : name.length > MAX_AUTO_ACCEPT_NAME_CHARS
        ? `Höchstens ${MAX_AUTO_ACCEPT_NAME_CHARS} Zeichen.`
        : null;
  const percentError =
    minConfidenceOf(form, base) === null ? 'Gib einen Wert zwischen 50 und 100 % an.' : null;
  const valid = criteria !== null && nameError === null;

  // Agents to narrow to: the project's tokens, plus agents seen in proposals (R1 services).
  const agentOptions = useMemo(() => {
    const out = tokens.map((t) => ({
      principalId: t.principalId,
      label: `${t.name}${t.revokedAt ? ' (widerrufen)' : ''}`,
    }));
    const known = new Set(out.map((o) => o.principalId));
    for (const a of preview.data?.agents ?? []) {
      if (!known.has(a.principalId)) {
        known.add(a.principalId);
        out.push({ principalId: a.principalId, label: a.handle });
      }
    }
    if (base?.agentPrincipalId && !known.has(base.agentPrincipalId)) {
      out.push({
        principalId: base.agentPrincipalId,
        label: base.agent?.handle ?? base.agentPrincipalId,
      });
    }
    return out;
  }, [tokens, preview.data?.agents, base]);

  function save(enabled: boolean) {
    setTouched(true);
    if (!valid || saving) return;
    const draft: AutoAcceptRuleDraft = {
      ...criteria,
      name,
      enabled,
      note: form.note.trim() === '' ? null : form.note.trim(),
    };
    const done = (outcome: string, saved: AutoAcceptRule) => {
      toast({
        tone: 'success',
        title:
          outcome === 'created'
            ? `Regel „${saved.name}“ angelegt${saved.enabled ? ' und aktiviert' : ''}`
            : outcome === 'unchanged'
              ? 'Nichts geändert'
              : `Regel „${saved.name}“ gespeichert (Revision ${saved.revision})`,
      });
      onOpenChange(false);
      if (outcome !== 'unchanged') onSaved?.(saved);
    };
    if (!base) {
      create.mutate(draft, { onSuccess: (r) => done(r.outcome, r.rule) });
      return;
    }
    setConflict(null);
    setReloaded(null);
    revise.mutate(
      { ruleId: base.id, revision: base.revision, draft },
      {
        onSuccess: (r) => done(r.outcome, r.rule),
        onError: (error) => {
          if (error instanceof ApiError && error.status === 412) {
            const head = (error.problem as Record<string, unknown>)['headRev'];
            setConflict(typeof head === 'number' ? head : base.revision + 1);
          }
        },
      },
    );
  }

  /**
   * After a 412: loads the head and puts it into the form, so the next save
   * builds on what the other owner saved, never silently over it. Own edits
   * are dropped; the alert lists what changed.
   */
  async function loadNewer() {
    if (!base) return;
    const fresh = await queryClient.fetchQuery({
      ...autoAcceptRuleQuery(project, base.id),
      staleTime: 0,
    });
    setReloaded({ revision: fresh.revision, changes: revisionChanges(base, fresh) });
    setBase(fresh);
    setForm(initialState(fresh));
    setConflict(null);
    revise.reset();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    save(base?.enabled ?? false);
  }

  const show412 = conflict !== null;
  const showSaveError = saveError && !(saveError instanceof ApiError && saveError.status === 412);
  const tiers = tiersOf(form.kind);

  return (
    <form onSubmit={submit} aria-label="Annahmeregel" className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{base ? `Regel „${base.name}“ bearbeiten` : 'Neue Annahmeregel'}</DialogTitle>
        <DialogDescription>
          Agentenvorschläge, die alle Kriterien erfüllen, nimmt ProA als deine Entscheidung an – nur
          neue Vorschläge, und nie, wenn eine Schutzregel greift (Frage, Einwand, Vormerkung,
          Entscheidung eines Menschen).
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-5 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex flex-col gap-3">
          <Field data-invalid={touched && nameError ? true : undefined}>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input
              id={`${id}-name`}
              value={form.name}
              maxLength={MAX_AUTO_ACCEPT_NAME_CHARS}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="z. B. Schlüssel-Nachrichten ab 95 %"
              aria-invalid={touched && nameError ? true : undefined}
            />
            {touched && nameError ? <FieldError>{nameError}</FieldError> : null}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor={`${id}-kind`}>Art</FieldLabel>
              <NativeSelect
                id={`${id}-kind`}
                className="w-full"
                value={form.kind}
                disabled={base !== null}
                onChange={(e) => {
                  const kind = e.target.value as AutoAcceptKind;
                  const allowed = tiersOf(kind);
                  set({
                    kind,
                    tier: allowed.includes(form.tier) ? form.tier : (allowed[0] ?? 'lexical'),
                    relationType: kind === 'relation' ? form.relationType : ANY,
                  });
                }}
              >
                {(Object.keys(AUTO_ACCEPT_KINDS) as AutoAcceptKind[]).map((k) => (
                  <NativeSelectOption key={k} value={k}>
                    {AUTO_ACCEPT_KINDS[k].label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-tier`}>Stufe</FieldLabel>
              <NativeSelect
                id={`${id}-tier`}
                className="w-full"
                value={form.tier}
                onChange={(e) => set({ tier: e.target.value as AutoAcceptTier })}
              >
                {tiers.map((t) => (
                  <NativeSelectOption key={t} value={t}>
                    {tierLabel(t)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field data-invalid={percentError ? true : undefined}>
            <FieldLabel htmlFor={`${id}-min`}>ab Konfidenz (%)</FieldLabel>
            <Input
              id={`${id}-min`}
              inputMode="decimal"
              value={form.percent}
              onChange={(e) => set({ percent: e.target.value })}
              aria-invalid={percentError ? true : undefined}
              className="w-28"
            />
            {percentError ? (
              <FieldError>{percentError}</FieldError>
            ) : (
              <FieldDescription>
                Einschließlich: ein Vorschlag mit genau diesem Wert zählt.
              </FieldDescription>
            )}
          </Field>
          {form.kind === 'relation' ? (
            <Field>
              <FieldLabel htmlFor={`${id}-type`}>Typ</FieldLabel>
              <NativeSelect
                id={`${id}-type`}
                className="w-full"
                value={form.relationType}
                onChange={(e) =>
                  set({ relationType: e.target.value as AutoAcceptRelationType | typeof ANY })
                }
              >
                <NativeSelectOption value={ANY}>Alle Typen</NativeSelectOption>
                {AUTO_ACCEPT_RELATION_TYPES.map((t) => (
                  <NativeSelectOption key={t} value={t}>
                    {relationTypeLabel(t)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ) : (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              @outside wird nie automatisch angenommen, und ein Prozess mit Heimatschritt oder
              mehreren vorgeschlagenen Schritten auch nicht.
            </p>
          )}
          <Field>
            <FieldLabel htmlFor={`${id}-agent`}>Agent</FieldLabel>
            <NativeSelect
              id={`${id}-agent`}
              className="w-full"
              value={form.agentPrincipalId}
              onChange={(e) => set({ agentPrincipalId: e.target.value })}
            >
              <NativeSelectOption value={ANY}>Alle Agenten</NativeSelectOption>
              {agentOptions.map((a) => (
                <NativeSelectOption key={a.principalId} value={a.principalId}>
                  {a.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-model`}>LLM-Modell</FieldLabel>
            <Input
              id={`${id}-model`}
              list={`${id}-models`}
              value={form.llmModel}
              maxLength={MAX_AUTO_ACCEPT_MODEL_CHARS}
              onChange={(e) => set({ llmModel: e.target.value })}
              placeholder="Alle Modelle"
            />
            <datalist id={`${id}-models`}>
              {(preview.data?.llmModels ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <FieldDescription>Genau so, wie die Agenten es angeben.</FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id={`${id}-adhoc`}
              checked={form.includeAdHoc}
              onCheckedChange={(checked) => set({ includeAdHoc: checked === true })}
            />
            <FieldLabel htmlFor={`${id}-adhoc`}>Auch Ad-hoc-Vorschläge</FieldLabel>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-note`}>Notiz (optional)</FieldLabel>
            <Textarea
              id={`${id}-note`}
              value={form.note}
              maxLength={MAX_AUTO_ACCEPT_NOTE_CHARS}
              onChange={(e) => set({ note: e.target.value })}
              className="min-h-12"
            />
          </Field>
        </div>
        <section aria-label="Vorschau" className="flex min-w-0 flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Vorschau
          </h3>
          {criteria === null ? (
            <p className="text-sm text-muted-foreground">
              Vervollständige die Kriterien, dann siehst du hier, was die Regel angenommen hätte.
            </p>
          ) : preview.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Vorschau fehlgeschlagen</AlertTitle>
              <AlertDescription>{errorMessage(preview.error)}</AlertDescription>
            </Alert>
          ) : preview.data ? (
            <RulePreview
              preview={preview.data}
              minConfidence={criteria.minConfidence}
              stale={preview.isPlaceholderData || debounced !== criteria}
            />
          ) : (
            <Skeleton className="h-48 w-full" />
          )}
        </section>
      </div>
      {base ? (
        <p className="text-xs text-muted-foreground">
          Erzeugt eine neue Revision; bereits angenommene Vorschläge behalten ihre Revision.
        </p>
      ) : null}
      {base && !base.authorIsOwner ? (
        <Alert data-testid="take-over-hint">
          <AlertDescription>
            {base.author.handle} ist kein Inhaber mehr; bis jemand die Regel neu speichert, nimmt
            sie nichts an. Speicherst du sie, übernimmst du sie: Ihre Annahmen werden dann als deine
            Entscheidungen vermerkt.
          </AlertDescription>
        </Alert>
      ) : null}
      {show412 ? (
        <Alert>
          <AlertTitle>Die Regel wurde inzwischen geändert (Revision {conflict})</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            Es wurde nichts gespeichert.
            <Button size="xs" variant="outline" type="button" onClick={() => void loadNewer()}>
              Neuere Revision laden
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {reloaded ? (
        <Alert data-testid="reloaded">
          <AlertTitle>Revision {reloaded.revision} geladen</AlertTitle>
          <AlertDescription className="flex flex-col gap-1">
            {reloaded.changes.length === 0 ? (
              <span>Die Kriterien sind gleich geblieben.</span>
            ) : (
              <>
                <span>Geändert:</span>
                <ul className="list-disc pl-4">
                  {reloaded.changes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </>
            )}
            <span>
              Das Formular zeigt jetzt diese Revision; deine Änderungen sind verworfen. Trage sie
              bei Bedarf neu ein.
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {showSaveError ? (
        <Alert variant="destructive">
          <AlertTitle>Nicht gespeichert</AlertTitle>
          <AlertDescription>{saveProblem(saveError)}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Abbrechen
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={saving || show412}
          onClick={() => save(false)}
          data-testid="save-off"
        >
          <SaveIcon data-icon="inline-start" />
          Speichern (aus)
        </Button>
        <Button
          type="button"
          disabled={saving || show412}
          onClick={() => save(true)}
          data-testid="save-on"
        >
          <PowerIcon data-icon="inline-start" />
          Speichern und aktivieren
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Create or edit an auto-accept rule (owner decision 19): kind-specific
 * tiers, the minimum confidence in percent (at least 50 %), type, agent, LLM
 * model and ad hoc; beside them the live preview (debounced). Saving writes
 * a new immutable revision, off or on; an edit sends `If-Match` and, on 412,
 * loads the newer revision into the form (listing what changed) before
 * anything can be saved on top of it. A threshold the field still shows
 * unchanged is saved as it was (never re-read from its text).
 */
export function RuleDialog({ open, onOpenChange, ...props }: RuleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-5xl"
        data-testid="rule-dialog"
      >
        {open ? <RuleForm onOpenChange={onOpenChange} {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}
