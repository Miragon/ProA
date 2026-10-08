import { createAgentToken, revokeAgentToken } from '@proa/client';
import type { AgentScope, AgentToken, CreatedAgentToken } from '@proa/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, ShieldAlertIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { CodeBlock, CopyButton } from '@/components/copy-button';
import { toast } from '@/lib/toast';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  CHECKOUT_PLACEHOLDER,
  DOCKER_CONTAINER,
  claudeCodeCommand,
  claudeDesktopDockerConfig,
  claudeDesktopNodeConfig,
  genericMcpConfig,
  mcpUrl,
} from '@/lib/agent-config';
import { api, errorMessage, unwrap } from '@/lib/api';
import { SCOPES, formatDate, formatDateTime } from '@/lib/labels';
import { AGENT_TOKEN_DEFAULT_DAYS, AGENT_TOKEN_MAX_DAYS, AGENT_TOKEN_PREFIX } from '@/lib/limits';
import { agentTokensQuery, keys } from '@/lib/queries';

const EXPIRY_CHOICES = [30, AGENT_TOKEN_DEFAULT_DAYS, 180, AGENT_TOKEN_MAX_DAYS] as const;
const OPTIONAL_SCOPES: readonly AgentScope[] = ['proa:propose', 'proa:write'];
const SCOPE_ORDER: readonly AgentScope[] = ['proa:read', ...OPTIONAL_SCOPES];
const CHECKOUT_STORAGE_KEY = 'proa.checkoutPath';
const NODE_STORAGE_KEY = 'proa.nodeCommand';
const DOCKER_STORAGE_KEY = 'proa.dockerCommand';

/** Per-browser convenience only; the snippets work without it. */
function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode or blocked storage: the field still works for this visit
  }
}

function tokenState(token: AgentToken, now: number): { label: string; tone: string } {
  if (token.revokedAt) return { label: 'Widerrufen', tone: 'bg-danger-soft text-danger' };
  if (Date.parse(token.expiresAt) <= now)
    return { label: 'Abgelaufen', tone: 'bg-warning-soft text-warning' };
  return { label: 'Aktiv', tone: 'bg-success-soft text-success' };
}

function CreateTokenForm({
  project,
  onCreated,
}: {
  project: string;
  onCreated: (token: CreatedAgentToken) => void;
}) {
  const queryClient = useQueryClient();
  const id = useId();
  const [name, setName] = useState('Claude Code');
  const [scopes, setScopes] = useState<ReadonlySet<AgentScope>>(new Set(['proa:propose']));
  const [days, setDays] = useState<number>(AGENT_TOKEN_DEFAULT_DAYS);

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        createAgentToken({
          client: api,
          path: { project },
          body: {
            name: name.trim(),
            scopes: ['proa:read', ...OPTIONAL_SCOPES.filter((s) => scopes.has(s))],
            expiresInDays: days,
          },
        }),
      ),
    onSuccess: (token) => {
      onCreated(token);
      void queryClient.invalidateQueries({ queryKey: keys.agentTokens(project) });
    },
    onError: (error) =>
      toast({ tone: 'danger', title: 'Token nicht erstellt', description: errorMessage(error) }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() !== '') create.mutate();
  }

  return (
    <form onSubmit={submit} aria-label="Agent-Token erstellen">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={100}
            required
            onChange={(e) => setName(e.target.value)}
          />
          <FieldDescription>Woran du den Token später erkennst, z. B. der Client.</FieldDescription>
        </Field>
        <FieldSet>
          <FieldLegend variant="label">Rechte</FieldLegend>
          <Field orientation="horizontal">
            <Checkbox id={`${id}-read`} checked disabled />
            <FieldContent>
              <FieldLabel htmlFor={`${id}-read`}>{SCOPES['proa:read'].label}</FieldLabel>
              <FieldDescription>{SCOPES['proa:read'].hint} Immer dabei.</FieldDescription>
            </FieldContent>
          </Field>
          {OPTIONAL_SCOPES.map((scope) => (
            <Field orientation="horizontal" key={scope}>
              <Checkbox
                id={`${id}-${scope}`}
                checked={scopes.has(scope)}
                onCheckedChange={(checked) =>
                  setScopes((prev) => {
                    const next = new Set(prev);
                    if (checked === true) next.add(scope);
                    else next.delete(scope);
                    return next;
                  })
                }
              />
              <FieldContent>
                <FieldLabel htmlFor={`${id}-${scope}`}>{SCOPES[scope].label}</FieldLabel>
                <FieldDescription>{SCOPES[scope].hint}</FieldDescription>
              </FieldContent>
            </Field>
          ))}
          <FieldDescription>
            Entscheiden dürfen Agent-Tokens nie; das bleibt Menschen vorbehalten.
          </FieldDescription>
        </FieldSet>
        <Field className="max-w-48">
          <FieldLabel htmlFor={`${id}-days`}>Gültigkeit</FieldLabel>
          <NativeSelect
            id={`${id}-days`}
            className="w-full"
            value={String(days)}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {EXPIRY_CHOICES.map((d) => (
              <NativeSelectOption key={d} value={String(d)}>
                {d} Tage
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <div>
          <Button type="submit" disabled={create.isPending || name.trim() === ''}>
            {create.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <KeyRoundIcon data-icon="inline-start" />
            )}
            Token erstellen
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

function CreatedSecret({ token }: { token: CreatedAgentToken }) {
  return (
    <Alert className="border-success bg-success-soft" data-testid="created-secret">
      <ShieldAlertIcon />
      <AlertTitle>Token „{token.name}“ erstellt – kopiere ihn jetzt</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <span>
          Er wird nur dieses eine Mal angezeigt; ProA speichert nur einen Hash. Die Konfigurationen
          unten enthalten ihn bereits.
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <code className="rounded-sm border bg-card px-2 py-1 font-mono text-[13px] break-all text-foreground">
            {token.secret}
          </code>
          <CopyButton value={token.secret} label="Token kopieren" copiedMessage="Token kopiert" />
        </span>
      </AlertDescription>
    </Alert>
  );
}

type DesktopVariant = 'node' | 'docker';

function ClientSetup({ origin, secret }: { origin: string; secret: string | null }) {
  const [variant, setVariant] = useState<DesktopVariant>('node');
  const [checkout, setCheckout] = useState(() => readStored(CHECKOUT_STORAGE_KEY));
  const [nodeCommand, setNodeCommand] = useState(() => readStored(NODE_STORAGE_KEY));
  const [dockerCommand, setDockerCommand] = useState(() => readStored(DOCKER_STORAGE_KEY));
  const id = useId();
  return (
    <Tabs defaultValue="claude-code" className="gap-4">
      <TabsList variant="line" aria-label="MCP-Client">
        <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
        <TabsTrigger value="claude-desktop">Claude Desktop</TabsTrigger>
        <TabsTrigger value="generic">Andere MCP-Clients</TabsTrigger>
      </TabsList>

      <TabsContent value="claude-code" className="flex flex-col gap-3">
        <p className="text-muted-foreground">
          Claude Code spricht ProA direkt über HTTP an. Führe im Terminal aus:
        </p>
        <CodeBlock code={claudeCodeCommand(origin, secret)} label="Befehl für Claude Code" />
        <p className="text-muted-foreground">
          Prüfe danach mit <code className="font-mono">claude mcp list</code>, dass{' '}
          <code className="font-mono">proa</code> verbunden ist. Gleiches gilt für Cursor, VS Code
          und Codex mit derselben URL und demselben Header.
        </p>
      </TabsContent>

      <TabsContent value="claude-desktop" className="flex flex-col gap-3">
        <p className="text-muted-foreground">
          Claude Desktop startet lokale Server nur über stdio. Die Brücke{' '}
          <code className="font-mono">proa mcp</code> leitet an{' '}
          <code className="font-mono">{mcpUrl(origin)}</code> weiter. Trag den Eintrag in{' '}
          <code className="font-mono">claude_desktop_config.json</code> unter{' '}
          <code className="font-mono">mcpServers</code> ein und starte Claude Desktop neu.
        </p>
        <ToggleGroup
          type="single"
          variant="outline"
          value={variant}
          onValueChange={(value) => {
            if (value === 'node' || value === 'docker') setVariant(value);
          }}
          aria-label="Wie läuft ProA?"
        >
          <ToggleGroupItem value="node">Aus dem Repo-Checkout (Node 24)</ToggleGroupItem>
          <ToggleGroupItem value="docker">Im Docker-Container</ToggleGroupItem>
        </ToggleGroup>
        {variant === 'node' ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${id}-checkout`}>Pfad zum ProA-Checkout</FieldLabel>
                <Input
                  id={`${id}-checkout`}
                  placeholder={CHECKOUT_PLACEHOLDER}
                  value={checkout}
                  onChange={(e) => {
                    setCheckout(e.target.value);
                    writeStored(CHECKOUT_STORAGE_KEY, e.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-node`}>Node 24</FieldLabel>
                <Input
                  id={`${id}-node`}
                  placeholder="node"
                  value={nodeCommand}
                  onChange={(e) => {
                    setNodeCommand(e.target.value);
                    writeStored(NODE_STORAGE_KEY, e.target.value);
                  }}
                />
              </Field>
            </div>
            <p className="text-muted-foreground">
              Claude Desktop kennt den <code className="font-mono">PATH</code> deiner Shell nicht;
              trag für Node den vollen Pfad ein (<code className="font-mono">which node</code>). Die
              Datei liegt unter macOS in{' '}
              <code className="font-mono">~/Library/Application Support/Claude/</code>.
            </p>
            <CodeBlock
              code={claudeDesktopNodeConfig(origin, secret, checkout, nodeCommand)}
              label="Claude Desktop: Brücke aus dem Repo-Checkout"
            />
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              Voraussetzung: ProA läuft mit{' '}
              <code className="font-mono">docker compose -f docker/compose.yaml up -d</code> im
              Container <code className="font-mono">{DOCKER_CONTAINER}</code>.
            </p>
            <Field className="sm:max-w-[calc(50%-0.375rem)]">
              <FieldLabel htmlFor={`${id}-docker`}>Docker</FieldLabel>
              <Input
                id={`${id}-docker`}
                placeholder="docker"
                value={dockerCommand}
                onChange={(e) => {
                  setDockerCommand(e.target.value);
                  writeStored(DOCKER_STORAGE_KEY, e.target.value);
                }}
              />
            </Field>
            <p className="text-muted-foreground">
              Auch hier gilt: Claude Desktop kennt den <code className="font-mono">PATH</code>{' '}
              deiner Shell nicht; trag den vollen Pfad ein (
              <code className="font-mono">which docker</code>, unter macOS meist{' '}
              <code className="font-mono">/usr/local/bin/docker</code>).
            </p>
            <CodeBlock
              code={claudeDesktopDockerConfig(secret, dockerCommand)}
              label="Claude Desktop: Brücke im Docker-Container"
            />
          </>
        )}
      </TabsContent>

      <TabsContent value="generic" className="flex flex-col gap-3">
        <p className="text-muted-foreground">
          Jeder MCP-Client mit Streamable HTTP und eigenen Headern funktioniert:
        </p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 rounded-lg border bg-card p-3">
          <dt className="text-muted-foreground">URL</dt>
          <dd className="font-mono break-all" data-testid="mcp-url">
            {mcpUrl(origin)}
          </dd>
          <dt className="text-muted-foreground">Header</dt>
          <dd className="font-mono break-all">
            Authorization: Bearer {secret ?? `${AGENT_TOKEN_PREFIX}…`}
          </dd>
          <dt className="text-muted-foreground">Transport</dt>
          <dd>Streamable HTTP, zustandslos</dd>
        </dl>
        <CodeBlock code={genericMcpConfig(origin)} label="Konfiguration im .mcp.json-Format" />
      </TabsContent>
    </Tabs>
  );
}

function RevokeButton({ project, token }: { project: string; token: AgentToken }) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => unwrap(revokeAgentToken({ client: api, path: { project, token: token.id } })),
    onSuccess: () => {
      toast({ tone: 'success', title: `Token „${token.name}“ widerrufen` });
      void queryClient.invalidateQueries({ queryKey: keys.agentTokens(project) });
      // Its proposals and no-links are withdrawn; its tasks and the models it judged are queued again.
      void queryClient.invalidateQueries({ queryKey: keys.project(project) });
    },
    onError: (error) =>
      toast({ tone: 'danger', title: 'Widerruf fehlgeschlagen', description: errorMessage(error) }),
  });
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={revoke.isPending}>
          Widerrufen
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Token „{token.name}“ widerrufen?</AlertDialogTitle>
          <AlertDialogDescription>
            Clients mit diesem Token verlieren sofort den Zugriff. Seine offenen Vorschläge und
            Einwände („Kein Zusammenhang laut Agent“) werden zurückgezogen. Analysen, die er gerade
            bearbeitet, und alle Modelle, deren Paare er beurteilt hat, warten wieder auf einen
            Agenten. Entscheidungen bleiben. Das lässt sich nicht rückgängig machen; erstelle bei
            Bedarf einen neuen Token. Sollen seine Vorschläge zur Prüfung bleiben, lass den Token
            stattdessen ablaufen.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Abbrechen</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => revoke.mutate()}>
            Widerrufen
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function TokenList({ project }: { project: string }) {
  const tokens = useQuery(agentTokensQuery(project));
  const [now] = useState(() => Date.now());
  if (tokens.isPending) return <Skeleton className="h-24 w-full" />;
  if (tokens.isError)
    return (
      <Alert variant="destructive">
        <AlertTitle>Tokens konnten nicht geladen werden</AlertTitle>
        <AlertDescription>{errorMessage(tokens.error)}</AlertDescription>
      </Alert>
    );
  if (tokens.data.length === 0)
    return <p className="text-muted-foreground">Noch kein Token für dieses Projekt.</p>;
  return (
    <Table aria-label="Agent-Tokens">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Präfix</TableHead>
          <TableHead>Rechte</TableHead>
          <TableHead>Läuft ab</TableHead>
          <TableHead>Zuletzt benutzt</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>
            <span className="sr-only">Aktion</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tokens.data.map((token) => {
          const state = tokenState(token, now);
          return (
            <TableRow key={token.id} data-testid="token-row">
              <TableCell className="font-medium">{token.name}</TableCell>
              <TableCell className="font-mono text-xs">
                {AGENT_TOKEN_PREFIX}
                {token.prefix}…
              </TableCell>
              <TableCell>
                <span className="flex flex-wrap gap-1">
                  {SCOPE_ORDER.filter((s) => token.scopes.includes(s)).map((s) => (
                    <Badge key={s} variant="outline" title={s}>
                      {SCOPES[s].label}
                    </Badge>
                  ))}
                </span>
              </TableCell>
              <TableCell>{formatDate(token.expiresAt)}</TableCell>
              <TableCell>{token.lastUsedAt ? formatDateTime(token.lastUsedAt) : 'nie'}</TableCell>
              <TableCell>
                <Badge variant="outline" className={state.tone}>
                  {state.label}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                {token.revokedAt ? null : <RevokeButton project={project} token={token} />}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * "Agent verbinden" (CONCEPT §6): create an agent token, copy it once, and
 * paste a ready-made configuration into Claude Code, Claude Desktop or any
 * other MCP client; list and revoke tokens.
 */
export function ConnectAgent({ project, origin }: { project: string; origin: string }) {
  const [created, setCreated] = useState<CreatedAgentToken | null>(null);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <Card>
        <CardHeader>
          <CardTitle>1. Token erstellen</CardTitle>
          <CardDescription>
            Ein Agent-Token gilt nur für dieses Projekt. Agenten lesen damit und schlagen vor;
            entscheiden kannst nur du.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <CreateTokenForm project={project} onCreated={setCreated} />
          {created ? <CreatedSecret token={created} /> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>2. Client einrichten</CardTitle>
          <CardDescription>
            {created
              ? 'Die Konfigurationen enthalten deinen neuen Token.'
              : `Erstelle zuerst einen Token; bis dahin steht ${AGENT_TOKEN_PREFIX}… als Platzhalter.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ClientSetup origin={origin} secret={created?.secret ?? null} />
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Tokens dieses Projekts</CardTitle>
          <CardDescription>
            Widerrufe Tokens, die du nicht mehr brauchst. Abgelaufene Tokens funktionieren nicht
            mehr.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TokenList project={project} />
        </CardContent>
      </Card>
    </div>
  );
}
