import { MAX_IMPORT_BYTES, MAX_IMPORT_FILES, MAX_MODEL_BYTES } from './limits';

/** A file picked or dropped for import, with its path below the import root. */
export interface UploadEntry {
  /** Path below the dropped folder (or the bare file name); the server slugifies it into the model key. */
  path: string;
  file: File;
}

/** File endings the server strips when it derives the model key (apps/server domain/paths.ts). */
const BPMN_SUFFIXES = ['.bpmn20.xml', '.bpmn2', '.bpmn', '.xml'];

export function isBpmnPath(path: string): boolean {
  const lower = path.toLowerCase();
  return BPMN_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Hidden files and folders (`.git/…`, `.DS_Store`) are never models. */
function isHidden(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Drops the first segment of a folder path: dropping `models/` imports
 * `models/vertrieb/auftrag.bpmn` as `vertrieb/auftrag.bpmn`, like
 * `proa import models`.
 */
export function stripRoot(path: string): string {
  const slash = path.indexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** Files from `<input type="file" webkitdirectory>` or a plain multi-file input. */
export function entriesFromFileList(files: Iterable<File>): UploadEntry[] {
  return [...files].map((file) => ({
    path: file.webkitRelativePath ? stripRoot(file.webkitRelativePath) : file.name,
    file,
  }));
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, prefix: string, out: UploadEntry[]): Promise<void> {
  if (entry.isFile) {
    out.push({ path: `${prefix}${entry.name}`, file: await fileOf(entry as FileSystemFileEntry) });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns at most ~100 entries per call; repeat until empty.
  for (;;) {
    const batch = await readEntries(reader);
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

/**
 * Files of a drop, folders included. A dropped folder is the import root:
 * its own name is not part of the paths.
 */
export async function entriesFromDataTransfer(data: DataTransfer): Promise<UploadEntry[]> {
  const roots = [...data.items]
    .filter((item) => item.kind === 'file')
    .map((item) => ({ entry: item.webkitGetAsEntry?.() ?? null, file: item.getAsFile() }));
  const out: UploadEntry[] = [];
  for (const { entry, file } of roots) {
    if (entry?.isDirectory) {
      const inner: UploadEntry[] = [];
      await walk(entry, '', inner);
      out.push(...inner.map((e) => ({ ...e, path: stripRoot(e.path) })));
    } else if (file) {
      out.push({ path: file.name, file });
    }
  }
  return out;
}

export interface UploadPlan {
  /** Batches for `POST …/imports`, each within the file and byte limits. */
  batches: UploadEntry[][];
  /** Files that are not sent, with the reason. */
  skipped: { path: string; reason: 'not-bpmn' | 'too-large' }[];
}

/** Filters BPMN files and splits them into batches the import endpoint accepts. */
export function planUpload(
  entries: readonly UploadEntry[],
  limits = {
    maxFiles: MAX_IMPORT_FILES,
    maxBytes: MAX_IMPORT_BYTES,
    maxModelBytes: MAX_MODEL_BYTES,
  },
): UploadPlan {
  const skipped: UploadPlan['skipped'] = [];
  const batches: UploadEntry[][] = [];
  let batch: UploadEntry[] = [];
  let bytes = 0;
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    if (isHidden(entry.path)) continue;
    if (!isBpmnPath(entry.path)) {
      skipped.push({ path: entry.path, reason: 'not-bpmn' });
      continue;
    }
    if (entry.file.size > limits.maxModelBytes) {
      skipped.push({ path: entry.path, reason: 'too-large' });
      continue;
    }
    if (batch.length >= limits.maxFiles || bytes + entry.file.size > limits.maxBytes) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += entry.file.size;
  }
  if (batch.length > 0) batches.push(batch);
  return { batches, skipped };
}

/**
 * The multipart parts of one import batch. The part's file name carries the
 * path, from which the server derives the model key.
 */
export function filesOf(batch: readonly UploadEntry[]): File[] {
  return batch.map(
    ({ path, file }) =>
      new File([file], path, {
        type: file.type || 'application/xml',
        lastModified: file.lastModified,
      }),
  );
}
