# Claude Desktop

Claude Desktop starts local MCP servers over stdio, so it runs ProA's bridge `proa mcp`, which
relays every message to `/mcp` with the agent token
([DEVELOPMENT.md, "Connect Claude Desktop"](../../../docs/proa-2/DEVELOPMENT.md#connect-claude-desktop)).
Claude Desktop has no plugin skill; the agent loads the procedure itself with `get_procedure`, as
the start prompt below tells it to (the procedure contains the whole loop).

| File | |
|---|---|
| [`docker-bridge.json`](docker-bridge.json) | entry for ProA in Docker: the bridge runs in the container (`docker exec -i -e PROA_TOKEN proa2-proa-1 proa mcp`) |
| [`checkout-bridge.json`](checkout-bridge.json) | entry for the bridge from the checkout (Node 24, `pnpm install`): `node apps/cli/src/main.ts mcp` with `PROA_URL` |
| [`start-prompt.de.md`](start-prompt.de.md) | German start prompt with the placeholders `{{PROJEKT}}`, `{{MODELL_ID}}`, `{{ANZAHL}}` |

## Set up

1. Create a **fresh project** for the run and an **agent token** for it (read + propose), named
   after the run's recording agent segment (`claude-desktop-1`, `claude-desktop-2`, …); never reuse
   a project across runs: `proa seed <landscape> --project <key> --issue-tokens --token-name
   <name>` creates both ([M3-LIVE-RUNS.md](../../../docs/proa-2/M3-LIVE-RUNS.md), step 2).
2. Merge one entry into `~/Library/Application Support/Claude/claude_desktop_config.json`
   (Windows: `%APPDATA%\Claude\claude_desktop_config.json`; keep other entries) and put the token
   into `env`. `command` must be an absolute path, since Claude Desktop does not get your shell's
   `PATH`: `which docker` for the Docker entry, `node -p process.execPath` for the checkout entry
   (and the absolute path of `apps/cli/src/main.ts`). The **Agent verbinden** page of the web UI
   prints both entries with the real token; `proa token create` and `proa seed --issue-tokens`
   print the one for where they run (in the container the Docker entry, with `"command":
   "docker"` to make absolute; from the checkout the checkout entry).
3. Quit and restart Claude Desktop. `proa` appears under the connectors of a new chat; if it
   fails, see [Troubleshooting](../../../docs/proa-2/DEVELOPMENT.md#troubleshooting).

## Run

1. Open a **new chat** per batch (a fresh context), pick the model, and paste
   [`start-prompt.de.md`](start-prompt.de.md) with the placeholders filled in:
   - `{{PROJEKT}}`: the project key, e.g. `nordwind-handel`;
   - `{{MODELL_ID}}`: the exact API model id of the model you picked, e.g. `claude-opus-5-5`
     (Claude Desktop shows a product name; the agent declares this id as `llmModel`);
   - `{{ANZAHL}}`: the batch size, e.g. `5`.
2. Claude Desktop asks before each tool call. Allowing the ProA tools for the chat (or always)
   lets the loop run; the tools only read and propose, decisions stay with humans.
3. When the batch is done, start the next one in a new chat until `claim_analysis` returns no
   items.

For runs that count as evaluation, leave other connectors (file system, web) off in these
chats, so the agent works from ProA's tools only.

Not verified: Claude Desktop itself (no GUI session here). The two entries are the ones the
Docker job of CI starts the way Claude Desktop does (`apps/cli/test/live/stack.live.test.ts`:
absolute command, launchd-like environment, `docker exec` into the container). Whether Claude
Desktop offers the server's MCP prompt `work_pipeline` in its chat is not documented; the start
prompt does not depend on it.
