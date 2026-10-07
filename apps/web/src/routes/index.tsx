import { createProject } from '@proa/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createRoute, useNavigate } from '@tanstack/react-router';
import { PlusIcon, TerminalIcon } from 'lucide-react';
import { useId, useState, type FormEvent, type ReactNode } from 'react';

import { CopyButton } from '@/components/copy-button';
import { MiragonMark, PageShell } from '@/components/page-shell';
import { toast } from '@/lib/toast';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, errorMessage, unwrap } from '@/lib/api';
import { formatDate } from '@/lib/labels';
import { keys, projectsQuery } from '@/lib/queries';
import { isProjectKey, slugify } from '@/lib/slug';

import { rootRoute } from './root';

const SEED_COMMAND = 'pnpm seed';
const ROLE_LABELS = { owner: 'Inhaber', editor: 'Bearbeiter', viewer: 'Leser' } as const;

function NewProjectDialog({ trigger }: { trigger: ReactNode }) {
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const effectiveKey = keyTouched ? key : slugify(name);
  const keyValid = isProjectKey(effectiveKey);

  const create = useMutation({
    mutationFn: () =>
      unwrap(createProject({ client: api, body: { key: effectiveKey, name: name.trim() } })),
    onSuccess: async (project) => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: keys.projects });
      toast({ tone: 'success', title: `Projekt „${project.name}“ angelegt` });
      await navigate({ to: '/projects/$project/upload', params: { project: project.key } });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() !== '' && keyValid) create.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) create.reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Neues Projekt</DialogTitle>
            <DialogDescription>
              Ein Projekt ist eine Prozesslandschaft. Du bist sein Inhaber.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                maxLength={200}
                autoFocus
                required
                placeholder="Nordwind Handel"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field data-invalid={effectiveKey !== '' && !keyValid}>
              <FieldLabel htmlFor={`${id}-key`}>Schlüssel</FieldLabel>
              <Input
                id={`${id}-key`}
                value={effectiveKey}
                className="font-mono"
                aria-invalid={effectiveKey !== '' && !keyValid}
                placeholder="nordwind-handel"
                onChange={(e) => {
                  setKeyTouched(true);
                  setKey(e.target.value);
                }}
              />
              <FieldDescription>
                Kleinbuchstaben, Ziffern und Bindestriche; erscheint in URLs und Befehlen.
              </FieldDescription>
            </Field>
            {create.isError ? <FieldError>{errorMessage(create.error)}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending || name.trim() === '' || !keyValid}>
              {create.isPending ? <Spinner data-icon="inline-start" /> : null}
              Projekt anlegen
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectsPage() {
  const projects = useQuery(projectsQuery);

  return (
    <PageShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[28px] leading-tight font-bold">Projekte</h1>
          <p className="text-muted-foreground">
            Jedes Projekt ist eine Prozesslandschaft: BPMN-Modelle, ihre Fakten und die Relationen
            zwischen den Prozessen.
          </p>
        </div>
        {projects.data && projects.data.length > 0 ? (
          <NewProjectDialog
            trigger={
              <Button>
                <PlusIcon data-icon="inline-start" />
                Neues Projekt
              </Button>
            }
          />
        ) : null}
      </div>

      {projects.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : projects.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Projekte konnten nicht geladen werden</AlertTitle>
          <AlertDescription>{errorMessage(projects.error)}</AlertDescription>
        </Alert>
      ) : projects.data.length === 0 ? (
        <Empty className="border bg-card py-12">
          <EmptyHeader>
            <EmptyMedia>
              <MiragonMark className="size-12" />
            </EmptyMedia>
            <EmptyTitle className="text-base font-semibold">Noch kein Projekt</EmptyTitle>
            <EmptyDescription>
              Leg ein Projekt an und lade BPMN-Modelle hoch. Die Testlandschaften lädst du im Repo
              mit <code className="font-mono">{SEED_COMMAND}</code>.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <NewProjectDialog
              trigger={
                <Button>
                  <PlusIcon data-icon="inline-start" />
                  Neues Projekt
                </Button>
              }
            />
            <CopyButton
              value={SEED_COMMAND}
              label="Seed-Befehl kopieren"
              copiedMessage="Befehl kopiert"
              variant="ghost"
              size="default"
            />
          </EmptyContent>
        </Empty>
      ) : (
        <div className="rounded-xl border bg-card">
          <Table aria-label="Projekte">
            <TableHeader>
              <TableRow>
                <TableHead>Projekt</TableHead>
                <TableHead>Schlüssel</TableHead>
                <TableHead>Rolle</TableHead>
                <TableHead className="text-right">Stand</TableHead>
                <TableHead>Angelegt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.data.map((p) => (
                <TableRow key={p.id} data-testid="project-row">
                  <TableCell className="font-medium">
                    <Link
                      to="/projects/$project"
                      params={{ project: p.key }}
                      className="text-link hover:underline"
                    >
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.key}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{ROLE_LABELS[p.role]}</Badge>
                  </TableCell>
                  <TableCell
                    className="text-right tabular-nums text-muted-foreground"
                    title="Laufende Nummer des letzten Ereignisses"
                  >
                    s{p.lastSeq}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(p.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {projects.data?.length === 0 ? null : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <TerminalIcon className="size-4" aria-hidden />
          Testlandschaften laden: <code className="font-mono">{SEED_COMMAND}</code>
        </p>
      )}
    </PageShell>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: ProjectsPage,
});
