import type { Relation, Tier } from '@proa/client';
import { cn } from 'cn';
import { ArrowRightIcon, CheckCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { TYPE_ICONS } from '@/components/badges';
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
import { errorMessage } from '@/lib/api';
import { bulkFlags, type GenericFlag, type NameUsage } from '@/lib/generic-names';
import { RELATION_TYPES, TIERS, formatConfidence } from '@/lib/labels';
import { MAX_BULK_DECISIONS } from '@/lib/limits';
import type { RefLabel, RefResolver } from '@/lib/refs';
import { conflictOf, type Conflict } from '@/lib/review';
import { useBulkDecide } from '@/lib/review-actions';
import { toast } from '@/lib/toast';

import { PlainText } from './plain-text';

export interface BulkAcceptDialogProps {
  project: string;
  tier: Tier;
  /** The open proposals of that tier, in queue order. */
  relations: readonly Relation[];
  resolve: RefResolver;
  usage: NameUsage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function EndLabel({ label }: { label: RefLabel }) {
  return (
    <span className="flex min-w-0 flex-col" title={label.ref}>
      <PlainText as="span" className="truncate font-medium" text={label.label ?? label.elementId} />
      <span className="truncate font-mono text-xs text-muted-foreground">{label.modelKey}</span>
    </span>
  );
}

interface Row {
  relation: Relation;
  flags: GenericFlag[];
}

/** A deliberate check holds for the version the reviewer saw. */
const versionKey = (r: Pick<Relation, 'id' | 'version'>) => `${r.id}@${r.version}`;

function BulkList({
  project,
  tier,
  rows,
  resolve,
  onClose,
}: {
  project: string;
  tier: Tier;
  rows: readonly Row[];
  resolve: RefResolver;
  onClose: () => void;
}) {
  // Unflagged pairs start checked, flagged ones unchecked: accepting a flagged
  // pair needs a deliberate click, which holds for the version the reviewer
  // saw. When the list reloads (a 409), a pair that changed and is flagged now
  // is unchecked again; a pair the reviewer unchecked stays unchecked.
  const [checkedVersions, setCheckedVersions] = useState<ReadonlySet<string>>(new Set());
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const bulk = useBulkDecide(project);

  const isChecked = (row: Row) =>
    !unchecked.has(row.relation.id) &&
    (row.flags.length === 0 || checkedVersions.has(versionKey(row.relation)));
  const chosen = rows.filter(isChecked).map((r) => r.relation);
  const flagged = rows.filter((r) => r.flags.length > 0).length;
  const allChecked = chosen.length === rows.length && rows.length > 0;
  const tooMany = chosen.length > MAX_BULK_DECISIONS;

  const setRows = (targets: readonly Row[], on: boolean) => {
    const ids = targets.map((r) => r.relation.id);
    setUnchecked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    setCheckedVersions((prev) => {
      const next = new Set(prev);
      for (const r of targets) {
        if (on) next.add(versionKey(r.relation));
        else next.delete(versionKey(r.relation));
      }
      return next;
    });
  };

  function confirm() {
    if (chosen.length === 0 || tooMany) return;
    setConflict(null);
    bulk.mutate(
      {
        verdict: 'accept',
        tier,
        items: chosen.map((r) => ({ id: r.id, version: r.version })),
        expectedCount: chosen.length,
      },
      {
        onSuccess: (result) => {
          toast({
            tone: 'success',
            title:
              result.items.length === 1
                ? '1 Relation angenommen'
                : `${result.items.length} Relationen angenommen`,
            description: `Stufe ${TIERS[tier].label}`,
          });
          onClose();
        },
        onError: (error) => {
          const c = conflictOf(error);
          if (c) setConflict(c);
          else
            toast({
              tone: 'danger',
              title: 'Nichts angenommen',
              description: errorMessage(error),
            });
        },
      },
    );
  }

  return (
    <>
      {conflict ? (
        <Alert data-testid="bulk-conflict" className="border-warning bg-warning-soft">
          <TriangleAlertIcon className="text-warning" />
          <AlertTitle>{conflict.title}</AlertTitle>
          <AlertDescription className="text-foreground">{conflict.description}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="inline-flex items-center gap-2">
          <Checkbox
            checked={allChecked ? true : chosen.length === 0 ? false : 'indeterminate'}
            onCheckedChange={(on) => setRows(rows, on === true)}
            aria-label="Alle auswählen"
          />
          Alle
        </label>
        <span className="text-muted-foreground" aria-live="polite" data-testid="bulk-summary">
          {chosen.length} von {rows.length} ausgewählt
          {flagged > 0 ? ` · ${flagged} markiert` : ''}
        </span>
      </div>

      <ul
        aria-label="Paare"
        className="-mx-1 flex max-h-[min(52vh,520px)] flex-col overflow-y-auto px-1"
      >
        {rows.map((row) => {
          const { relation: r, flags } = row;
          const TypeIcon = TYPE_ICONS[r.type];
          const checked = isChecked(row);
          return (
            <li
              key={r.id}
              data-testid="bulk-row"
              data-relation-id={r.id}
              data-flagged={flags.length > 0}
              className={cn(
                'flex gap-3 border-b py-2 last:border-b-0',
                flags.length > 0 && 'bg-warning-soft/60 -mx-1 rounded-md px-1',
              )}
            >
              <Checkbox
                className="mt-1"
                checked={checked}
                onCheckedChange={(on) => setRows([row], on === true)}
                aria-label={`${resolve(r.from).label ?? r.from} nach ${resolve(r.to).label ?? r.to} annehmen`}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 text-sm">
                  <EndLabel label={resolve(r.from)} />
                  <ArrowRightIcon className="size-4 text-muted-foreground" aria-hidden />
                  <EndLabel label={resolve(r.to)} />
                  <span
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
                    title={RELATION_TYPES[r.type].label}
                  >
                    <TypeIcon className="size-3.5" aria-hidden />
                    {formatConfidence(r.confidence)}
                  </span>
                </div>
                {flags.map((f) => (
                  <p
                    key={`${f.kind}:${f.text}`}
                    data-testid="generic-flag"
                    data-flag={f.kind}
                    className="flex items-start gap-1.5 text-xs text-warning"
                  >
                    <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
                    <PlainText as="span" text={f.detail} />
                  </p>
                ))}
              </div>
            </li>
          );
        })}
      </ul>

      {tooMany ? (
        <p className="text-sm text-danger">
          Höchstens {MAX_BULK_DECISIONS} Relationen auf einmal; wähle weniger aus.
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Abbrechen
        </Button>
        <Button onClick={confirm} disabled={chosen.length === 0 || tooMany || bulk.isPending}>
          <CheckCheckIcon data-icon="inline-start" />
          {chosen.length === 1 ? '1 annehmen' : `${chosen.length} annehmen`}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Bulk accept per tier (CONCEPT §3: "a reviewer checks [key-tier proposals]
 * briefly and accepts them in bulk per tier") with a preview of every pair.
 * Pairs with generic names, names more than two processes share, an open
 * agent question or an ambiguous call target are flagged and left
 * unchecked. The request carries ids, versions, the tier and the count, so a
 * list that changed meanwhile fails as a whole (409).
 */
export function BulkAcceptDialog({
  project,
  tier,
  relations,
  resolve,
  usage,
  open,
  onOpenChange,
}: BulkAcceptDialogProps) {
  const rows = useMemo<Row[]>(
    () =>
      relations.map((relation) => ({
        relation,
        flags: bulkFlags(relation, (ref) => resolve(ref).label, usage),
      })),
    [relations, resolve, usage],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="bulk-dialog">
        <DialogHeader>
          <DialogTitle>
            {relations.length === 1
              ? `1 Vorschlag der Stufe ${TIERS[tier].label} annehmen?`
              : `${relations.length} Vorschläge der Stufe ${TIERS[tier].label} annehmen?`}
          </DialogTitle>
          <DialogDescription>
            Prüfe die Paare. Markiert sind allgemeine Namen, Namen aus mehr als zwei Prozessen,
            offene Fragen des Agenten und nicht eindeutige Aufrufziele; sie sind nicht ausgewählt,
            bis du sie bewusst anhakst.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <BulkList
            project={project}
            tier={tier}
            rows={rows}
            resolve={resolve}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
