/**
 * Token identity resolution.
 *
 * `botLogin` is the account that authors the action's comments/reviews, used
 * for the loop guard (drop the bot's own comments) and summary marker matching
 * (exactly-once dedup). It MUST be the TOKEN identity (e.g. `github-actions[bot]`),
 * never `github.context.actor` on `issue_comment` events: there the actor is the
 * COMMENT AUTHOR, so an actor fallback would make the loop guard silently drop
 * every human `/review` comment.
 */

/**
 * A structural octokit subset: only getAuthenticated is needed to resolve the
 * token identity. The real octokit (from @actions/github) is assignable to it.
 */
export interface IdentityOctokit {
  rest: {
    users: {
      getAuthenticated: () => Promise<{ data: { login?: string } }>;
    };
  };
}

/**
 * Resolve the token's identity. On failure:
 *  - `issue_comment`: return "" (unresolved) so the loop guard and marker
 *    matching are inert - fail open, process the human command - rather than
 *    misidentifying the comment author as the bot and swallowing `/review`.
 *  - other events: fall back to the actor (historical behaviour).
 */
export async function resolveBotLogin(
  octokit: IdentityOctokit,
  eventName: string,
  actor: string,
  warn: (msg: string) => void = () => {}
): Promise<string> {
  try {
    const { data: me } = await octokit.rest.users.getAuthenticated();
    if (me?.login) return me.login;
  } catch (err) {
    warn(
      `ai-code-review: could not resolve token identity (${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (eventName === 'issue_comment') {
    warn(
      'ai-code-review: token identity unresolved on issue_comment; not using actor ' +
        '(it is the comment author), loop guard disabled for this run'
    );
    return '';
  }
  warn('ai-code-review: token identity unresolved; falling back to actor');
  return actor;
}
