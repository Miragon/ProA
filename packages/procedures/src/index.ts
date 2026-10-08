/**
 * `@proa/procedures`: the analysis instructions for agents (CONCEPT §7),
 * written once as `packages/procedures/<name>.md` with frontmatter `id`,
 * `version`, `title` and `status`. MCP `get_procedure` serves them; the
 * Claude Code plugin will wrap the same text (M3).
 *
 * Status: one placeholder, `proa-relations@0.0.1` (the real procedure is M3).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Directory holding the procedure Markdown files (the package root). */
export const PROCEDURES_DIR = fileURLToPath(new URL('..', import.meta.url));

export interface Procedure {
  /** E.g. `proa-relations`; agents declare `<id>@<version>` with their submissions. */
  id: string;
  /** Semantic version, e.g. `0.1.0`. */
  version: string;
  title: string;
  /** `placeholder` until the real procedure ships, then `released`. */
  status: string;
  /** File name without `.md`, accepted as an alias of `id` (`relations`). */
  name: string;
  /** The Markdown body without frontmatter. */
  text: string;
}

/** Thrown for a procedure file without valid frontmatter. */
export class ProcedureFormatError extends Error {
  override readonly name = 'ProcedureFormatError';
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const REQUIRED = ['id', 'version', 'title', 'status'] as const;

/**
 * Parses one procedure file: `key: value` lines between `---` fences, then
 * the Markdown body.
 *
 * @throws {ProcedureFormatError} if the frontmatter is missing or incomplete
 */
export function parseProcedure(name: string, source: string): Procedure {
  const m = FRONTMATTER.exec(source);
  if (!m?.[1]) throw new ProcedureFormatError(`${name}: missing frontmatter`);
  const fields = new Map<string, string>();
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv?.[1] && kv[2] !== undefined) fields.set(kv[1], kv[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  for (const key of REQUIRED) {
    if (!fields.get(key)) throw new ProcedureFormatError(`${name}: frontmatter lacks ${key}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(fields.get('version') ?? '')) {
    throw new ProcedureFormatError(`${name}: version must be semver (x.y.z)`);
  }
  return {
    id: fields.get('id') ?? '',
    version: fields.get('version') ?? '',
    title: fields.get('title') ?? '',
    status: fields.get('status') ?? '',
    name,
    text: source.slice(m[0].length).trim(),
  };
}

let cache: Procedure[] | undefined;

/** Every procedure in {@link PROCEDURES_DIR}, sorted by id (read once). */
export function listProcedures(): Procedure[] {
  cache ??= readdirSync(PROCEDURES_DIR)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => parseProcedure(f.slice(0, -3), readFileSync(`${PROCEDURES_DIR}/${f}`, 'utf8')))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return cache;
}

/** A procedure by `id` (`proa-relations`) or file name (`relations`); `null` if unknown. */
export function getProcedure(idOrName: string): Procedure | null {
  return listProcedures().find((p) => p.id === idOrName || p.name === idOrName) ?? null;
}
