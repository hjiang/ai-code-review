/**
 * Unified diff parsing and PR file model.
 *
 * Precondition for `parsePatch`: the input is a valid unified diff body, either
 * the bare hunk text from the GitHub pulls/files API `patch` field, or a full
 * `git diff` payload including `diff --git`/`index`/`---`/`+++` header lines.
 * Postcondition: the union of `newLine` values across all returned hunks is
 * exactly the set of valid RIGHT-side anchor lines for that file.
 */

export type DiffLineType = 'add' | 'del' | 'ctx';

export interface DiffLine {
  type: DiffLineType;
  oldLine?: number;
  newLine?: number;
  /** Line content with the leading `+`/`-`/` ` stripped. */
  text: string;
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export type PrFileStatus =
  | 'added'
  | 'removed'
  | 'modified'
  | 'renamed'
  | 'copied'
  | 'unchanged'
  | (string & {});

export interface PrFile {
  filename: string;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  changes: number;
  /** Unified diff body for this file; null when binary or unavailable. */
  patch?: string | null;
}

/** Matches a unified diff hunk header, capturing old/new start line numbers. */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff into hunks. Any line before the first hunk header
 * (file header lines) and any non-hunk marker line (e.g. `\ No newline at end
 * of file`) is ignored.
 */
export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      if (cur) hunks.push(cur);
      oldLine = parseInt(header[1], 10);
      newLine = parseInt(header[2], 10);
      cur = { oldStart: oldLine, newStart: newLine, lines: [] };
      continue;
    }
    if (!cur) continue; // header lines before the first hunk

    let type: DiffLineType;
    let text: string;
    if (raw.startsWith('+')) {
      type = 'add';
      text = raw.slice(1);
    } else if (raw.startsWith('-')) {
      type = 'del';
      text = raw.slice(1);
    } else if (raw.startsWith(' ')) {
      type = 'ctx';
      text = raw.slice(1);
    } else {
      continue; // e.g. `\ No newline at end of file`
    }

    const line: DiffLine = { type, text };
    if (type !== 'add') line.oldLine = oldLine++;
    if (type !== 'del') line.newLine = newLine++;
    cur.lines.push(line);
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/**
 * Set of RIGHT-side (new) line numbers that can host an inline review comment:
 * every added and context line in the diff. Deleted lines cannot be anchored.
 */
export function validAnchors(patch: string): Set<number> {
  const anchors = new Set<number>();
  for (const hunk of parsePatch(patch)) {
    for (const line of hunk.lines) {
      if (line.newLine !== undefined) anchors.add(line.newLine);
    }
  }
  return anchors;
}

/**
 * Fetch all files changed by a PR (paginated, 100 per page, page cap 10),
 * mapping the API shape onto `PrFile`. Missing `patch` (binary) becomes null.
 */
export async function fetchPrFiles(
  octokit: import('./github/types.js').MinimalOctokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PrFile[]> {
  const files: PrFile[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page
    });
    for (const item of data as Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
      patch?: string;
    }>) {
      files.push({
        filename: item.filename,
        status: item.status,
        additions: item.additions,
        deletions: item.deletions,
        changes: item.changes,
        patch: item.patch ?? null
      });
    }
    if (data.length < 100) break;
  }
  return files;
}
