import type { AutoAcceptRule } from '@proa/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, WandSparklesIcon } from 'lucide-react';
import { useState } from 'react';

import { AgentRevoke } from '@/components/rules/agent-revoke';
import { ApplyDialog } from '@/components/rules/apply-dialog';
import { PreviewDialog } from '@/components/rules/preview-dialog';
import { RevokeDialog } from '@/components/rules/revoke-dialog';
import { RuleDialog } from '@/components/rules/rule-dialog';
import { RuleHistoryDialog } from '@/components/rules/rule-history';
import { RuleTable } from '@/components/rules/rule-table';
import { SystemRuleCard } from '@/components/rules/system-rule-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { useAutoAcceptIndex } from '@/lib/auto-accept-actions';
import { agentTokensQuery, autoAcceptRulesQuery, keys, projectQuery } from '@/lib/queries';
import { autoAcceptApplyDryRunQuery } from '@/lib/auto-accept-queries';

import { projectRulesRoute } from './project-rules';

type Open =
  | { kind: 'create' }
  | { kind: 'edit' | 'preview' | 'apply' | 'revoke' | 'history'; rule: AutoAcceptRule }
  | { kind: 'offer-apply'; rule: AutoAcceptRule; count: number }
  | null;

/**
 * The tab „Regeln“ (owner decision 19): the built-in system rule of decision
 * 9, the project's auto-accept rules with their numbers and actions (edit
 * with the live preview, enable and disable, apply to the open proposals,
 * revoke, the revisions), and revoking one agent's acceptances across rules.
 * Owners only; agents never see rules.
 */
export function RulesPage() {
  const { project } = projectRulesRoute.useParams();
  const queryClient = useQueryClient();
  const info = useQuery(projectQuery(project));
  const owner = info.data?.role === 'owner';
  const rules = useQuery({ ...autoAcceptRulesQuery(project), enabled: owner });
  const tokens = useQuery({ ...agentTokensQuery(project), enabled: owner });
  const autoIndex = useAutoAcceptIndex(project);
  const [open, setOpen] = useState<Open>(null);
  /** Closes the dialog of `kinds` only: a dialog that closes as another opens leaves that one. */
  const closer =
    (...kinds: NonNullable<Open>['kind'][]) =>
    (isOpen: boolean) => {
      if (!isOpen) setOpen((current) => (current && kinds.includes(current.kind) ? null : current));
    };
  const reload = () =>
    void queryClient.invalidateQueries({ queryKey: keys.autoAcceptRules(project) });

  /** After saving an enabled rule: offer to apply it when open proposals already match. */
  async function offerApply(rule: AutoAcceptRule) {
    if (!rule.enabled || !rule.authorIsOwner) return;
    try {
      const dry = await queryClient.fetchQuery(
        autoAcceptApplyDryRunQuery(project, rule.id, rule.revision),
      );
      if (dry.count > 0) setOpen({ kind: 'offer-apply', rule, count: dry.count });
    } catch {
      // The offer is a convenience: „Auf offene Vorschläge anwenden…“ stays in the table.
    }
  }

  if (info.isPending) return <Skeleton className="h-40 w-full" />;
  if (!owner) {
    return (
      <Alert>
        <AlertTitle>Nur für Inhaber</AlertTitle>
        <AlertDescription>
          Annahmeregeln sehen und pflegen nur die Inhaber dieses Projekts.
        </AlertDescription>
      </Alert>
    );
  }
  if (rules.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Regeln konnten nicht geladen werden</AlertTitle>
        <AlertDescription>{errorMessage(rules.error)}</AlertDescription>
      </Alert>
    );
  }
  if (!rules.data) return <Skeleton className="h-40 w-full" />;
  const list = rules.data.items;

  return (
    <div className="flex flex-col gap-5" data-testid="rules-page">
      <SystemRuleCard project={project} system={rules.data.system} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex max-w-3xl flex-col gap-1">
          <h2 className="text-lg font-semibold">Annahmeregeln</h2>
          <p className="text-sm text-muted-foreground">
            Bis zu einer Konfidenz, die du festlegst, nimmt ProA neue Agentenvorschläge selbst an –
            als deine Entscheidung, mit Regel und Revision vermerkt. Agenten sehen keine Regeln. Nie
            angenommen wird bei einer Frage, einem Einwand, einer Vormerkung oder einer Entscheidung
            eines Menschen.
          </p>
        </div>
        <Button onClick={() => setOpen({ kind: 'create' })} data-testid="new-rule">
          <PlusIcon data-icon="inline-start" />
          Neue Regel
        </Button>
      </div>
      {list.length === 0 ? (
        <Empty className="border bg-card" data-testid="rules-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WandSparklesIcon />
            </EmptyMedia>
            <EmptyTitle>Noch keine Regeln</EmptyTitle>
            <EmptyDescription>Ohne Regeln entscheidest du jeden Vorschlag selbst.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => setOpen({ kind: 'create' })}>
              <PlusIcon data-icon="inline-start" />
              Erste Regel anlegen
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <RuleTable
          project={project}
          rules={list}
          onEdit={(rule) => setOpen({ kind: 'edit', rule })}
          onPreview={(rule) => setOpen({ kind: 'preview', rule })}
          onApply={(rule) => setOpen({ kind: 'apply', rule })}
          onRevoke={(rule) => setOpen({ kind: 'revoke', rule })}
          onHistory={(rule) => setOpen({ kind: 'history', rule })}
          onSaved={(rule) => void offerApply(rule)}
          onReload={reload}
        />
      )}
      <AgentRevoke project={project} index={autoIndex} />

      <RuleDialog
        project={project}
        rule={open?.kind === 'edit' ? open.rule : null}
        tokens={tokens.data ?? []}
        open={open?.kind === 'create' || open?.kind === 'edit'}
        onOpenChange={closer('create', 'edit')}
        onSaved={(rule) => void offerApply(rule)}
      />
      {open && open.kind !== 'create' ? (
        <>
          <PreviewDialog
            project={project}
            rule={open.rule}
            open={open.kind === 'preview'}
            onOpenChange={closer('preview')}
          />
          <ApplyDialog
            project={project}
            rule={open.rule}
            open={open.kind === 'apply'}
            onOpenChange={closer('apply')}
          />
          <RevokeDialog
            project={project}
            selection={{ ruleId: open.rule.id }}
            title={`Annahmen der Regel „${open.rule.name}“ widerrufen`}
            open={open.kind === 'revoke'}
            onOpenChange={closer('revoke')}
          />
          <RuleHistoryDialog
            project={project}
            rule={open.rule}
            open={open.kind === 'history'}
            onOpenChange={closer('history')}
          />
        </>
      ) : null}
      <AlertDialog open={open?.kind === 'offer-apply'} onOpenChange={closer('offer-apply')}>
        <AlertDialogContent data-testid="offer-apply">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {open?.kind === 'offer-apply'
                ? open.count === 1
                  ? '1 offener Vorschlag erfüllt die Regel bereits – jetzt anwenden?'
                  : `${open.count} offene Vorschläge erfüllen die Regel bereits – jetzt anwenden?`
                : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Regeln wirken nur auf neue Vorschläge. Offene nimmst du nur an, wenn du sie
              ausdrücklich anwendest; vorher siehst du die Liste.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Später</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                open?.kind === 'offer-apply'
                  ? setOpen({ kind: 'apply', rule: open.rule })
                  : undefined
              }
            >
              Liste ansehen…
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
