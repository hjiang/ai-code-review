/**
 * PR review + PR metadata helpers.
 */

import type { InlineComment, MinimalOctokit } from './types.js';

export interface ReviewInput {
  commitId: string;
  body: string;
  comments: InlineComment[];
}

export interface PrInfo {
  commitId: string;
  isDraft: boolean;
  title: string;
  body: string;
}

function is422(err: unknown): boolean {
  return (err as { status?: number })?.status === 422;
}

/**
 * Post a single PR review carrying inline comments. If GitHub rejects the
 * payload with a 422 (typically a bad comment anchor), comments are dropped
 * one at a time (from the end, each logged) and the review is retried, so one
 * invalid anchor never blocks the rest. Non-422 errors propagate immediately.
 */
export async function postReview(
  octokit: MinimalOctokit,
  owner: string,
  repo: string,
  prNumber: number,
  input: ReviewInput,
  log: (msg: string) => void = (msg) => console.log(msg)
): Promise<unknown> {
  const comments = [...input.comments];
  const buildPayload = (): Record<string, unknown> => ({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: input.commitId,
    event: 'COMMENT',
    body: input.body,
    comments
  });

  const first = buildPayload();
  let firstErr: unknown;
  try {
    return await octokit.rest.pulls.createReview(first);
  } catch (err) {
    if (!is422(err)) throw err;
    firstErr = err;
  }

  while (comments.length > 0) {
    const dropped = comments.pop()!;
    log(`dropping invalid review comment anchor ${dropped.path}:${dropped.line} (GitHub 422)`);
    try {
      return await octokit.rest.pulls.createReview(buildPayload());
    } catch (err) {
      if (!is422(err)) throw err;
    }
  }
  // Every anchor was rejected (even the final empty-comments attempt);
  // surface the original 422.
  throw firstErr;
}

/** Fetch authoritative PR metadata (head SHA, draft state, title, body). */
export async function getPr(
  octokit: MinimalOctokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PrInfo> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  return {
    commitId: data.head.sha,
    isDraft: data.draft,
    title: data.title,
    body: data.body ?? ''
  };
}
