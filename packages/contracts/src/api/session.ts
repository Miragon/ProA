import { z } from 'zod';

/**
 * Interactive clients (CONCEPT §6, `PROA_INTERACTIVE_CLIENTS`): a user on one
 * of them counts as a human. MCP clients and agent tokens never do.
 */
export const InteractiveClient = z
  .enum(['proa-web', 'proa-cli'])
  .meta({ id: 'InteractiveClient', description: 'Interactive client of a human user.' });
export type InteractiveClient = z.infer<typeof InteractiveClient>;

/** Name of the HttpOnly session cookie of local mode. */
export const SESSION_COOKIE = 'proa_session';

/** Lifetime of a local-mode session cookie (12 hours). */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/**
 * Bytes a `POST /api/v1/session` body may have (it is `{"client":"proa-web"}`
 * at most): the server refuses a longer one with 413 before reading it, so
 * no caller can make it buffer a large body (the route needs no session and
 * is public on the read-only demo).
 */
export const MAX_SESSION_BODY_BYTES = 4 * 1024;

export const CreateSessionBody = z.object({ client: InteractiveClient.default('proa-web') }).meta({
  id: 'CreateSessionBody',
  description: 'Request body to open a local-mode owner session.',
});
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;

/**
 * Local-mode owner key (the CLI's credential): `proa_ok_` + 43 base64url
 * characters (256 random bits). The server creates it on first start in a
 * file only its OS user can read (mode 0600, directory 0700); the `proa` CLI
 * on the same machine reads that file and sends the key as
 * `Authorization: Bearer proa_ok_…` to act as the owner on `proa-cli`. REST
 * only: MCP accepts agent tokens alone.
 */
export const OWNER_KEY_PREFIX = 'proa_ok_';
export const OWNER_KEY_PATTERN = /^proa_ok_[A-Za-z0-9_-]{43}$/;

/** Environment variable naming the owner key file, for the server and the CLI alike. */
export const OWNER_KEY_FILE_ENV = 'PROA_OWNER_KEY_FILE';

/**
 * Default owner key file: `$XDG_STATE_HOME/proa/owner-key`, else
 * `<home>/.local/state/proa/owner-key` (XDG base directories). Pure, so the
 * server and the CLI agree on it.
 *
 * @param env environment variables (`XDG_STATE_HOME` is read)
 * @param home the OS user's home directory
 */
export function defaultOwnerKeyFile(env: Record<string, string | undefined>, home: string): string {
  const xdg = env['XDG_STATE_HOME'];
  const base =
    xdg !== undefined && xdg.startsWith('/') ? xdg : `${home.replace(/[\\/]+$/, '')}/.local/state`;
  return `${base.replace(/[\\/]+$/, '')}/proa/owner-key`;
}
