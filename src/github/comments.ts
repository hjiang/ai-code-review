/**
 * Issue comment helpers: marker-based idempotency lookup and posting.
 */

import type { MinimalOctokit, PrComment } from './types.js';

const MAX_PAGES = 10;
const PER_PAGE = 100;

/**
 * Find the bot's own issue comment that carries `marker` (e.g. the summary
 * marker). Pages through comments until found or the page cap is reached.
 * Author is matched case-insensitively against `botLogin`.
 */
export async function findMarkerComment(
  octokit: MinimalOctokit,
  owner: string,
  repo: string,
  prNumber: number,
  marker: string,
  botLogin: string
): Promise<PrComment | null> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: PER_PAGE,
      page
    });
    for (const comment of data) {
      const author = comment.user?.login;
      if (
        comment.body?.includes(marker) &&
        author !== undefined &&
        author.toLowerCase() === botLogin.toLowerCase()
      ) {
        return comment;
      }
    }
    if (data.length < PER_PAGE) break;
  }
  return null;
}

/** Post an issue comment on the PR conversation. */
export async function postComment(
  octokit: MinimalOctokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<unknown> {
  return octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body
  });
}
