/**
 * Load action inputs and derive the pull-request context from the webhook
 * payload. Pure with respect to injected readers/events so it is unit-testable
 * without mocking @actions/core or @actions/github.
 */

import { resolveProvider } from './llm/client.js';
import type { Provider } from './llm/types.js';

export type Mode = 'summary' | 'review' | 'both';

export interface ActionConfig {
  mode: Mode;
  githubToken: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: Provider;
  maxTokens: number;
  temperature: number;
  exclude: string[];
  maxFiles: number;
  maxPatchChars: number;
  reviewDrafts: boolean;
  commentTrigger: string;
  failOnError: boolean;
}

export interface IssueCommentInfo {
  author: string;
  body: string;
}

export interface PrContext {
  owner: string;
  repo: string;
  prNumber: number;
  botLogin: string;
  issueComment?: IssueCommentInfo;
}

export interface InputReader {
  getInput(name: string): string;
  setSecret(value: string): void;
}

function toBool(value: string): boolean {
  return value.toLowerCase() === 'true';
}

/** Split comma/newline separated input into trimmed non-empty patterns. */
export function splitPatterns(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read and validate all action inputs. Throws when required inputs are absent. */
export function loadConfig(reader: InputReader): ActionConfig {
  const apiKey = reader.getInput('api_key');
  const baseUrl = reader.getInput('api_base_url');
  const model = reader.getInput('model');
  const githubToken = reader.getInput('github_token');
  if (!apiKey) throw new Error('required input "api_key" is missing');
  if (!baseUrl) throw new Error('required input "api_base_url" is missing');
  if (!model) throw new Error('required input "model" is missing');
  if (!githubToken) throw new Error('required input "github_token" is missing');
  reader.setSecret(apiKey);

  const modeInput = (reader.getInput('mode') || 'review').toLowerCase();
  if (modeInput !== 'summary' && modeInput !== 'review' && modeInput !== 'both') {
    throw new Error(`invalid mode "${modeInput}": expected summary | review | both`);
  }

  return {
    mode: modeInput as Mode,
    githubToken: reader.getInput('github_token'),
    apiKey,
    baseUrl,
    model,
    provider: resolveProvider(reader.getInput('provider') || 'auto', baseUrl),
    maxTokens: parseInt(reader.getInput('max_tokens') || '8192', 10),
    temperature: parseFloat(reader.getInput('temperature') || '0.2'),
    exclude: splitPatterns(reader.getInput('exclude')),
    maxFiles: parseInt(reader.getInput('max_files') || '40', 10),
    maxPatchChars: parseInt(reader.getInput('max_patch_chars') || '100000', 10),
    reviewDrafts: toBool(reader.getInput('review_drafts')),
    commentTrigger: reader.getInput('comment_trigger') || '/review',
    failOnError: toBool(reader.getInput('fail_on_error'))
  };
}

/**
 * Derive { owner, repo, prNumber, botLogin } from the webhook payload for the
 * three supported event kinds. Returns null when the run should exit silently:
 * a comment on a non-PR issue, a comment that is not the trigger, or the bot
 * replying to itself.
 */
export function loadContext(
  eventName: string,
  payload: Record<string, any>,
  reader: InputReader,
  actor: string
): PrContext | null {
  const repo = payload?.repository as
    | { name?: string; owner?: { login?: string } }
    | undefined;
  if (!repo?.name || !repo.owner?.login) {
    throw new Error('could not determine repository from event payload');
  }
  const owner = repo.owner.login;
  const repoName = repo.name;

  if (eventName === 'pull_request') {
    const pr = payload?.pull_request as { number?: number } | undefined;
    if (!pr?.number) throw new Error('pull_request event missing pull_request number');
    return { owner, repo: repoName, prNumber: pr.number, botLogin: actor };
  }

  if (eventName === 'issue_comment') {
    const issue = payload?.issue as { number?: number; pull_request?: unknown } | undefined;
    if (!issue?.number || !issue.pull_request) return null; // not a PR comment
    const comment = payload?.comment as { body?: string; user?: { login?: string } } | undefined;
    const author = comment?.user?.login ?? '';
    if (author && author.toLowerCase() === actor.toLowerCase()) return null; // loop guard
    const trigger = reader.getInput('comment_trigger') || '/review';
    if (!comment?.body?.trim().startsWith(trigger)) return null;
    return {
      owner,
      repo: repoName,
      prNumber: issue.number,
      botLogin: actor,
      issueComment: { author, body: comment.body ?? '' }
    };
  }

  if (eventName === 'workflow_dispatch') {
    const prNumber = parseInt(reader.getInput('pr_number'), 10);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error('workflow_dispatch requires a valid "pr_number" input');
    }
    return { owner, repo: repoName, prNumber, botLogin: actor };
  }

  throw new Error(`unsupported event "${eventName}"`);
}
