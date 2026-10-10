import type { AutoAcceptRule } from '@proa/client';
import { useQuery } from '@tanstack/react-query';

import { ToneBadge } from '@/components/badges';
import { PlainText } from '@/components/review/plain-text';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorMessage } from '@/lib/api';
import { formatThreshold, narrowingOf, tierLabel } from '@/lib/auto-accept-rules';
import { formatDateTime } from '@/lib/labels';
import { autoAcceptRuleQuery } from '@/lib/auto-accept-queries';

function History({ project, rule }: { project: string; rule: AutoAcceptRule }) {
  const detail = useQuery(autoAcceptRuleQuery(project, rule.id));
  if (detail.isPending) return <Skeleton className="h-24 w-full" />;
  if (detail.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>Verlauf konnte nicht geladen werden</AlertTitle>
        <AlertDescription>{errorMessage(detail.error)}</AlertDescription>
      </Alert>
    );
  return (
    <div className="max-h-[60svh] overflow-auto">
      <Table aria-label="Revisionen" className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>Revision</TableHead>
            <TableHead>Zeitpunkt</TableHead>
            <TableHead>Urheber</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Kriterien</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...detail.data.revisions].reverse().map((r) => (
            <TableRow key={r.revision} data-testid="rule-revision">
              <TableCell className="font-mono">r{r.revision}</TableCell>
              <TableCell>{formatDateTime(r.at)}</TableCell>
              <TableCell>
                <span className="font-mono">{r.author.handle}</span>
                {r.clientId ? <span className="text-muted-foreground"> · {r.clientId}</span> : null}
              </TableCell>
              <TableCell>
                <ToneBadge tone={r.enabled ? 'success' : 'neutral'}>
                  {r.enabled ? 'Aktiv' : 'Aus'}
                </ToneBadge>
              </TableCell>
              <TableCell className="whitespace-normal">
                <PlainText as="span" text={r.name} />
              </TableCell>
              <TableCell className="whitespace-normal">
                {[
                  `${tierLabel(r.tier)} ab ${formatThreshold(r.minConfidence)}`,
                  ...narrowingOf({
                    ...r,
                    agentHandle:
                      r.agentPrincipalId === null
                        ? null
                        : r.agentPrincipalId === rule.agentPrincipalId && rule.agent
                          ? rule.agent.handle
                          : r.agentPrincipalId,
                  }),
                ].join(' · ')}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The immutable revisions of a rule, newest first: every create, edit,
 * enable and disable is one. Acceptances name the revision that made them.
 */
export function RuleHistoryDialog({
  project,
  rule,
  open,
  onOpenChange,
}: {
  project: string;
  rule: AutoAcceptRule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="rule-history">
        <DialogHeader>
          <DialogTitle>Verlauf der Regel „{rule.name}“</DialogTitle>
          <DialogDescription>
            Jede Änderung, jedes Aktivieren und Deaktivieren ist eine eigene, unveränderliche
            Revision. Automatische Annahmen nennen die Revision, die sie getroffen hat.
          </DialogDescription>
        </DialogHeader>
        {open ? <History project={project} rule={rule} /> : null}
      </DialogContent>
    </Dialog>
  );
}
