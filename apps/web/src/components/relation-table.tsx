import type { Relation } from '@proa/client';
import { cn } from 'cn';
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FilterXIcon,
  PlugIcon,
  ScrollTextIcon,
  UserIcon,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';

import { EndpointStateBadge, StatusBadge, TierBadge, TypeLabel } from '@/components/badges';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  RELATION_STATUSES,
  RELATION_TYPES,
  STATUS_ORDER,
  TIERS,
  TIER_ORDER,
  TYPE_ORDER,
  formatConfidence,
  formatDateTime,
  provenanceOf,
  type Provenance,
} from '@/lib/labels';
import {
  RELATION_PRESETS,
  filterRelations,
  matchesFilters,
  type RelationFilters,
} from '@/lib/relation-filters';
import type { RefLabel, RefResolver } from '@/lib/refs';

const SOURCE_ICONS: Record<Provenance['source'], LucideIcon> = {
  rule: ScrollTextIcon,
  agent: PlugIcon,
  human: UserIcon,
};

/** One end of a relation: element label (or id), model key and process. */
export function Endpoint({ label }: { label: RefLabel }) {
  return (
    <div className="flex min-w-0 flex-col" title={label.ref}>
      <span className="truncate font-medium">
        {label.label ?? <span className="font-mono text-[13px]">{label.elementId}</span>}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        <span className="font-mono">{label.modelKey}</span>
        {label.processName && label.kind !== 'process' ? ` · ${label.processName}` : null}
      </span>
    </div>
  );
}

function ProvenanceCell({ relation }: { relation: Relation }) {
  const p = provenanceOf(relation);
  const Icon = SOURCE_ICONS[p.source];
  return (
    <div
      className="flex min-w-0 flex-col"
      title={
        relation.provenance
          ? 'Worauf der Status beruht (Verfahren und LLM-Modell sind vom Agenten angegeben)'
          : 'Abgeleitet aus Stufe und Attributen der Relation'
      }
    >
      <span className="inline-flex items-center gap-1.5 truncate font-mono text-xs">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {p.label}
      </span>
      <span className="truncate text-xs text-muted-foreground">{p.detail}</span>
    </div>
  );
}

function AttrList({ relation }: { relation: Relation }) {
  const entries = Object.entries(relation.attrs);
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
      <dt className="text-muted-foreground">Von</dt>
      <dd className="font-mono break-all">{relation.from}</dd>
      <dt className="text-muted-foreground">Nach</dt>
      <dd className="font-mono break-all">{relation.to}</dd>
      <dt className="text-muted-foreground">Relation</dt>
      <dd className="font-mono">
        {relation.id} · Version {relation.version}
      </dd>
      <dt className="text-muted-foreground">Aktualisiert</dt>
      <dd>{formatDateTime(relation.updatedAt)}</dd>
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="font-mono break-all">
            {typeof value === 'string' ? value : JSON.stringify(value)}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export interface RelationTableProps {
  relations: readonly Relation[];
  resolve: RefResolver;
  /** Content of the "Aktion" column: the review screen and the model view. */
  renderActions?: (relation: Relation) => ReactNode;
  /** Highlights a row, e.g. the relation selected in the model view. */
  selectedId?: string;
}

/** The relation rows: type, endpoints, tier, status, confidence, provenance, actions. */
export function RelationTable({
  relations,
  resolve,
  renderActions,
  selectedId,
}: RelationTableProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Table aria-label="Relationen" className="min-w-[1056px] table-fixed">
      <colgroup>
        <col className="w-9" />
        <col className="w-28" />
        <col />
        <col className="w-6" />
        <col />
        <col className="w-28" />
        <col className="w-36" />
        <col className="w-20" />
        <col className="w-44" />
        <col className="w-36" />
      </colgroup>
      <TableHeader>
        <TableRow>
          <TableHead>
            <span className="sr-only">Details</span>
          </TableHead>
          <TableHead>Typ</TableHead>
          <TableHead>Von</TableHead>
          <TableHead>
            <span className="sr-only">nach</span>
          </TableHead>
          <TableHead>Nach</TableHead>
          <TableHead>Stufe</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Konfidenz</TableHead>
          <TableHead>Herkunft</TableHead>
          <TableHead>Aktion</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {relations.map((r) => {
          const open = expanded.has(r.id);
          const ruleAccepted = r.status === 'accepted' && r.tier === 'rule';
          return (
            <Fragment key={r.id}>
              <TableRow
                data-testid="relation-row"
                data-relation-id={r.id}
                data-status={r.status}
                data-tier={r.tier}
                data-state={selectedId === r.id ? 'selected' : undefined}
                className={cn(ruleAccepted && 'bg-success-soft/40')}
              >
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-expanded={open}
                    aria-label={open ? 'Details ausblenden' : 'Details anzeigen'}
                    onClick={() => toggle(r.id)}
                  >
                    {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                  </Button>
                </TableCell>
                <TableCell>
                  <TypeLabel type={r.type} />
                </TableCell>
                <TableCell className="whitespace-normal">
                  <Endpoint label={resolve(r.from)} />
                </TableCell>
                <TableCell className="px-0 text-muted-foreground">
                  <ArrowRightIcon className="size-4" aria-hidden />
                </TableCell>
                <TableCell className="whitespace-normal">
                  <Endpoint label={resolve(r.to)} />
                </TableCell>
                <TableCell>
                  <TierBadge tier={r.tier} />
                </TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-1">
                    <StatusBadge status={r.status} />
                    <EndpointStateBadge state={r.endpointState} />
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatConfidence(r.confidence)}
                </TableCell>
                <TableCell>
                  <ProvenanceCell relation={r} />
                </TableCell>
                <TableCell>{renderActions?.(r)}</TableCell>
              </TableRow>
              {open ? (
                <TableRow className="hover:bg-transparent" data-testid="relation-details">
                  <TableCell />
                  <TableCell colSpan={9} className="whitespace-normal pb-4">
                    <AttrList relation={r} />
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

export interface RelationsViewProps extends RelationTableProps {
  /** Model keys offered in the model filter. */
  modelKeys: readonly string[];
  filters: RelationFilters;
  onFiltersChange: (filters: RelationFilters) => void;
}

const ALL = '';

/** Quick filters, filter bar and relation table, filtered on the client. */
export function RelationsView({
  relations,
  modelKeys,
  filters,
  onFiltersChange,
  ...table
}: RelationsViewProps) {
  const visible = useMemo(() => filterRelations(relations, filters), [relations, filters]);
  const filtered =
    filters.status !== undefined ||
    filters.tier !== undefined ||
    filters.type !== undefined ||
    filters.model !== undefined;

  const set = (patch: Partial<RelationFilters>) => {
    const next: RelationFilters = { ...filters, ...patch };
    for (const key of Object.keys(next) as (keyof RelationFilters)[]) {
      if (next[key] === undefined) delete next[key];
    }
    onFiltersChange(next);
  };

  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label="Schnellfilter" className="flex flex-wrap gap-2">
        {RELATION_PRESETS.map((preset) => {
          const target: RelationFilters = { ...preset.filters, model: filters.model };
          const active =
            filters.status === preset.filters.status &&
            filters.tier === preset.filters.tier &&
            filters.type === undefined;
          const count = relations.filter((r) => matchesFilters(r, target)).length;
          return (
            <Button
              key={preset.id}
              variant={active ? 'default' : 'outline'}
              size="sm"
              aria-pressed={active}
              onClick={() =>
                set({ status: preset.filters.status, tier: preset.filters.tier, type: undefined })
              }
            >
              {preset.label} <span className="tabular-nums opacity-80">{count}</span>
            </Button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-3" role="search" aria-label="Relationen filtern">
        <Field className="w-auto">
          <FieldLabel htmlFor="filter-status">Status</FieldLabel>
          <NativeSelect
            id="filter-status"
            value={filters.status ?? ALL}
            onChange={(e) =>
              set({
                status: e.target.value === ALL ? undefined : (e.target.value as Relation['status']),
              })
            }
          >
            <NativeSelectOption value={ALL}>Alle Status</NativeSelectOption>
            {STATUS_ORDER.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {RELATION_STATUSES[s].label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor="filter-tier">Stufe</FieldLabel>
          <NativeSelect
            id="filter-tier"
            value={filters.tier ?? ALL}
            onChange={(e) =>
              set({
                tier: e.target.value === ALL ? undefined : (e.target.value as Relation['tier']),
              })
            }
          >
            <NativeSelectOption value={ALL}>Alle Stufen</NativeSelectOption>
            {TIER_ORDER.map((t) => (
              <NativeSelectOption key={t} value={t}>
                {TIERS[t].label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor="filter-type">Typ</FieldLabel>
          <NativeSelect
            id="filter-type"
            value={filters.type ?? ALL}
            onChange={(e) =>
              set({
                type: e.target.value === ALL ? undefined : (e.target.value as Relation['type']),
              })
            }
          >
            <NativeSelectOption value={ALL}>Alle Typen</NativeSelectOption>
            {TYPE_ORDER.map((t) => (
              <NativeSelectOption key={t} value={t}>
                {RELATION_TYPES[t].label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field className="w-auto min-w-56">
          <FieldLabel htmlFor="filter-model">Modell</FieldLabel>
          <NativeSelect
            id="filter-model"
            className="w-full"
            value={filters.model ?? ALL}
            onChange={(e) => set({ model: e.target.value === ALL ? undefined : e.target.value })}
          >
            <NativeSelectOption value={ALL}>Alle Modelle</NativeSelectOption>
            {modelKeys.map((key) => (
              <NativeSelectOption key={key} value={key}>
                {key}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        {filtered ? (
          <Button variant="ghost" onClick={() => onFiltersChange({})}>
            <FilterXIcon data-icon="inline-start" />
            Filter zurücksetzen
          </Button>
        ) : null}
        <p className="ml-auto text-sm text-muted-foreground" aria-live="polite">
          {visible.length === relations.length
            ? `${relations.length} Relationen`
            : `${visible.length} von ${relations.length} Relationen`}
        </p>
      </div>

      {visible.length > 0 ? (
        <div className="rounded-xl border bg-card">
          <RelationTable relations={visible} {...table} />
        </div>
      ) : (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyTitle>
              {relations.length === 0
                ? 'Noch keine Relationen'
                : 'Keine Relation passt zu den Filtern'}
            </EmptyTitle>
            <EmptyDescription>
              {relations.length === 0
                ? 'Lade Modelle hoch: Eindeutige Aufrufe nimmt die Regel sofort an, gleiche Nachrichten- und Signalnamen erscheinen als Vorschläge.'
                : 'Lockere die Filter oder setze sie zurück.'}
            </EmptyDescription>
          </EmptyHeader>
          {filtered ? (
            <EmptyContent>
              <Button variant="outline" onClick={() => onFiltersChange({})}>
                <FilterXIcon data-icon="inline-start" />
                Filter zurücksetzen
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      )}
    </div>
  );
}
