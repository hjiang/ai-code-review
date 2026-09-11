# AGENTS.md

## Project

LLM-powered GitHub Action (`node24`, TypeScript strict) for PR summaries and
inline code review. Provider-agnostic: all LLM calls use native `fetch`
against OpenAI-style `/chat/completions` or Anthropic-style `/v1/messages`.
Only runtime deps: `@actions/core`, `@actions/github`. Never add SDKs or shell
out to `gh`/`curl` — keep it runner-portable.

## Commands

Dev environment: Nix flake (`nix develop`, or direnv via `.envrc`) provides
Node 24 (matches `runs.using: node24`); npm deps install on first entry.

```sh
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest run
npm run coverage    # thresholds: 90% lines/functions/statements, 80% branches
npm run build       # ncc bundle src/index.ts -> dist/index.js
```

**`dist/index.js` is committed.** After any change to `src/`, run
`npm run build` and include the rebuilt `dist/` in the same commit.
(`test/dist-freshness.test.ts` fails on a stale bundle.)

## Layout

```
action.yml              # action metadata (inputs/outputs)
src/index.ts            # entry: mode dispatch, top-level error handling
src/{context,diff,filter,review,summarize,prompt}.ts
src/llm/                # client (retry/timeout), openai, anthropic, json
src/github/             # comments, reviews, threads, identity (Octokit)
src/util/               # glob, retry, text
test/                   # vitest specs mirroring src/ (mocked fetch + @actions/github)
docs/                   # REQUIREMENTS.md, ARCHITECTURE.md, plans/
```

## Invariants & conventions

- Design by contract: pre/postconditions for non-trivial functions are
  documented in `docs/ARCHITECTURE.md` — update it when changing contracts.
- Inline review comments must anchor to RIGHT-side lines validated against our
  own unified-diff parse (`parsePatch`); invalid anchors are snapped/dropped,
  never sent to GitHub to fail with 422.
- Summary idempotency: hidden marker `<!-- ai-review:summary -->` in the bot's
  own comment; skip if found. Respect resolved threads (repeat guard).
- The action must not fail the user's workflow unless `fail_on_error: true`.
- LLM responses are manually validated (no Zod); bad findings logged + dropped.
- TDD: write failing test → implement → refactor, including for small fixes.
- Plans live in `docs/plans/NNN-<name>.md`.
