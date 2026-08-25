/**
 * Previously reported inline review comments (one per review thread), used so
 * a re-run does not repeat issues the PR has already discussed — resolved or
 * not.
 */

import type { MinimalOctokit } from './types.js';

export interface PreviousComment {
  path: string;
  line: number | null;
  body: string;
}

const MAX_PAGES = 10;
const PER_PAGE = 100;

/**
 * Fetch one entry per review thread on the PR, from its root comment (a review
 * comment with no `in_reply_to_id` starts a thread; replies belong to it). Both
 * resolved and open threads are included — a resolved thread is just as much a
 * previously-reported issue as an open one. Entries without a path or a
 * non-empty body are skipped: they cannot be matched anyway.
 */
export async function fetchPreviousComments(
  octokit: MinimalOctokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PreviousComment[]> {
  const out: PreviousComment[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: PER_PAGE,
      page
    });
    for (const c of data) {
      if (c.in_reply_to_id) continue; // reply within a thread, not a new issue
      const path = c.path?.trim();
      const body = c.body?.trim();
      if (!path || !body) continue;
      out.push({
        path,
        line: c.line ?? c.original_line ?? null,
        body
      });
    }
    if (data.length < PER_PAGE) break;
  }
  return out;
}
