import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { MAX_IMPORT_BYTES, MAX_IMPORT_FILES, MAX_MODEL_BYTES } from '@proa/contracts';

import { CliError } from './errors.ts';

/** File names the import picks up (the server derives the model key from the path). */
const BPMN_FILE = /\.(bpmn|bpmn2|bpmn20\.xml)$/i;
/** Directories never descended into. */
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

export interface BpmnFile {
  /** Path below the import root with `/` separators: the server's model key source. */
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/**
 * Every BPMN file below `dir` (`.bpmn`, `.bpmn2`, `.bpmn20.xml`), sorted by
 * path. Hidden directories, `node_modules` and symbolic links are skipped.
 *
 * @throws {CliError} if `dir` is not a directory
 */
export async function findBpmnFiles(dir: string): Promise<BpmnFile[]> {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) throw new CliError(`${dir} is not a directory`);

  const found: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIPPED_DIRS.has(e.name)) await walk(child);
      } else if (e.isFile() && BPMN_FILE.test(e.name)) {
        found.push(child);
      }
    }
  }
  await walk('');
  found.sort();
  return Promise.all(
    found.map(async (p) => ({ path: p, bytes: new Uint8Array(await readFile(path.join(dir, p))) })),
  );
}

/**
 * Splits files into import requests of at most {@link MAX_IMPORT_FILES}
 * files and {@link MAX_IMPORT_BYTES} bytes, keeping the order. Files above
 * {@link MAX_MODEL_BYTES} are returned as `oversized` and never sent.
 */
export function batches(files: readonly BpmnFile[]): {
  batches: BpmnFile[][];
  oversized: BpmnFile[];
} {
  const out: BpmnFile[][] = [];
  const oversized: BpmnFile[] = [];
  let current: BpmnFile[] = [];
  let bytes = 0;
  for (const f of files) {
    if (f.bytes.byteLength > MAX_MODEL_BYTES) {
      oversized.push(f);
      continue;
    }
    if (current.length === MAX_IMPORT_FILES || bytes + f.bytes.byteLength > MAX_IMPORT_BYTES) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(f);
    bytes += f.bytes.byteLength;
  }
  if (current.length > 0) out.push(current);
  return { batches: out, oversized };
}
