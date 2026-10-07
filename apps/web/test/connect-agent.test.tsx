import type { AgentToken, CreatedAgentToken } from '@proa/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ConnectAgent } from '../src/components/connect-agent';
import { agentToken } from './support/fixtures';
import { findToast, json, renderWithQuery, stubApi } from './support/render';

const ORIGIN = 'http://127.0.0.1:7400';
const SECRET = 'proa_at_Ab3dE5gHkLmNpQrStUvWxYz0123456789abcdefgh12Ab3d';
const TOKENS_PATH = '/api/v1/projects/demo/agent-tokens';

function setup(initial: AgentToken[] = []) {
  let tokens = [...initial];
  const calls = stubApi({
    [`GET ${TOKENS_PATH}`]: () => json({ items: tokens }),
    [`POST ${TOKENS_PATH}`]: (call) => {
      const body = call.body as {
        name: string;
        scopes: AgentToken['scopes'];
        expiresInDays: number;
      };
      const created: CreatedAgentToken = {
        ...agentToken({ id: 'agt_01NEW', name: body.name, scopes: body.scopes }),
        secret: SECRET,
      };
      tokens = [...tokens, created];
      return json(created, 201);
    },
    [`DELETE ${TOKENS_PATH}/agt_01OLD`]: () => {
      tokens = tokens.map((t) =>
        t.id === 'agt_01OLD' ? { ...t, revokedAt: '2026-10-07T10:00:00.000Z' } : t,
      );
      return new Response(null, { status: 204 });
    },
  });
  const user = userEvent.setup();
  renderWithQuery(<ConnectAgent project="demo" origin={ORIGIN} />);
  return { calls, user };
}

describe('ConnectAgent', () => {
  it('lists the project tokens with prefix, scopes and state', async () => {
    setup([
      agentToken({
        id: 'agt_01OLD',
        name: 'Claude Desktop',
        lastUsedAt: '2026-10-06T12:00:00.000Z',
      }),
      agentToken({ id: 'agt_01GONE', name: 'Alt', revokedAt: '2026-09-01T00:00:00.000Z' }),
      agentToken({ id: 'agt_01EXP', name: 'Abgelaufen', expiresAt: '2025-01-01T00:00:00.000Z' }),
    ]);
    const table = await screen.findByRole('table', { name: 'Agent-Tokens' });
    const rows = within(table).getAllByTestId('token-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('proa_at_Ab3dE5gH…')).toBeTruthy();
    expect(within(rows[0]!).getByText('Lesen')).toBeTruthy();
    expect(within(rows[0]!).getByText('Vorschlagen')).toBeTruthy();
    expect(within(rows[0]!).getByText('Aktiv')).toBeTruthy();
    expect(within(rows[0]!).getByRole('button', { name: 'Widerrufen' })).toBeTruthy();
    expect(within(rows[1]!).getByText('Widerrufen')).toBeTruthy();
    expect(within(rows[1]!).queryByRole('button')).toBeNull();
    expect(
      within(rows[2]!).getByText('Abgelaufen', { selector: '[data-slot=badge]' }),
    ).toBeTruthy();
  });

  it('creates a token, shows the secret once and puts it into the configurations', async () => {
    const { calls, user } = setup();
    expect(await screen.findByText('Noch kein Token für dieses Projekt.')).toBeTruthy();

    // before: placeholders, the exact Claude Code command from CONCEPT §6
    const before = screen.getAllByTestId('code-block')[0]!.textContent;
    expect(before).toBe(
      'export PROA_TOKEN=\'proa_at_…\'\nclaude mcp add --transport http proa http://127.0.0.1:7400/mcp --header "Authorization: Bearer ${PROA_TOKEN}"',
    );

    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Claude Code (Laptop)');
    await user.click(screen.getByRole('checkbox', { name: /Schreiben/ }));
    await user.selectOptions(screen.getByLabelText('Gültigkeit'), '30');
    await user.click(screen.getByRole('button', { name: 'Token erstellen' }));

    const secret = await screen.findByTestId('created-secret');
    expect(within(secret).getByText(SECRET)).toBeTruthy();
    expect(within(secret).getByText(/nur dieses eine Mal angezeigt/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Claude Code (Laptop)',
      scopes: ['proa:read', 'proa:propose', 'proa:write'],
      expiresInDays: 30,
    });

    const command = screen.getAllByTestId('code-block')[0]!.textContent;
    expect(command).toBe(
      `export PROA_TOKEN=${SECRET}\nclaude mcp add --transport http proa http://127.0.0.1:7400/mcp --header "Authorization: Bearer \${PROA_TOKEN}"`,
    );

    await user.click(within(secret).getByRole('button', { name: 'Token kopieren' }));
    expect(await navigator.clipboard.readText()).toBe(SECRET);
    expect(await findToast('Token kopiert')).toBeTruthy();

    // the list is refreshed and shows the new token
    const table = await screen.findByRole('table', { name: 'Agent-Tokens' });
    expect(within(table).getByText('Claude Code (Laptop)')).toBeTruthy();
  });

  it('offers Claude Desktop configurations for the repo checkout and for Docker', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: 'Claude Desktop' }));

    await user.type(screen.getByLabelText('Pfad zum ProA-Checkout'), '/Users/ich/ProA/');
    await user.type(screen.getByLabelText('Node 24'), '/opt/homebrew/bin/node');
    const node = JSON.parse(screen.getByTestId('code-block').textContent) as {
      mcpServers: { proa: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(node.mcpServers.proa).toEqual({
      command: '/opt/homebrew/bin/node',
      args: ['/Users/ich/ProA/apps/cli/src/main.ts', 'mcp'],
      env: { PROA_URL: ORIGIN, PROA_TOKEN: 'proa_at_…' },
    });
    expect(localStorage.getItem('proa.checkoutPath')).toBe('/Users/ich/ProA/');

    await user.click(screen.getByRole('radio', { name: 'Im Docker-Container' }));
    const docker = JSON.parse(screen.getByTestId('code-block').textContent) as {
      mcpServers: { proa: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(docker.mcpServers.proa.command).toBe('docker');
    expect(docker.mcpServers.proa.args).toEqual([
      'exec',
      '-i',
      '-e',
      'PROA_TOKEN',
      'proa2-proa-1',
      'proa',
      'mcp',
    ]);
    expect(docker.mcpServers.proa.env).toEqual({ PROA_TOKEN: 'proa_at_…' });

    // Claude Desktop has no shell PATH: the docker binary can be given absolutely.
    await user.type(screen.getByLabelText('Docker'), '/usr/local/bin/docker');
    const absolute = JSON.parse(screen.getByTestId('code-block').textContent) as {
      mcpServers: { proa: { command: string } };
    };
    expect(absolute.mcpServers.proa.command).toBe('/usr/local/bin/docker');
    expect(localStorage.getItem('proa.dockerCommand')).toBe('/usr/local/bin/docker');
    expect(screen.queryByText(/--profile/)).toBeNull();
  });

  it('shows URL and bearer header for other MCP clients', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: 'Andere MCP-Clients' }));
    expect(screen.getByTestId('mcp-url').textContent).toBe('http://127.0.0.1:7400/mcp');
    expect(screen.getByText('Authorization: Bearer proa_at_…')).toBeTruthy();
    const config = JSON.parse(screen.getByTestId('code-block').textContent) as {
      mcpServers: { proa: { type: string; url: string; headers: Record<string, string> } };
    };
    expect(config.mcpServers.proa).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:7400/mcp',
      headers: { Authorization: 'Bearer ${PROA_TOKEN}' },
    });
  });

  it('revokes a token after confirmation', async () => {
    const { calls, user } = setup([agentToken({ id: 'agt_01OLD', name: 'Claude Desktop' })]);
    const table = await screen.findByRole('table', { name: 'Agent-Tokens' });
    await user.click(within(table).getByRole('button', { name: 'Widerrufen' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Token „Claude Desktop“ widerrufen?')).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Widerrufen' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(await findToast('Token „Claude Desktop“ widerrufen')).toBeTruthy();
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Agent-Tokens' })).getByText('Widerrufen'),
      ).toBeTruthy(),
    );
  });

  it('reports a failed creation instead of failing silently', async () => {
    stubApi({
      [`GET ${TOKENS_PATH}`]: () => json({ items: [] }),
      [`POST ${TOKENS_PATH}`]: () =>
        json(
          {
            type: 'urn:proa:problem:forbidden',
            title: 'Forbidden',
            status: 403,
            code: 'forbidden',
            detail: 'only the owner on an interactive client may create agent tokens',
          },
          403,
        ),
    });
    const user = userEvent.setup();
    renderWithQuery(<ConnectAgent project="demo" origin={ORIGIN} />);
    await user.click(screen.getByRole('button', { name: 'Token erstellen' }));
    expect(await findToast('Token nicht erstellt')).toBeTruthy();
    expect(screen.getByText(/only the owner on an interactive client/)).toBeTruthy();
    expect(screen.queryByTestId('created-secret')).toBeNull();
  });
});
