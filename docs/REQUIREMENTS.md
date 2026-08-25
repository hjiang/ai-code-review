# Requirements — AI Code Review Action

A GitHub Action that mimics GitHub Copilot's code review features, but works with
**any OpenAI-compatible or Anthropic-compatible third-party LLM provider**.

## Goals

1. **PR Summary**: Post an insightful summary of the PR changes as a single PR
   comment. Posted **at most once per PR** (idempotent; re-runs are no-ops unless
   force is set).
2. **Inline Review**: Post inline review comments on specific diff lines for
   issues found (bugs, security issues, maintainability, etc.). Can be
   **triggered multiple times per PR** (on push, on label, on `/review` comment,
   or via `workflow_dispatch`).
3. **Provider-agnostic**: Only needs a `base_url` + `api_key` + `model`. Works
   with OpenAI, Anthropic, OpenRouter, DeepSeek, Together, Groq, vLLM, Ollama,
   LM Studio, or any compatible endpoint.

## Non-goals (v1)

- Auto-fixing / committing suggested changes.
- Multi-model consensus review.
- Reviewing files outside the diff.
- Enterprise server support beyond standard `github.com` API (`GITHUB_API_URL`
  passthrough is supported for GHES).

## Functional requirements

### Summary mode
- FR-S1: Triggered on `pull_request` (`opened`, `reopened`, `ready_for_review`).
- FR-S2: Generates a markdown summary: what the PR does, key changes by area,
  risk assessment, testing gaps, notable files.
- FR-S3: Exactly once per PR number. Detection via a hidden HTML marker
  (`<!-- ai-review:summary -->`) in the bot's own issue comments. If found, skip.
- FR-S4: If the PR is a draft, skip unless `review_drafts: true`.

### Review mode
- FR-R1: Triggered on `pull_request` (`synchronize`), issue comment `/review`,
  label, or `workflow_dispatch`.
- FR-R2: Produces inline comments anchored to the **new** side of the diff.
  Comments must land on valid diff lines (validated before posting; invalid
  anchors are dropped, not fatal).
- FR-R3: Each run posts **one PR review** (possibly with "No issues found 🎉"
  body when clean), so repeated runs are visible as distinct reviews.
- FR-R4: Findings are strictly validated: file must be in the diff, line must be
  in a hunk for that file, severity/category from an enum.
- FR-R5: Skips binary files, lockfiles, vendored/generated paths, and files over
  a size cap. Respects `.gitignore`-style exclude patterns from input.
- FR-R6: Diff size cap: if the total diff exceeds a token budget, chunk the
  review across multiple LLM calls and merge findings.
- FR-R7: Never repeat an issue already reported in an existing inline review
  thread on the PR (resolved or not, any author). Prior thread root comments
  are fed into the LLM prompt (semantic layer) and, as a deterministic safety
  net, a finding is dropped when its normalized text overlaps a prior comment
  on the same path (token containment ≥ 0.5 with ≥ 4 shared tokens).

### Provider client
- FR-P1: OpenAI-compatible: `POST {base_url}/chat/completions`, Bearer auth.
- FR-P2: Anthropic-compatible: `POST {base_url}/v1/messages`,
  `x-api-key` + `anthropic-version` headers.
- FR-P3: `provider: auto` — infer from base_url (`api.anthropic.com` → anthropic,
  else openai).
- FR-P4: Strict JSON output: use native JSON mode / response tool if available;
  always validate and re-ask once on parse failure; give up with a clear error
  after 2 attempts.
- FR-P5: Retries on 429/5xx with exponential backoff (max 3), 5-minute total
  request timeout.

## Inputs (action.yml)

| Input | Required | Default | Notes |
|---|---|---|---|
| `mode` | no | `review` | `summary` \| `review` \| `both` |
| `github_token` | no | `${{ github.token }}` | Needs `pull-requests: write` (review) + `issues: write` (summary) |
| `api_base_url` | yes | — | e.g. `https://api.openai.com/v1` |
| `api_key` | yes | — | Secret |
| `model` | yes | — | e.g. `deepseek-chat`, `claude-sonnet-4-5` |
| `provider` | no | `auto` | `openai` \| `anthropic` \| `auto` |
| `max_tokens` | no | `8192` | Completion budget |
| `temperature` | no | `0.2` | |
| `exclude` | no | built-ins | Comma/newline-separated glob patterns |
| `max_files` | no | `40` | Files per review run |
| `max_patch_chars` | no | `100000` | Diff chars sent to the LLM per chunk (also the per-file cap) |
| `review_drafts` | no | `false` | Review draft PRs |
| `fail_on_error` | no | `false` | Fail the workflow if the action errors |

## Outputs

- `summary_posted` (`true|false`), `review_comment_count`, `files_reviewed`.

## Quality attributes

- Deterministic and idempotent where specified; never double-post a summary.
- Never crash the workflow by default (`fail_on_error: false` → log + exit 0).
- Cost-conscious: caps on patch size, file count, retries.
- Fast: single LLM call per chunk; no per-file round trips.

## Environment

- **Development**: Nix flake (`nix develop` / direnv `.envrc`) provides Node 24
  (matching the action's `runs.using: node24`) plus formatting tools. npm
  devDependencies (typescript, vitest, ncc) are installed automatically on
  first shell entry.
- **CI / runners**: must work on **self-hosted runners**, not just GitHub-hosted.
  Example workflows pin the Node version with `actions/setup-node` and do not
  rely on tools preinstalled on GitHub-hosted runners (no `curl`-to-latest,
  no `gh` CLI, no container-only features). The action's only runtime
  dependency is the Node 24 interpreter provided by the runner.
