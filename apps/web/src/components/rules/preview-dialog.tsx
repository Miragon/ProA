import type { AutoAcceptRule } from '@proa/client';
import { useQuery } from '@tanstack/react-query';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { criteriaOf, draftOf } from '@/lib/auto-accept-rules';
import { autoAcceptPreviewQuery } from '@/lib/auto-accept-queries';

import { RulePreview } from './rule-preview';

function Preview({ project, rule }: { project: string; rule: AutoAcceptRule }) {
  const preview = useQuery(autoAcceptPreviewQuery(project, criteriaOf(draftOf(rule))));
  if (preview.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>Vorschau fehlgeschlagen</AlertTitle>
        <AlertDescription>{errorMessage(preview.error)}</AlertDescription>
      </Alert>
    );
  if (!preview.data) return <Skeleton className="h-48 w-full" />;
  return <RulePreview preview={preview.data} minConfidence={rule.minConfidence} />;
}

/** The preview of a saved rule at its head revision (read-only). */
export function PreviewDialog({
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
      <DialogContent className="sm:max-w-xl" data-testid="preview-dialog">
        <DialogHeader>
          <DialogTitle>Vorschau der Regel „{rule.name}“</DialogTitle>
          <DialogDescription>
            Was die Regel in diesem Projekt bisher angenommen hätte und was sie jetzt annähme.
          </DialogDescription>
        </DialogHeader>
        {open ? <Preview project={project} rule={rule} /> : null}
      </DialogContent>
    </Dialog>
  );
}
