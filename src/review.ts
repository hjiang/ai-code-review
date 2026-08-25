/**
 * Review mode: inline review comments on the PR diff, re-triggerable. Each run
 * posts one PR review so repeated runs appear as distinct reviews.
 */

import { fetchPrFiles, validAnchors } from './diff.js';
import { chunkFiles, filterFiles } from './filter.js';
import { buildReviewMessages } from './prompt.js';
import { postReview } from './github/reviews.js';
import type { ActionConfig, PrContext } from './context.js';
import type { PrInfo, RepoInfo } from './github/reviews.js';
import type { PrFile } from './diff.js';
import type { MinimalOctokit, InlineComment } from './github/types.js';
import type { LLMMessage } from './llm/types.js';

export type Severity = 'critical' | 'warning' | 'suggestion';

export interface RawFinding {
  path?: string;
  line?: number;
  severity?: string;
  category?: string;
  comment_md?: string;
  suggestion_md?: string | null;
}

export interface ValidFinding {
  path: string;
  line: number;
  severity: Severity;
  category: string;
  comment_md: string;
  suggestion_md: string | null;
}

export interface ReviewDeps {
  octokit: MinimalOctokit;
  llm: (messages: LLMMessage[]) => Promise<unknown>;
  log?: (msg: string) => void;
}

export interface ReviewResult {
  commentCount: number;
  filesReviewed: number;
}

const SEVERITIES: Severity[] = ['critical', 'warning', 'suggestion'];
const MAX_COMMENTS = 30;
const LINE_SNAP_TOLERANCE = 3;

const severityRank: Record<Severity, number> = { critical: 2, warning: 1, suggestion: 0 };

function resolveFile(path: string, prFiles: PrFile[]): PrFile | undefined {
  const exact = prFiles.find((f) => f.filename === path);
  if (exact) return exact;
  const normalized = path.replace(/^\.\//, '').replace(/^b\//, '');
  return prFiles.find((f) => f.filename.toLowerCase() === normalized.toLowerCase());
}

/** Nearest anchor within `tolerance` lines, preferring the exact line. */
function nearestAnchor(anchors: Set<number>, line: number, tolerance: number): number | undefined {
  if (anchors.has(line)) return line;
  for (let d = 1; d <= tolerance; d++) {
    if (anchors.has(line + d)) return line + d;
    if (anchors.has(line - d)) return line - d;
  }
  return undefined;
}

/**
 * Validate LLM findings against the actual diff. Invalid entries are logged and
 * dropped; valid ones are deduped by (path, line) keeping the highest severity
 * and capped at MAX_COMMENTS. Never returns an anchor GitHub would reject.
 */
export function validateFindings(
  findings: RawFinding[],
  prFiles: PrFile[],
  log: (msg: string) => void
): ValidFinding[] {
  const anchorsByPath = new Map<string, Set<number>>();
  const byKey = new Map<string, ValidFinding>();
  const skipped: string[] = [];

  for (const raw of findings) {
    const path = raw.path ?? '';
    const line = typeof raw.line === 'number' ? raw.line : NaN;
    const file = resolveFile(path, prFiles);
    if (!file?.patch) {
      skipped.push(`"${path || '<no path>'}" not in diff`);
      continue;
    }
    let anchors = anchorsByPath.get(file.filename);
    if (!anchors) {
      anchors = validAnchors(file.patch);
      anchorsByPath.set(file.filename, anchors);
    }
    const anchored = nearestAnchor(anchors, line, LINE_SNAP_TOLERANCE);
    if (anchored === undefined) {
      skipped.push(`${file.filename}:${line} outside diff hunks`);
      continue;
    }
    const comment = raw.comment_md?.trim() ?? '';
    if (comment.length === 0) {
      skipped.push(`${file.filename}:${line} empty comment`);
      continue;
    }
    const severity: Severity = SEVERITIES.includes(raw.severity as Severity)
      ? (raw.severity as Severity)
      : 'suggestion';
    const finding: ValidFinding = {
      path: file.filename,
      line: anchored,
      severity,
      category: raw.category?.trim() || 'code',
      comment_md: comment,
      suggestion_md: raw.suggestion_md?.trim() || null
    };
    const key = `${finding.path}:${finding.line}`;
    const existing = byKey.get(key);
    if (!existing || severityRank[finding.severity] > severityRank[existing.severity]) {
      byKey.set(key, finding);
    }
  }

  for (const s of skipped) log(`review: dropped finding - ${s}`);
  // Prefer higher severity when capping; Array#sort is stable, so equal
  // severities keep their original (deterministic) insertion order.
  return [...byKey.values()]
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity])
    .slice(0, MAX_COMMENTS);
}

function severityCounts(findings: ValidFinding[]): Record<Severity, number> {
  return {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    suggestion: findings.filter((f) => f.severity === 'suggestion').length
  };
}

/**
 * Review the PR diff via the LLM and post one PR review with validated inline
 * comments. Chunks are processed sequentially to respect provider rate limits.
 */
export async function runReview(
  cfg: ActionConfig,
  ctx: PrContext,
  prInfo: PrInfo,
  repoInfo: RepoInfo,
  deps: ReviewDeps
): Promise<ReviewResult> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  if (prInfo.isDraft && !cfg.reviewDrafts) {
    log(`review: skipping draft PR #${ctx.prNumber}`);
    return { commentCount: 0, filesReviewed: 0 };
  }

  const files = await fetchPrFiles(deps.octokit, ctx.owner, ctx.repo, ctx.prNumber);
  const { kept } = filterFiles(files, {
    mode: 'review',
    exclude: cfg.exclude,
    maxFiles: cfg.maxFiles,
    maxPatchChars: cfg.maxPatchChars
  });

  if (kept.length === 0) {
    const body = '## 🤖 AI Review\n\nNothing to review (all files were filtered out).';
    await postReview(deps.octokit, ctx.owner, ctx.repo, ctx.prNumber, {
      commitId: prInfo.commitId,
      body,
      comments: []
    });
    return { commentCount: 0, filesReviewed: 0 };
  }

  const chunks = chunkFiles(kept, cfg.maxPatchChars);
  const rawFindings: RawFinding[] = [];
  for (const chunk of chunks) {
    const messages = buildReviewMessages(chunk, cfg.maxPatchChars, repoInfo);
    const result = (await deps.llm(messages)) as { findings?: unknown };
    if (Array.isArray(result?.findings)) {
      rawFindings.push(...(result.findings as RawFinding[]));
    } else {
      log('review: LLM reply had no findings array, ignoring chunk output');
    }
  }

  const valid = validateFindings(rawFindings, kept, log);
  const counts = severityCounts(valid);
  const body =
    `## 🤖 AI Review\n\n` +
    `Model: \`${cfg.model}\` · Files reviewed: ${kept.length}\n\n` +
    `**${valid.length} finding(s)**: ` +
    `🔴 ${counts.critical} critical · 🟠 ${counts.warning} warnings · 🔵 ${counts.suggestion} suggestions\n\n` +
    (valid.length === 0 ? 'No issues found 🎉' : '');

  const comments: InlineComment[] = valid.map((f) => ({
    path: f.path,
    line: f.line,
    body: f.comment_md,
    side: 'RIGHT' as const
  }));

  await postReview(deps.octokit, ctx.owner, ctx.repo, ctx.prNumber, {
    commitId: prInfo.commitId,
    body,
    comments
  });
  log(`review: posted ${valid.length} inline comments for PR #${ctx.prNumber}`);
  return { commentCount: valid.length, filesReviewed: kept.length };
}
