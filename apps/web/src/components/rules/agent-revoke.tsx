import { Undo2Icon } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { inForceAgents, type AutoAcceptIndex } from '@/lib/auto-accept';

import { RevokeDialog } from './revoke-dialog';

/**
 * Revokes the auto-acceptances one agent's proposals triggered, across every
 * rule (owner decision 19): the agents come from the ledger (acceptances
 * still in force), revoked tokens included, so this is where a failed revoke
 * of the agents page is finished. The dialog runs the dry run first.
 */
export function AgentRevoke({ project, index }: { project: string; index: AutoAcceptIndex }) {
  const id = useId();
  const agents = inForceAgents(index);
  const [picked, setPicked] = useState('');
  const [open, setOpen] = useState(false);
  if (agents.length === 0) return null;
  const agent = agents.find((a) => a.principalId === picked) ?? agents[0];
  if (!agent) return null;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
      data-testid="agent-revoke"
    >
      <div className="flex flex-col gap-1">
        <h3 id={`${id}-title`} className="text-sm font-semibold">
          Annahmen eines Agenten widerrufen
        </h3>
        <p className="text-sm text-muted-foreground">
          Alle noch geltenden automatischen Annahmen, die Vorschläge dieses Agenten ausgelöst haben,
          über alle Regeln – etwa nach dem Widerrufen seines Tokens.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-auto min-w-64">
          <FieldLabel htmlFor={`${id}-agent`}>Agent</FieldLabel>
          <NativeSelect
            id={`${id}-agent`}
            className="w-full"
            value={agent.principalId}
            onChange={(e) => setPicked(e.target.value)}
          >
            {agents.map((a) => (
              <NativeSelectOption key={a.principalId} value={a.principalId}>
                {a.handle} ({a.count} in Kraft)
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>
            Vorher siehst du, was zurück in die Prüfung geht und was veraltet.
          </FieldDescription>
        </Field>
        <Button variant="outline" onClick={() => setOpen(true)} data-testid="agent-revoke-open">
          <Undo2Icon data-icon="inline-start" />
          Annahmen widerrufen…
        </Button>
      </div>
      <RevokeDialog
        project={project}
        open={open}
        onOpenChange={setOpen}
        selection={{ agentPrincipalId: agent.principalId }}
        title={`Annahmen von ${agent.handle} widerrufen`}
      />
    </section>
  );
}
