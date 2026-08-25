/**
 * Summary mode: one-time PR summary comment, idempotent via a hidden marker.
 */

import { findMarkerComment, postComment } from './github/comments.js';
import { fetchPrFiles } from './diff.js';
import { filterFiles } from './filter.js';
import { buildSummaryMessages, SUMMARY_MARKER } from './prompt.js';
import type { ActionConfig, PrContext } from './context.js';
import type { PrInfo, RepoInfo } from './github/reviews.js';
import type { MinimalOctokit } from './github/types.js';
import type { LLMMessage } from './llm/types.js';

export interface SummaryDeps {
  octokit: MinimalOctokit;
  llm: (messages: LLMMessage[]) => Promise<unknown>;
  log?: (msg: string) => void;
}

export interface SummaryResult {
  posted: boolean;
  filesReviewed: number;
}

/**
 * Generate and post a PR summary exactly once per PR number. Draft PRs are
 * skipped unless `review_drafts` is set; re-runs are no-ops once a comment
 * carrying the marker exists.
 */
export async function runSummary(
  cfg: ActionConfig,
  ctx: PrContext,
  prInfo: PrInfo,
  repoInfo: RepoInfo,
  deps: SummaryDeps
): Promise<SummaryResult> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  if (prInfo.isDraft && !cfg.reviewDrafts) {
    log(`summary: skipping draft PR #${ctx.prNumber}`);
    return { posted: false, filesReviewed: 0 };
  }

  const existing = await findMarkerComment(
    deps.octokit,
    ctx.owner,
    ctx.repo,
    ctx.prNumber,
    SUMMARY_MARKER,
    ctx.botLogin
  );
  if (existing) {
    log(`summary: comment already exists (id ${existing.id}), skipping`);
    return { posted: false, filesReviewed: 0 };
  }

  const files = await fetchPrFiles(deps.octokit, ctx.owner, ctx.repo, ctx.prNumber);
  const { kept } = filterFiles(files, {
    mode: 'summary',
    exclude: cfg.exclude,
    maxFiles: cfg.maxFiles,
    maxPatchChars: cfg.maxPatchChars
  });

  const messages = buildSummaryMessages(
    { title: prInfo.title, body: prInfo.body },
    kept,
    cfg.maxPatchChars,
    repoInfo
  );
  const result = await deps.llm(messages);
  const summaryMd = (result as { summary_md?: unknown })?.summary_md;
  if (typeof summaryMd !== 'string' || summaryMd.length === 0) {
    throw new Error('LLM summary result missing a non-empty "summary_md" string');
  }

  const body = `${SUMMARY_MARKER}\n## 🤖 AI Summary\n\n${summaryMd}`;
  await postComment(deps.octokit, ctx.owner, ctx.repo, ctx.prNumber, body);
  log(`summary: posted summary for PR #${ctx.prNumber} (${kept.length} files)`);
  return { posted: true, filesReviewed: kept.length };
}
