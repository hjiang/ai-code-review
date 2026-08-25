/**
 * Load action inputs and derive the pull-request context from the webhook
 * payload. Pure with respect to injected readers/events so it is unit-testable
 * without mocking @actions/core or @actions/github.
 */

import { resolveProvider } from './llm/client.js';
import type { Provider } from './llm/types.js';

export type Mode = 'summary' | 'review' | 'both';

export type ResponseFormat = 'auto' | 'off';

export interface ActionConfig {
  mode: Mode;
  githubToken: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: Provider;
  maxTokens: number;
  temperature: number;
  responseFormat: ResponseFormat;
  extraBody: Record<string, unknown>;
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

/**
 * Parse a numeric input, falling back to `def` when unset. Throws a clear
 * error naming the input when the value is not a finite number (or violates
 * `min`), so a bad workflow value fails fast instead of producing NaN that
 * later surfaces as a confusing provider API error.
 */
function numInput(
  reader: InputReader,
  name: string,
  def: number,
  parse: (s: string) => number,
  min: number
): number {
  const raw = reader.getInput(name);
  if (!raw) return def;
  const value = parse(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`invalid input "${name}": "${raw}" is not a valid number >= ${min}`);
  }
  return value;
}

const intInput = (reader: InputReader, name: string, def: number, min = 1) =>
  numInput(reader, name, def, (s) => parseInt(s, 10), min);

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

  const responseFormatInput = (reader.getInput('response_format') || 'auto').toLowerCase();
  if (responseFormatInput !== 'auto' && responseFormatInput !== 'off') {
    throw new Error(`invalid response_format "${responseFormatInput}": expected auto | off`);
  }

  const extraBodyRaw = reader.getInput('extra_body') || '';
  let extraBody: Record<string, unknown> = {};
  if (extraBodyRaw.trim()) {
    try {
      const parsed = JSON.parse(extraBodyRaw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not a JSON object');
      }
      extraBody = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`invalid input "extra_body": "${extraBodyRaw}" is not a valid JSON object`);
    }
  } else if (/api\.deepseek\.com/i.test(baseUrl)) {
    // DeepSeek's API defaults thinking to ENABLED (documented at
    // https://api-docs.deepseek.com) and its v4 reasoning models spend their
    // whole token budget on reasoning_content for review-sized prompts,
    // returning empty content (measured: 100% of 8k/16k budgets). Opt DeepSeek
    // reviews out of thinking mode unless the user configures extra_body
    // themselves (an explicit extra_body always wins).
    extraBody = { thinking: { type: 'disabled' } };
  }

  return {
    mode: modeInput as Mode,
    githubToken: reader.getInput('github_token'),
    apiKey,
    baseUrl,
    model,
    provider: resolveProvider(reader.getInput('provider') || 'auto', baseUrl),
    maxTokens: intInput(reader, 'max_tokens', 8192),
    temperature: numInput(reader, 'temperature', 0.2, (s) => parseFloat(s), 0),
    responseFormat: responseFormatInput as ResponseFormat,
    extraBody,
    exclude: splitPatterns(reader.getInput('exclude')),
    maxFiles: intInput(reader, 'max_files', 40),
    maxPatchChars: intInput(reader, 'max_patch_chars', 100000),
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
 *
 * `botLogin` must be the TOKEN identity (e.g. `github-actions[bot]`), never
 * `github.context.actor`: on `issue_comment` events the actor is the comment
 * author, so an actor-based loop guard would silently drop every human
 * `/review` comment, and using it as the marker-match identity would break the
 * summary exactly-once dedup.
 */
export function loadContext(
  eventName: string,
  payload: Record<string, any>,
  reader: InputReader,
  botLogin: string
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
    return { owner, repo: repoName, prNumber: pr.number, botLogin };
  }

  if (eventName === 'issue_comment') {
    const issue = payload?.issue as { number?: number; pull_request?: unknown } | undefined;
    if (!issue?.number || !issue.pull_request) return null; // not a PR comment
    const comment = payload?.comment as { body?: string; user?: { login?: string } } | undefined;
    const author = comment?.user?.login ?? '';
    // Loop guard: drop only when the bot identity is KNOWN and matches the
    // author. An empty botLogin means identity resolution failed (see
    // resolveBotLogin) - the guard must stay inert (fail open) so a human
    // /review command is processed rather than silently dropped.
    if (botLogin !== '' && author && author.toLowerCase() === botLogin.toLowerCase()) {
      return null;
    }
    const trigger = reader.getInput('comment_trigger') || '/review';
    if (!comment?.body?.trim().startsWith(trigger)) return null;
    return {
      owner,
      repo: repoName,
      prNumber: issue.number,
      botLogin,
      issueComment: { author, body: comment.body ?? '' }
    };
  }

  if (eventName === 'workflow_dispatch') {
    const prNumber = parseInt(reader.getInput('pr_number'), 10);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error('workflow_dispatch requires a valid "pr_number" input');
    }
    return { owner, repo: repoName, prNumber, botLogin };
  }

  throw new Error(`unsupported event "${eventName}"`);
}
