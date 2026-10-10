import type { AutoAcceptRule } from '@proa/client';
import { Link } from '@tanstack/react-router';
import {
  CheckCheckIcon,
  EyeIcon,
  HistoryIcon,
  PencilIcon,
  PowerIcon,
  PowerOffIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from 'lucide-react';
import { useState } from 'react';

import { ToneBadge } from '@/components/badges';
import { PlainText } from '@/components/review/plain-text';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, errorMessage } from '@/lib/api';
import type { AutoFilter } from '@/lib/auto-accept';
import {
  AUTO_ACCEPT_KINDS,
  draftOf,
  formatThreshold,
  narrowingOf,
  tierLabel,
} from '@/lib/auto-accept-rules';
import { useReviseRule } from '@/lib/auto-accept-rule-actions';
import { formatDateTime } from '@/lib/labels';
import { toast } from '@/lib/toast';

export interface RuleTableProps {
  project: string;
  /** In creation order: the first matching rule is recorded. */
  rules: readonly AutoAcceptRule[];
  onEdit: (rule: AutoAcceptRule) => void;
  onPreview: (rule: AutoAcceptRule) => void;
  onApply: (rule: AutoAcceptRule) => void;
  onRevoke: (rule: AutoAcceptRule) => void;
  onHistory: (rule: AutoAcceptRule) => void;
  /** After enabling or disabling (a new revision). */
  onSaved?: (rule: AutoAcceptRule) => void;
  /** Reload the rules (after a 412). */
  onReload: () => void;
}

/**
 * The project's auto-accept rules (owner decision 19): status, criteria,
 * what each accepted, its revision and author, and the actions. Enabling
 * and disabling write a new revision with `If-Match`; when someone saved a
 * newer revision meanwhile (412) the table offers to load it.
 */
export function RuleTable({
  project,
  rules,
  onEdit,
  onPreview,
  onApply,
  onRevoke,
  onHistory,
  onSaved,
  onReload,
}: RuleTableProps) {
  const revise = useReviseRule(project);
  const [conflict, setConflict] = useState<string | null>(null);

  function toggle(rule: AutoAcceptRule) {
    setConflict(null);
    revise.mutate(
      {
        ruleId: rule.id,
        revision: rule.revision,
        draft: { ...draftOf(rule), enabled: !rule.enabled },
      },
      {
        onSuccess: (r) => {
          toast({
            tone: 'success',
            title: r.rule.enabled
              ? `Regel „${r.rule.name}“ aktiviert`
              : `Regel „${r.rule.name}“ deaktiviert`,
            description: r.rule.enabled
              ? 'Sie wirkt auf neue Agentenvorschläge.'
              : 'Ihre Annahmen bleiben und lassen sich weiter widerrufen.',
          });
          onSaved?.(r.rule);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 412) setConflict(rule.name);
          else
            toast({
              tone: 'danger',
              title: 'Nicht gespeichert',
              description: errorMessage(error),
            });
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {conflict ? (
        <Alert>
          <AlertTitle>Die Regel „{conflict}“ wurde inzwischen geändert</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            Es wurde nichts gespeichert.
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setConflict(null);
                onReload();
              }}
            >
              Neuere Revision laden
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="rounded-xl border bg-card">
        <Table aria-label="Annahmeregeln" className="min-w-[960px]">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kriterien</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Bisher</TableHead>
              <TableHead>Revision</TableHead>
              <TableHead>Aktionen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => {
              const narrowing = narrowingOf({
                ...rule,
                agentHandle: rule.agent?.handle ?? rule.agentPrincipalId,
                agentRevoked: rule.agent?.revoked ?? false,
              });
              return (
                <TableRow
                  key={rule.id}
                  data-testid="rule-row"
                  data-rule-id={rule.id}
                  data-enabled={rule.enabled ? 'true' : 'false'}
                  className="align-top"
                >
                  <TableCell className="max-w-56 whitespace-normal">
                    <PlainText as="span" className="font-medium" text={rule.name} />
                    {rule.note ? (
                      <PlainText
                        as="span"
                        className="block text-xs text-muted-foreground"
                        text={rule.note}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-normal" data-testid="rule-criteria">
                    <span className="block">
                      {AUTO_ACCEPT_KINDS[rule.kind].label} · {tierLabel(rule.tier)} · ab{' '}
                      <span className="whitespace-nowrap tabular-nums">
                        {formatThreshold(rule.minConfidence)}
                      </span>
                    </span>
                    {narrowing.length > 0 ? (
                      <span className="block text-xs text-muted-foreground">
                        {narrowing.join(' · ')}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <ToneBadge tone={rule.enabled ? 'success' : 'neutral'}>
                        {rule.enabled ? 'Aktiv' : 'Aus'}
                      </ToneBadge>
                      {rule.authorIsOwner ? null : (
                        <span
                          className="inline-flex items-center gap-1 text-xs text-warning"
                          data-testid="author-not-owner"
                          title="Die Regel nimmt nichts an, bis ein Inhaber sie neu speichert (Bearbeiten, Speichern) und damit übernimmt."
                        >
                          <TriangleAlertIcon className="size-3.5" aria-hidden />
                          Urheber ist kein Inhaber mehr
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs tabular-nums" data-testid="rule-stats">
                    <span className="block" title="Von der Regel angenommen und weiter in Kraft">
                      {rule.kind === 'relation' && rule.stats.inForce > 0 ? (
                        <Link
                          to="/projects/$project/relations"
                          params={{ project }}
                          search={{ auto: rule.id as AutoFilter }}
                          className="text-link hover:underline"
                        >
                          {rule.stats.inForce} in Kraft
                        </Link>
                      ) : (
                        `${rule.stats.inForce} in Kraft`
                      )}
                    </span>
                    {rule.stats.confirmed > 0 ? (
                      <span className="block" title="Seither von einem Menschen angenommen">
                        {rule.stats.confirmed} bestätigt
                      </span>
                    ) : null}
                    <span className="block">{rule.stats.revoked} widerrufen</span>
                    <span
                      className="block"
                      title="Seither von einem Menschen abgelehnt, korrigiert oder vorgemerkt"
                    >
                      {rule.stats.overruled} abgelehnt, korrigiert oder vorgemerkt
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className="font-mono">r{rule.revision}</span>
                    <span className="block text-muted-foreground">
                      {rule.author.handle}, {formatDateTime(rule.updatedAt)}
                    </span>
                  </TableCell>
                  <TableCell className="w-[320px] whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      <Button size="xs" variant="outline" onClick={() => onEdit(rule)}>
                        <PencilIcon data-icon="inline-start" />
                        Bearbeiten
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={revise.isPending}
                        onClick={() => toggle(rule)}
                        data-testid="rule-toggle"
                      >
                        {rule.enabled ? (
                          <PowerOffIcon data-icon="inline-start" />
                        ) : (
                          <PowerIcon data-icon="inline-start" />
                        )}
                        {rule.enabled ? 'Deaktivieren' : 'Aktivieren'}
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => onPreview(rule)}>
                        <EyeIcon data-icon="inline-start" />
                        Vorschau
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => onApply(rule)}
                        data-testid="rule-apply"
                      >
                        <CheckCheckIcon data-icon="inline-start" />
                        Auf offene Vorschläge anwenden…
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => onRevoke(rule)}
                        data-testid="rule-revoke"
                      >
                        <Undo2Icon data-icon="inline-start" />
                        Widerrufen…
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => onHistory(rule)}>
                        <HistoryIcon data-icon="inline-start" />
                        Verlauf
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
