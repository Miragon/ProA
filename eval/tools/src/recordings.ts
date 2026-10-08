// Loads agent recordings (CONCEPT §7):
//   eval/recordings/<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl
// one `proa-recording/1` line (RecordingLine in @proa/contracts) per analysed task.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RecordingLine, recordingPath } from '@proa/contracts';

/** `eval/recordings`. */
export const RECORDINGS_DIR = fileURLToPath(new URL('../../recordings', import.meta.url));

export interface RecordingFile {
  /** Path below the recordings directory, `/`-separated. */
  path: string;
  /** `<procedure>@<version>`, agent and declared model from the path. */
  procedure: string;
  agent: string;
  llmModel: string;
  /** Project key the agent worked on: the landscape name (`sample` for `_sample`). */
  landscape: string;
  lines: RecordingLine[];
}

/** A recording that cannot be read; names the file and line. */
export class RecordingError extends Error {
  override readonly name = 'RecordingError';
}

/** Parses one JSONL recording; `file` is the path below the recordings directory. */
export function parseRecording(file: string, text: string): RecordingFile {
  const parts = file.split('/');
  if (parts.length !== 4 || !parts[3]?.endsWith('.jsonl')) {
    throw new RecordingError(`${file}: expected <procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl`);
  }
  const [procedure, agent, llmModel, name] = parts as [string, string, string, string];
  const landscape = name.slice(0, -'.jsonl'.length);
  const lines: RecordingLine[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new RecordingError(`${file}:${i + 1}: not JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    const parsed = RecordingLine.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new RecordingError(`${file}:${i + 1}: not a proa-recording/1 line (${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''})`);
    }
    const expected = recordingPath(parsed.data);
    if (expected !== file) throw new RecordingError(`${file}:${i + 1}: the line belongs to ${expected}`);
    lines.push(parsed.data);
  }
  if (lines.length === 0) throw new RecordingError(`${file}: no recording lines`);
  return { path: file, procedure, agent, llmModel, landscape, lines };
}

/** Every `*.jsonl` below `dir`, sorted by path; an absent directory has none. */
export async function loadRecordings(dir: string = RECORDINGS_DIR): Promise<RecordingFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
  const files = entries
    .map((e) => e.split(path.sep).join('/'))
    .filter((e) => e.endsWith('.jsonl'))
    .sort();
  const out: RecordingFile[] = [];
  for (const f of files) out.push(parseRecording(f, await readFile(path.join(dir, f), 'utf8')));
  return out;
}

/**
 * The corpus directory of a recorded landscape: `<corpus>/<landscape>`, or
 * `<corpus>/_<landscape>` (`proa seed _sample` loads into project `sample`).
 */
export async function landscapeDir(corpusDir: string, landscape: string): Promise<string> {
  const names = await readdir(corpusDir);
  for (const candidate of [landscape, `_${landscape}`]) {
    if (names.includes(candidate)) return path.join(corpusDir, candidate);
  }
  throw new RecordingError(`no landscape ${landscape} in ${corpusDir}`);
}
