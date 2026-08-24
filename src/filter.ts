/**
 * File exclusion filtering and diff chunking.
 *
 * `filterFiles` decides which PR files reach the LLM. `chunkFiles` greedily
 * packs the kept files into chunks whose total patch length stays under a
 * character budget, truncating any single oversized file with a marker.
 */

import type { PrFile } from './diff.js';
import { matchesGlob } from './util/glob.js';

export interface FilterOptions {
  mode: 'summary' | 'review';
  /** Extra user-supplied glob patterns (paths to exclude). */
  exclude?: string[];
  /** Per-file patch length cap in chars (default 20000). */
  maxPatchChars?: number;
  /** Maximum number of files kept (default 40). */
  maxFiles?: number;
}

export interface FilterResult {
  kept: PrFile[];
  skipped: { file: string; reason: string }[];
}

const DEFAULT_MAX_PATCH_CHARS = 20000;
const DEFAULT_MAX_FILES = 40;

/** Built-in paths that never contribute to a review. */
const BUILTIN_EXCLUDES = [
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/dist/**',
  '**/vendor/**',
  '**/*.min.*',
  '**/go.sum',
  '**/poetry.lock',
  '**/Cargo.lock',
  '**/*.snap'
];

/** Character budget reserved when truncating an oversized file's patch. */
export const TRUNCATION_MARKER = '\n[…truncated]';

/** Apply exclusions and caps, returning kept files plus a skip log. */
export function filterFiles(files: PrFile[], opts: FilterOptions): FilterResult {
  const maxPatchChars = opts.maxPatchChars ?? DEFAULT_MAX_PATCH_CHARS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const excludes = [...BUILTIN_EXCLUDES, ...(opts.exclude ?? [])];
  const kept: PrFile[] = [];
  const skipped: { file: string; reason: string }[] = [];

  for (const f of files) {
    if (opts.mode === 'review' && f.status === 'removed') {
      skipped.push({ file: f.filename, reason: 'removed file (inline review only)' });
      continue;
    }
    if (!f.patch) {
      skipped.push({ file: f.filename, reason: 'no diff patch (binary or unavailable)' });
      continue;
    }
    if (excludes.some((pattern) => matchesGlob(pattern, f.filename))) {
      skipped.push({ file: f.filename, reason: 'matches exclude pattern' });
      continue;
    }
    if (f.patch.length > maxPatchChars) {
      skipped.push({ file: f.filename, reason: `patch too large (>${maxPatchChars} chars)` });
      continue;
    }
    kept.push(f);
    if (kept.length >= maxFiles) {
      for (const rest of files.slice(files.indexOf(f) + 1)) {
        skipped.push({ file: rest.filename, reason: 'file count limit reached' });
      }
      break;
    }
  }
  return { kept, skipped };
}

/**
 * Greedy-pack files into chunks each under `maxChars` total patch length.
 * Files are kept whole except a single file that alone exceeds the budget,
 * which is emitted in its own chunk with a truncated patch + marker.
 */
export function chunkFiles(files: PrFile[], maxChars: number): PrFile[][] {
  const chunks: PrFile[][] = [];
  let current: PrFile[] = [];
  let currentSize = 0;

  for (const f of files) {
    const size = f.patch?.length ?? 0;
    if (size > maxChars) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
        currentSize = 0;
      }
      const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
      const truncated: PrFile = {
        ...f,
        patch: f.patch ? f.patch.slice(0, budget) + TRUNCATION_MARKER : null
      };
      chunks.push([truncated]);
      continue;
    }
    if (currentSize + size > maxChars && current.length > 0) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(f);
    currentSize += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
