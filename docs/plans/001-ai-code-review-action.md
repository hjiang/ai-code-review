# Plan: AI Code Review Action

Goal: a GitHub Action that posts a one-time insightful PR summary and
re-triggerable inline code-review comments, using any OpenAI/Anthropic-compatible
LLM endpoint. See `docs/REQUIREMENTS.md` and `docs/ARCHITECTURE.md`.

Implementation order is TDD-first and dependency-ordered: pure functions first
(diff parsing, filtering, validation - highest test value), then LLM client with
mocked fetch, then GitHub API layer with mocked Octokit, then prompts, then the
two modes, then wiring, then packaging.

---

## Phase 0: Scaffold (15 min)

1. `git init` (done), create:
   - `package.json` (type: module, scripts: `build` -> `ncc build src/index.ts -o dist`,
     `test` -> `vitest run`, `typecheck` -> `tsc --noEmit`)
   - `tsconfig.json` (strict, ES2022, NodeNext, `outDir` unused - ncc bundles)
   - `vitest.config.ts`, `.gitignore` (`node_modules`, coverage)
   - `action.yml` with all inputs/outputs from REQUIREMENTS (see §action.yml below)
2. `npm i @actions/core @actions/github && npm i -D typescript vitest @vercel/ncc @types/node`
3. `src/index.ts` stub: `console.log('ok')`. Verify `npm run build` produces
   `dist/index.js`.
4. Commit: `chore: scaffold typescript action`

**Done when**: `npm test` (0 tests) and `npm run build` both succeed.

---

## Phase 1: Diff engine — pure functions (TDD)

### 1.1 `src/diff.ts` — unified diff parser

`parsePatch(patch: string): Hunk[]` where
`Hunk = { oldStart: number; newStart: number; lines: DiffLine[] }`,
`DiffLine = { type: 'add'|'del'|'ctx'; oldLine?: number; newLine?: number; text: string }`.

**Write failing tests first** (`test/diff.test.ts`):
- Simple 1-hunk patch: correct add/del/ctx line numbers.
- Multi-hunk patch: `newStart` resets per hunk (`@@ -a,b +c,d @@`).
- Hunk header without counts (`@@ -1 +1 @@`).
- Empty patch / patch with no trailing newline.
- Lines starting with `++`/`--` inside content (only first char counts).
- File header lines (`diff --git`, `index`, `---`, `+++`) are not part of hunks
  when parsing a `patch` field from the files API (test both: raw `git diff`
  output with headers, and bare hunk-only patch).

Helper: `validAnchors(patch: string): Set<number>` -> set of RIGHT-side line
numbers (add + ctx lines). This is the invariant used by validation later.

### 1.2 `src/filter.ts` — exclusion + chunking

`filterFiles(files: PrFile[], opts): { kept: PrFile[]; skipped: {file, reason}[] }`
- Skip: `status` in (`removed` → keep for summary, skip for inline review — make
  it a flag), binary (no `patch`), path matches built-in or user globs, file
  patch > per-file cap (default 20k chars).
- Built-in excludes: `**/*.lock`, `**/package-lock.json`, `**/pnpm-lock.yaml`,
  `**/yarn.lock`, `**/dist/**`, `**/vendor/**`, `**/*.min.*`, `**/go.sum`,
  `poetry.lock`, `Cargo.lock`, `**/*.snap`.
- Glob matching: implement minimal (`*`, `**`, `?`) matcher in `src/util/glob.ts`
  (test it: `src/**.ts`, `dist/**` etc.) — avoids another dependency.

`chunkFiles(files: PrFile[], maxChars): PrFile[][]` — greedy pack keeping files
whole; oversized single file gets truncated with a `[…truncated]` marker.

**Tests** (`test/filter.test.ts`, `test/glob.test.ts`): each skip reason, glob
edge cases, chunk packing boundaries (file spanning boundary stays whole),
truncation marker.

**Done when**: all tests green; run them, confirm they failed before implementation
where meaningful (at minimum write tests before code for `parsePatch` and `chunkFiles`).

---

## Phase 2: LLM client (TDD with mocked fetch)

### 2.1 `src/llm/client.ts`

```ts
callLLM(cfg: LLMConfig, messages: Msg[], opts): Promise<unknown>
// LLMConfig = { provider: 'openai'|'anthropic', baseUrl, apiKey, model,
//               maxTokens, temperature }
```

- `resolveProvider(input, baseUrl)`: `api.anthropic.com` in host → anthropic,
  else openai (unless explicit).
- **OpenAI adapter** (`openai.ts`): `POST {baseUrl}/chat/completions`,
  `Authorization: Bearer`, body `{model, messages, temperature, max_tokens,
  response_format: {type:'json_object'}}` — but `response_format` must be
  omittable: probe with it, and on a 400 mentioning it, retry once without
  (many third-party endpoints don't support it). Config flag `json_mode: 'auto'|'off'`.
- **Anthropic adapter** (`anthropic.ts`): `POST {baseUrl}/v1/messages`,
  headers `x-api-key`, `anthropic-version: 2023-06-01`; system prompt goes in
  the `system` field, not messages.
- Retries (`src/util/retry.ts`): on 429/5xx/network error, backoff 2s → 8s → 32s
  (jitter ±20%), max 3 attempts, total timeout 5 min via `AbortSignal.timeout`.
- Extract text from either response shape; then `extractJson` (`json.ts`):
  strip ```` ```json fences ````, find first `{`/`[` to matching last `}`/`]`,
  `JSON.parse`. On parse failure → re-ask once with error appended
  ("Your previous reply was not valid JSON: <err>. Reply with JSON only.").
  After 2 failures throw `LLMError`.

**Tests** (`test/llm/*.test.ts`) with global `fetch` stub:
- Request shape for both providers (headers, URL, body).
- `resolveProvider` cases.
- 429 → retries with backoff (fake timers), succeeds on 2nd attempt.
- 5xx exhausted → LLMError.
- 400 on `response_format` → retried without it (openai adapter).
- JSON extraction: clean JSON, fenced JSON, JSON with prose around it,
  invalid JSON → re-ask → valid second reply; both invalid → LLMError.
- Anthropic system-prompt placement.

---

## Phase 3: GitHub layer (TDD with mocked Octokit)

### 3.1 `src/github/comments.ts`

- `findMarkerComment(octokit, o, r, pr, marker)`: paginate
  `GET /repos/{o}/{r}/issues/{n}/comments` (per_page 100), return first comment
  whose `body` includes marker AND `user.login` matches the token identity
  (pass `botLogin` in; compare case-insensitive).
- `postComment(octokit, o, r, pr, body)`: POST same endpoint.

**Tests**: marker found/not found, pagination (stub 2 pages), pagination
exhaustion guard (hard cap 10 pages).

### 3.2 `src/github/reviews.ts`

- `postReview(octokit, o, r, pr, { commitId, body, comments })`:
  `POST /repos/{o}/{r}/pulls/{n}/reviews` with
  `{ commit_id, event: 'COMMENT', body, comments: [{path, body, side:'RIGHT', line}] }`.
- If `comments` is empty → still post review with body "No issues found 🎉"
  (callers decide; keep the function dumb - just posts what it's given).
- 422 handling: if GitHub rejects a comment anchor, drop that comment and retry
  once without it (log which). Tests: one bad anchor among good ones → second
  call contains only good ones.

### 3.3 `src/context.ts`

- Read all inputs via `@actions/core` with defaults from action.yml; validate
  required ones (`api_base_url`, `api_key`, `model`).
- Derive `{ owner, repo, prNumber, commitId, isDraft, title, body }`:
  - `github.event.pull_request.*` for pull_request events.
  - **`issue_comment` event**: PR number from `github.event.issue.number`, but
    must verify `issue.pull_request` exists (else exit 0 - not a PR) and skip if
    the comment author is the bot itself (avoid loops).
  - `workflow_dispatch`: input `pr_number` (required in that workflow).
- `core.setSecret(apiKey)` immediately.

**Tests** with stubbed `core`/`github` context: all three event shapes,
non-PR issue comment → exit 0 path, missing required input → error.

---

## Phase 4: Prompts

### 4.1 `src/prompt.ts` (unit-testable pure builders)

- `SUMMARY_MARKER = '<!-- ai-review:summary -->'`
- `buildSummaryMessages(pr, files)`: system prompt = "You are a senior engineer
  writing a PR summary for reviewers…" (concise, no fluff, use PR title/body as
  context, list key changes grouped by area, risk level with justification,
  testing gaps). User content = PR metadata + file list (path, +/- counts) +
  patches (truncated). Output JSON schema:
  `{ "summary_md": string }` — action wraps with the marker + header.
- `buildReviewMessages(files)`: system prompt covering: bug risk, security,
  correctness, error handling, race conditions, API misuse, performance,
  readability. Rules: **only report real issues, no nitpick spam, no style
  nits unless egregious, max 1 comment per distinct issue, cite line numbers
  from the NEW side of the diff, skip generated/vendored code**. Output schema:
  ```json
  { "findings": [ { "path": string, "line": number, "severity": "critical"|"warning"|"suggestion",
                    "category": string, "comment_md": string, "suggestion_md": string|null } ] }
  ```
  `comment_md` must be self-contained: severity emoji header (`🔴/🟠/🔵`),
  what's wrong, why it matters, concrete fix. Include few-shot example finding
  in the system prompt.
- Both builders must respect `max_patch_chars` (truncate + marker).

**Tests**: schema strings present, truncation applied, prompt sizes bounded,
PR metadata included.

---

## Phase 5: The two modes

### 5.1 `src/summarize.ts`

```
runSummary(ctx, llm, gh):
  if (pr.isDraft && !cfg.reviewDrafts) -> log, return { posted: false }
  comment = findMarkerComment(...)
  if (comment) -> log 'summary exists', return { posted: false }
  files = filterFiles(fetchPrFiles(...), {mode:'summary'})
  msgs = buildSummaryMessages(pr, files)
  { summary_md } = callLLM(...)   // validate shape
  body = `${SUMMARY_MARKER}\n## 🤖 AI Summary\n\n${summary_md}`
  postComment(...)
  return { posted: true }
```

**Tests**: draft skip, marker exists → no LLM call, no marker → one LLM call +
one postComment with marker in body, LLM returns bad shape → error propagates.

### 5.2 `src/review.ts`

```
runReview(ctx, llm, gh):
  if (pr.isDraft && !cfg.reviewDrafts) -> skip
  prFiles = fetchPrFiles(...)
  files = filterFiles(..., {mode:'review'})   // skip removed files for inline
  if files empty -> post review "Nothing to review (all files filtered)."
  chunks = chunkFiles(files, cfg.maxPatchChars)
  findings = (for each chunk: buildReviewMessages -> callLLM).flat()  // sequential, not parallel (rate limits)
  valid = validateFindings(findings, files)   // path ∈ diff && line ∈ validAnchors(patch)
  body = header: model name, files reviewed count, N findings by severity
  postReview(..., commitId, body, valid.map(toInlineComment))
  return { commentCount: valid.length, filesReviewed: files.length }
```

- `validateFindings` in `src/review.ts`: drop + `core.warning` each invalid
  finding (path not in diff → try case-insensitive/leading-`./` repair first;
  line out of range → snap to nearest valid anchor in same file if within 3
  lines, else drop; unknown severity → 'suggestion').
- Dedup identical `(path, line)` findings, keep highest severity.
- Cap total comments at 30 per run (config not needed; hard cap).

**Tests**: everything in validateFindings (path repair, line snap, drop,
dedup, cap), empty-files path, chunk-merge, body format, review posted with
correct payload.

---

## Phase 6: Entry point + action.yml

### 6.1 `src/index.ts`

```ts
async function main() {
  const ctx = loadContext();
  const cfg = loadConfig();
  const octokit = github.getOctokit(cfg.githubToken);
  const llm = (m: Msg[]) => callLLM(cfg, m, ...);
  if (cfg.mode includes 'summary') await runSummary(...);
  if (cfg.mode includes 'review')  await runReview(...);
  // set outputs
}
main().catch(e => { core.error(errMessage(e)); core.setOutput(...) zeros;
                    process.exitCode = cfg.failOnError ? 1 : 0; });
```

Guard: on `issue_comment`, only run when the comment is `/review` (or `/ai-review`)
— add input `comment_trigger` default `/review`. This keeps re-triggering cheap
and explicit.

### 6.2 `action.yml` (full)

```yaml
name: 'AI Code Review'
description: 'LLM-powered PR summaries and inline code review comments using any OpenAI/Anthropic-compatible provider'
inputs:
  mode:            { description: 'summary | review | both', default: 'review', required: false }
  github_token:    { description: 'GitHub token', default: '${{ github.token }}', required: false }
  api_base_url:    { description: 'LLM API base URL', required: true }
  api_key:         { description: 'LLM API key', required: true }
  model:           { description: 'Model name', required: true }
  provider:        { description: 'openai | anthropic | auto', default: 'auto', required: false }
  max_tokens:      { default: '8192', required: false }
  temperature:     { default: '0.2', required: false }
  exclude:         { description: 'Extra glob excludes (multiline)', default: '', required: false }
  max_files:       { default: '40', required: false }
  max_patch_chars: { default: '100000', required: false }
  review_drafts:   { default: 'false', required: false }
  comment_trigger: { default: '/review', required: false }
  fail_on_error:   { default: 'false', required: false }
outputs:
  summary_posted:      { description: '"true" if a summary comment was posted this run' }
  review_comment_count: { description: 'Number of inline comments posted' }
  files_reviewed:      { description: 'Number of files reviewed' }
runs:
  using: 'node20'
  main: 'dist/index.js'
```

---

## Phase 7: Example workflows + README

### 7.1 `.github/workflows/ai-summary.yml`

```yaml
name: AI PR Summary
on:
  pull_request:
    types: [opened, reopened, ready_for_review]
permissions:
  pull-requests: write
  contents: read
concurrency:
  group: ai-summary-${{ github.event.pull_request.number }}
  cancel-in-progress: false
jobs:
  summary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4   # only so the local action resolves; not needed at runtime
      - uses: ./
        with:
          mode: summary
          api_base_url: ${{ secrets.LLM_BASE_URL }}
          api_key: ${{ secrets.LLM_API_KEY }}
          model: ${{ vars.LLM_MODEL }}
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

### 7.2 `.github/workflows/ai-review.yml`

```yaml
name: AI Code Review
on:
  pull_request:
    types: [synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr_number: { description: 'PR number', required: true }
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
      - uses: ./
        with:
          mode: review
          pr_number: ${{ inputs.pr_number || '' }}
          api_base_url: ${{ secrets.LLM_BASE_URL }}
          api_key: ${{ secrets.LLM_API_KEY }}
          model: ${{ vars.LLM_MODEL }}
```

Note: for `issue_comment` from forks, `github.token` is read-only — document
using a PAT/App token in README (known GitHub limitation, same as Copilot).

### 7.3 `README.md`

What it does, animated demo GIF placeholder, quickstart (both workflows),
provider config table (OpenAI / Anthropic / OpenRouter / DeepSeek / Groq /
Together / Ollama / vLLM base URLs + example models), inputs reference,
self-hosted note, fork limitation, license (MIT).

---

## Phase 8: Packaging & verification

1. `npm run typecheck && npm test && npm run build` all green.
2. Commit `dist/index.js`.
3. **Live smoke test**: create a test repo, add a PR with an intentionally
   buggy file (e.g., SQL string concat injection + off-by-one), wire real
   provider secrets, verify:
   - summary posted exactly once (re-run workflow → no duplicate);
   - `/review` comment on the PR triggers a second review with distinct review
     object;
   - inline comments land on correct lines;
   - draft PR skipped.
4. Tag `v0.1.0`.

---

## Risk register (for the implementing agent)

| Risk | Mitigation |
|---|---|
| Third-party endpoints reject `response_format` | auto-retry without it (Phase 2.1) |
| LLM hallucinates line numbers | anchor validation + snapping (Phase 5.2) — never post unvalidated |
| Summary double-post on race | workflow-level `concurrency` group; marker check right before post |
| Bot replies to own `/review` | author check in context.ts (Phase 3.3) |
| Huge diffs burn tokens | chunk cap + file cap + per-file truncation |
| Fork PRs can't be reviewed with default token | documented; recommend PAT or GitHub App for public repos |
| Anthropic base_url already contains `/v1` | normalize: strip trailing `/`, ensure openai path appends `/chat/completions` and anthropic appends `/v1/messages` idempotently (add tests for both `…/v1` and bare hosts) |

## Definition of done

- [ ] All Phase 1–5 modules implemented test-first; `npm test` ≥ 90% lines on `src/`
- [ ] `dist/index.js` built and committed; action works via `uses: ./`
- [ ] Summary exactly-once verified live; review re-trigger verified live
- [ ] README + docs match final behavior
