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
   visible as distinct reviews.

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
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
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
| `temperature` | no | `0.2` | |
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
