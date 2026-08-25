/**
 * Action entry point: load config + context, build the Octokit and LLM
 * closures, dispatch to the requested modes, and set outputs. Top-level error
 * handling never fails the workflow unless `fail_on_error` is set.
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { loadConfig, loadContext } from './context.js';
import type { ActionConfig, InputReader } from './context.js';
import { getPr } from './github/reviews.js';
import { callLLM, LLMError } from './llm/client.js';
import type { LLMConfig, LLMMessage } from './llm/types.js';
import { buildAnthropicUrl, buildOpenAiUrl } from './llm/url.js';
import { runReview } from './review.js';
import { runSummary } from './summarize.js';

const reader: InputReader = {
  getInput: (name: string) => core.getInput(name),
  setSecret: (value: string) => core.setSecret(value)
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let cfg: ActionConfig | undefined;

/**
 * Resolve the TOKEN identity (the account that authors comments/reviews), so
 * loop-guard and summary marker-match can compare against the bot itself.
 * On `issue_comment` events `github.context.actor` is the comment author, so
 * it must never be used as the bot identity. Falls back to the actor (old
 * behaviour) only if the token cannot be resolved.
 */
async function resolveBotLogin(
  octokit: ReturnType<typeof github.getOctokit>
): Promise<string> {
  try {
    const { data: me } = await octokit.rest.users.getAuthenticated();
    if (me?.login) return me.login;
  } catch (err) {
    core.warning(`ai-code-review: could not resolve token identity (${errMessage(err)}); falling back to actor`);
  }
  return github.context.actor;
}

async function main(): Promise<void> {
  cfg = loadConfig(reader);

  const octokit = github.getOctokit(cfg.githubToken);
  const botLogin = await resolveBotLogin(octokit);

  const ctx = loadContext(
    github.context.eventName,
    github.context.payload as Record<string, any>,
    reader,
    botLogin
  );
  if (!ctx) {
    core.info('ai-code-review: no actionable PR context, exiting silently');
    return;
  }

  const prInfo = await getPr(octokit, ctx.owner, ctx.repo, ctx.prNumber);

  const llmCfg: LLMConfig = {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    log: (msg: string) => core.info(`ai-code-review: ${msg}`)
  };
  const endpoint =
    cfg.provider === 'anthropic' ? buildAnthropicUrl(cfg.baseUrl) : buildOpenAiUrl(cfg.baseUrl);
  core.info(
    `ai-code-review: llm provider=${cfg.provider} model=${cfg.model} jsonMode=${llmCfg.jsonMode ?? 'auto'} endpoint=${endpoint}`
  );
  const llm = (messages: LLMMessage[]) => callLLM(llmCfg, messages);

  let summaryPosted = false;
  let reviewCommentCount = 0;
  let filesReviewed = 0;

  if (cfg.mode === 'summary' || cfg.mode === 'both') {
    const result = await runSummary(cfg, ctx, prInfo, { octokit, llm });
    summaryPosted = result.posted;
    filesReviewed = result.filesReviewed;
  }
  if (cfg.mode === 'review' || cfg.mode === 'both') {
    const result = await runReview(cfg, ctx, prInfo, { octokit, llm });
    reviewCommentCount = result.commentCount;
    filesReviewed = result.filesReviewed;
  }

  core.setOutput('summary_posted', String(summaryPosted));
  core.setOutput('review_comment_count', String(reviewCommentCount));
  core.setOutput('files_reviewed', String(filesReviewed));
  core.info(
    `ai-code-review: summary_posted=${summaryPosted} comments=${reviewCommentCount} files=${filesReviewed}`
  );
}

main().catch((err) => {
  core.error(`ai-code-review: ${errMessage(err)}`);
  if (err instanceof LLMError) {
    core.error(
      `(hint: check api_base_url / model "${cfg?.model}" / api_key; the raw LLM replies are printed above)`
    );
  }
  core.setOutput('summary_posted', 'false');
  core.setOutput('review_comment_count', '0');
  core.setOutput('files_reviewed', '0');
  process.exitCode = cfg?.failOnError ? 1 : 0;
});
