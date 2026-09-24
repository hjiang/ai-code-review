# AI Code Review

A GitHub Action that mimics GitHub Copilot's code review experience but works
with **any OpenAI-compatible or Anthropic-compatible LLM provider** — OpenAI,
Anthropic, OpenRouter, DeepSeek, Groq, Together, vLLM, Ollama, LM Studio, or
any other endpoint speaking those protocols.

Two features:

1. **PR Summary** — an insightful markdown summary of what the PR changes.
   Posted **at most once per PR** (idempotent; re-runs are no-ops).
2. **Inline Review** — inline comments on specific diff lines for real issues
   (bugs, security, correctness, performance, …). **Re-triggerable multiple
   times per PR**; each run posts one GitHub PR review so repeat runs are
   visible as distinct reviews. Re-runs **do not repeat issues already
   reported** in existing review threads (resolved or not): prior comments are
   shown to the LLM and textually-similar repeats are dropped.

> GIF placeholder: demo of the summary comment and an inline review run.

## Why this action

- **Provider-agnostic.** Just a `base_url` + `api_key` + `model`. No vendor SDK;
  all LLM calls use native `fetch` against `/chat/completions` (OpenAI-style)
  or `/v1/messages` (Anthropic-style).
- **Self-hosted friendly.** A pure `node24` JavaScript action — no Docker, no
  `gh` CLI, no tools beyond the Actions runner software. See
  [Self-hosted runners](#self-hosted-runners).
- **Safe by default.** Findings are validated against the real diff before
  posting (bad line anchors are snapped or dropped, never rejected by GitHub),
  and the action never fails your workflow unless you ask it to.

## Quickstart

Add both workflows to your repository (they call the action in this repo via
`uses: ./`, so keep the action checked out), then configure the secrets.

### 1. PR summary (once per PR)

`.github/workflows/ai-summary.yml`:

```yaml
name: AI PR Summary
on:
  pull_request:
    types: [opened, reopened, ready_for_review]
permissions:
  pull-requests: write
  issues: write # summary posts via the issue-comments API
  contents: read
concurrency:
  group: ai-summary-${{ github.event.pull_request.number }}
  cancel-in-progress: false
jobs:
  summary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: ./
        with:
          mode: summary
          api_base_url: ${{ secrets.LLM_BASE_URL }}
          api_key: ${{ secrets.LLM_API_KEY }}
          model: ${{ vars.LLM_MODEL }}
```

### 2. Inline review (re-triggerable)

`.github/workflows/ai-review.yml`:

```yaml
name: AI Code Review
on:
  pull_request:
    types: [synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr_number:
        description: 'PR number'
        required: true
permissions:
  pull-requests: write
  contents: read
concurrency:
  group: ai-review-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr_number }}
  cancel-in-progress: true
jobs:
  review:
    if: >
      github.event_name == 'pull_request' ||
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request != null &&
       startsWith(github.event.comment.body, '/review'))
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: ./
        with:
          mode: review
          pr_number: ${{ inputs.pr_number || '' }}
          api_base_url: ${{ secrets.LLM_BASE_URL }}
          api_key: ${{ secrets.LLM_API_KEY }}
          model: ${{ vars.LLM_MODEL }}
```

**Re-triggering.** Post a comment starting with `/review` on the PR to run
another review. Pushing new commits (`synchronize`) also re-runs it. You can
also use **Run workflow** (workflow_dispatch) and give it a PR number.

### 3. Optional: enable extended thinking

DeepSeek `deepseek-flash` needs nothing — thinking is auto-enabled at low
effort when `extra_body` is unset. For anything else, use the `thinking`
input (and give it token headroom):

```yaml
      - uses: ./
        with:
          mode: review
          api_base_url: ${{ secrets.LLM_BASE_URL }}
          api_key: ${{ secrets.LLM_API_KEY }}
          model: ${{ vars.LLM_MODEL }}
          thinking: high       # auto | off | low | medium | high | max
          max_tokens: 32000    # thinking tokens count against this budget
          timeout: 0           # no client-side cap; streaming keeps this safe
```

The level maps per provider: DeepSeek/OpenAI-style models get
`reasoning_effort`; Anthropic gets adaptive thinking + `output_config.effort`
on Claude 4.6+/5.x, or extended thinking with `budget_tokens` derived from
`max_tokens` on 4.5 and earlier. Gateways with their own knob (OpenRouter's
`reasoning`) stay on `extra_body` — see
[Notes & limitations](#notes--limitations).

### Required secrets / variables

| Name | Where | Example |
|---|---|---|
| `LLM_BASE_URL` | repo/org secret | `https://api.openai.com/v1` |
| `LLM_API_KEY` | repo/org secret | `sk-...` |
| `LLM_MODEL` | repo/org variable | `gpt-4o`, `deepseek-chat`, `claude-sonnet-4-5`, `qwen2.5-coder:14b` |

## Provider configuration

| Provider | `LLM_BASE_URL` | Example model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Anthropic | `https://api.anthropic.com` | `claude-sonnet-4-5` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash` (thinking auto-enabled at low effort; see Notes) |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Together | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| Ollama (local) | `http://localhost:11434/v1` | `qwen2.5-coder:14b` |
| vLLM | `http://your-host:8000/v1` | `Qwen/Qwen2.5-Coder-14B-Instruct` |

`provider` defaults to `auto`: base URLs containing `api.anthropic.com` use the
Anthropic adapter; everything else uses the OpenAI adapter. Override with the
`provider` input if your gateway behaves differently.

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `mode` | no | `review` | `summary` \| `review` \| `both` |
| `github_token` | no | `${{ github.token }}` | Needs `pull-requests: write` (review) + `issues: write` (summary) |
| `api_base_url` | yes | — | LLM API base URL |
| `api_key` | yes | — | Secret |
| `model` | yes | — | Model name |
| `provider` | no | `auto` | `openai` \| `anthropic` \| `auto` |
| `max_tokens` | no | `8192` | Completion budget |
| `temperature` | no | — | `0.2` for OpenAI-compatible providers; unset for Anthropic, whose 4.7+/5.x models reject non-default values with a 400 |
| `thinking` | no | `auto` | `auto` \| `off` \| `low` \| `medium` \| `high` \| `max`. Normalized thinking effort: DeepSeek/OpenAI-style → `reasoning_effort`; Anthropic → adaptive thinking + `output_config.effort` (4.6+/5.x) or extended thinking with `budget_tokens` auto-derived from `max_tokens` (≤4.5). See Notes. |
| `timeout` | no | `300` | Deadline in seconds for the whole LLM call (all retries and re-asks); `0` = no client-side cap. Responses stream (SSE) with a 5-minute no-bytes stall detector, so long model thinking is safe; provider limits still apply. |
| `response_format` | no | `auto` | `auto` \| `off`. `auto` sends `response_format: json_object` and auto-retries without it on an empty/rejected completion; `off` never sends it. Reasoning models can burn the whole token budget on reasoning with `json_object` and return empty content; the action auto-retries once without `response_format` in that case, so `auto` stays the recommended default.
| `extra_body` | no | - | Optional JSON object merged into the LLM request body (user keys win). DeepSeek V4.1-Flash models (`deepseek-flash`, or the retired `deepseek-v4-flash` alias) get `{"thinking":{"type":"enabled"},"reasoning_effort":"low"}` automatically (see Notes); override to disable thinking (`{"thinking":{"type":"disabled"}}`) or raise the effort. Retried once without it if the provider rejects it with 400. |
| `exclude` | no | built-ins | Extra glob excludes (comma/newline separated) |
| `max_files` | no | `40` | Files per review run |
| `max_patch_chars` | no | `100000` | Diff chars sent to the LLM per chunk (also the per-file patch cap) |
| `review_drafts` | no | `false` | Review draft PRs |
| `comment_trigger` | no | `/review` | Issue-comment trigger text |
| `pr_number` | no | — | Required for `workflow_dispatch` |
| `fail_on_error` | no | `false` | Fail the workflow if the action errors |

Built-in excludes always apply: lockfiles (`*.lock`, `package-lock.json`,
`yarn.lock`, `pnpm-lock.yaml`, `go.sum`, `Cargo.lock`, `poetry.lock`),
`dist/**`, `vendor/**`, `*.min.*`, and `*.snap` files.

## Outputs

- `summary_posted` — `"true"` when a summary comment was posted this run.
- `review_comment_count` — number of inline comments posted.
- `files_reviewed` — number of files reviewed.

## Self-hosted runners

- The action is a pure `node24` JavaScript action — it runs on any runner the
  Actions runner software supports (Linux/macOS/Windows, ARM64, containers,
  ephemeral or persistent self-hosted runners).
- `actions/setup-node@v4` pins Node 24 before `uses: ./` for runners whose
  default toolchain differs; the runner-provided node24 runtime executes the
  action itself.
- **Node runtime requirement**: `runs.using: node24` needs the node24 external
  on the runner. The Actions runner provisions it automatically after
  install/`config.sh`; on minimal setups run `./bin/installExternalDeps` from
  the runner directory once.
- **Network egress**: the runner needs access to the GitHub API
  (`api.github.com`, or your GHES URL — `GITHUB_API_URL` is respected) and the
  configured LLM `base_url`.
- No Docker required, no `gh` CLI, and no other preinstalled tooling.

## Notes & limitations

- **Reasoning models**: they can spend their whole token budget on
  `reasoning_content` and return `content: ""` with `finish_reason: length`
  - i.e. no review at all. Measurements against the previous DeepSeek v4-flash
  on a ~14k-char diff (5 trials per config):
  - **`response_format: json_object` amplified the burn while thinking was
    enabled** - but it is harmless once thinking is controlled, so the default
    `auto` is fine. (The action also detects empty completions and retries
    the same prompt without `response_format` before re-asking.)
  - **Raising `max_tokens` is a threshold, not a dial.** Reasoning consumed
    100% of both an 8k and a 16k budget (every trial empty); 32k barely
    cleared it (~2/3 usable, ~16× slower, ~17× tokens, *and fewer findings*
    than thinking disabled - median 3 vs 8). Reasoning appetite scales with
    diff size, so larger diffs silently break again at any fixed budget.
  - **`reasoning_effort: "low"` measured poorly on v4-flash**: it reported the
    fewest findings of any config (median 2, one trial zero) - reduced
    reasoning made the model hedge ("can't be sure without more context") and
    suppress real issues.
- **DeepSeek default: thinking ON at low effort (automatic).** The retired
  v4-flash-era API defaulted thinking to **enabled** (documented at
  api-docs.deepseek.com), which is what made v4-flash burn its budget - so
  this action used to auto-apply `thinking: {"type": "disabled"}`.
  DeepSeek-V4.1-Flash (model
  `deepseek-flash`; the retired `deepseek-v4-flash` name is routed to it)
  added a reasoning-effort control and claims improved reasoning efficiency,
  so the action now auto-applies `{"thinking":{"type":"enabled"},"reasoning_effort":"low"}`
  (via `extra_body`) whenever `api_base_url` points at `api.deepseek.com`, the
  configured model is V4.1-Flash (`deepseek-flash`, or the retired
  `deepseek-v4-flash` alias - `deepseek-chat` and other models are left
  untouched), and you have not set `extra_body` yourself. This re-enables
  thinking while
  bounding its cost; if a run still returns empty content, drop back with
  `extra_body: '{"thinking":{"type":"disabled"}}'` (measured on v4-flash:
  ~10s per call vs 60-165s, valid JSON on every trial, more findings). An
  explicit `extra_body` always wins - including `{}` (send nothing).
- **Enabling thinking per provider** — prefer the `thinking` input
  (`auto | off | low | medium | high | max`, default `auto`); an explicit
  `extra_body` still overrides whatever the input maps to:
  - DeepSeek (any model): `thinking: high` → `reasoning_effort: high`
    (effort alone enables reasoning; measured on `deepseek-flash` and
    `deepseek-chat`, 2026-09-24). `thinking: off` sends
    `{"thinking":{"type":"disabled"}}` on `api.deepseek.com`.
  - Anthropic Claude 4.6+/5.x: `thinking: high` → adaptive thinking +
    `output_config.effort: high`. Claude 4.5 and earlier reject that shape, so
    the action retries once with extended thinking and a `budget_tokens`
    derived from `max_tokens` (low 20%, medium 35%, high 50%, max 70%,
    clamped to `[1024, max_tokens - 1024]` — the API requires ≥1024 and
    strictly less than `max_tokens`, and the reply needs room). `thinking:
    off` sends no thinking configuration (newest models reject `disabled`).
  - Prefill/reasoning models that always think (e.g. `deepseek-reasoner`):
    nothing to configure; `thinking: off` sends no controls, but such models
    may still reason.
  - Gateways with their own unified knob (OpenRouter: `reasoning: {effort}` or
    `reasoning: {max_tokens}`) — set it via `extra_body`, e.g.
    `'{"reasoning":{"effort":"high"}}'`.
  - Thinking tokens count against `max_tokens`, so raise it (see the
    reasoning-model measurements above); thinking is slow, so consider
    `timeout: 0` (safe with streaming) or a larger value.
- **Repo context**: the LLM prompt includes repository metadata fetched from
  the GitHub API — `owner/repo`, **visibility (public/private)**, description,
  default branch, primary language, and fork/archived flags — so the model can
  weigh findings accordingly (e.g. a leaked credential is more severe in a
  public repo). No extra inputs are required.
- **Fork PRs**: with the default `GITHUB_TOKEN`, workflows from forks get a
  read-only token, so inline reviews won't be posted. Use a fine-grained PAT or
  GitHub App token for public repos (same limitation Copilot-style bots hit).
- Draft PRs are skipped unless `review_drafts: true`.
- The action never fails your workflow by default — errors are logged and the
  job still succeeds. Set `fail_on_error: true` to make it fail loudly.

## Local development

```bash
# Node 24 + npm, pinned via the Nix flake (or use direnv)
nix develop            # or: direnv allow

npm install            # first time
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run coverage       # vitest with coverage (thresholds in vitest.config.ts)
npm run build          # bundle to dist/index.js (committed)
```

See `docs/ARCHITECTURE.md` and `docs/plans/001-ai-code-review-action.md` for
design details.

## License

MIT
