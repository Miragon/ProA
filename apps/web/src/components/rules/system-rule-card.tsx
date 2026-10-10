import type { AutoAcceptSystemRule } from '@proa/client';
import { Link } from '@tanstack/react-router';
import { LockIcon, ScrollTextIcon } from 'lucide-react';

import { ToneBadge } from '@/components/badges';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Decision 9 as a fixed system rule: the rule tier accepts an unambiguous
 * call at ingest. Always on, never stored as an auto-accept rule, not
 * editable; shown with the relations it accepted.
 */
export function SystemRuleCard({
  project,
  system,
}: {
  project: string;
  system: AutoAcceptSystemRule;
}) {
  return (
    <Card data-testid="system-rule">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <ScrollTextIcon className="size-4 text-muted-foreground" aria-hidden />
          Systemregel: {system.name}
          <ToneBadge tone="neutral" icon={LockIcon}>
            immer aktiv, nicht änderbar
          </ToneBadge>
        </CardTitle>
        <CardDescription>
          Ein Aufruf, dessen calledElement genau eine Prozess-ID eines anderen Prozesses trifft,
          wird beim Hochladen angenommen (Verfahren{' '}
          <span className="font-mono text-xs">{system.id}</span>). Eine Entscheidung eines Menschen
          geht immer vor.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        <Link
          to="/projects/$project/relations"
          params={{ project }}
          search={{ status: 'accepted', tier: 'rule' }}
          className="text-link hover:underline"
          data-testid="system-rule-count"
        >
          {system.accepted === 1
            ? '1 Relation angenommen'
            : `${system.accepted} Relationen angenommen`}
        </Link>
      </CardContent>
    </Card>
  );
}
