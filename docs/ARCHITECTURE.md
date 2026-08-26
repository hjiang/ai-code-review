# Architecture - AI Code Review Action

## Stack

- **Runtime**: `runs.using: node24` - the Node 24 interpreter is provisioned
  by the Actions runner itself (GitHub-hosted *and* self-hosted runners both
  auto-provision the declared node runtime externals). No other runtime deps.
- **Language**: TypeScript, strict mode.
- **Build**: `@vercel/ncc` bundles `src/index.ts` -> single-file `dist/index.js`
  committed to the repo (standard for composite/marketplace actions).
- **Tests**: `vitest` with mocked `fetch` and mocked `@actions/github`.
- **Dev environment**: Nix flake (`nix develop`, or direnv via `.envrc`)
  providing Node 24 pinned to the same major version as `runs.using`, so local
  builds/tests exercise the same runtime as the runner. npm devDependencies
  are installed automatically on first shell entry.
- **Deps (runtime, minimal)**:
  - `@actions/core`, `@actions/github` (Octokit).
  - Nothing else. LLM calls use **native `fetch`** (available in Node >= 18) -
    no OpenAI/Anthropic SDK, so every compatible provider works without code
    changes. No dependency on `gh` CLI or anything outside the action bundle.

## Runner compatibility (self-hosted)

- The action is a pure `node24` JavaScript action: it runs anywhere the
  Actions runner runs (Linux/macOS/Windows, ARM, containers, ephemeral or
  persistent self-hosted runners).
- Example workflows use `actions/setup-node@v4` with an explicit
  `node-version: 24` before `uses: ./` - this keeps the job's Node consistent
  on runners with odd default toolchains and costs nothing on GitHub-hosted
  runners (`cache: npm` is disabled because `node_modules` is not used at
  runtime; `dist/` is committed).
- The workflows never shell out to `gh`, `curl`, `jq`, etc. - all GitHub API
  access goes through Octokit, all LLM access through native `fetch`.
- Self-hosted runners with egress restrictions need network access to:
  `api.github.com` (or the GHES API URL) and the configured LLM `base_url`.

## Repository layout

```
action.yml                  # Action metadata (inputs/outputs)
src/
  index.ts                  # Entry: resolve mode, dispatch, top-level error handling
  context.ts                # Read action inputs + github context; build PR ref
  diff.ts                   # Fetch diff (paginated PR files API), parse unified diff
  filter.ts                 # Path/size exclusion filtering + chunking
  summarize.ts              # Summary mode: generate, dedup-check, post comment
  review.ts                 # Review mode: generate findings, validate, post review
  prompt.ts                 # Prompt templates + system prompts
  llm/
    client.ts               # Provider dispatch, retries, timeout, backoff
    openai.ts               # /chat/completions adapter
    anthropic.ts            # /v1/messages adapter
    json.ts                 # Strict JSON extraction + Zod-free manual validation
  github/
    comments.ts             # List/find/post issue comments (marker-based dedup)
    reviews.ts              # Create PR review with inline comments
    threads.ts              # Fetch prior review-thread root comments (repeat guard)
  util/
    glob.ts, retry.ts, text.ts  # Glob matching, backoff, text-normalization helpers
test/                       # vitest specs (mirrors src/)
dist/index.js               # Bundled output (committed)
```

## Data flow

### Summary mode

```
pull_request(opened) ─> context ─> diff fetch ─> filter ─> prompt+LLM
  ─> markdown summary ─> marker check on issue comments
       ├─ marker found  ─> log "already summarized", outputs.summary_posted=false
       └─ not found     ─> POST issue comment with hidden marker ─> done
```

The hidden marker `<!-- ai-review:summary -->` is embedded at the top of the
comment body. Idempotency = "one comment containing the marker exists".

### Review mode

```
trigger (synchronize|/review|dispatch) ─> context ─> diff fetch ─> filter
  ─> fetch prior review-thread comments (pulls.listReviewComments, root only)
  ─> chunk ─> [prompt+LLM per chunk, prior comments listed] ─> merge findings
  ─> validate anchors against parsed hunks ─> drop invalid
  ─> drop findings that repeat a prior comment (same path + text overlap)
  ─> POST /pulls/{n}/reviews { commit_id, body, comments[] }
```

Inline comment payload per finding:

```json
{ "path": "src/foo.ts", "body": "…", "side": "RIGHT", "line": 42 }
```

Each run creates exactly one review object (state `COMMENT`), so repeated runs
appear as separate reviews - the natural "multiple times per PR" behavior.

### Diff source of truth

- File list + per-file `patch`: `GET /repos/{o}/{r}/pulls/{n}/files?per_page=100`
  (paginate).
- Line anchors: parse each `patch` (unified diff) ourselves. **Invariant**: any
  comment we post must have `(path, line)` where `line` exists on the RIGHT side
  of a hunk for `path`. Validation happens against our own parse, so the
  pipeline never posts a comment GitHub would reject with 422.

## Module contracts

- `fetchPrFiles(octokit, owner, repo, prNumber)` -> `PrFile[]`
  - Post: every element has `filename`, `status`, `additions`, `deletions`,
    and `patch` only when non-binary and within size cap (else `patch: null`).
- `parsePatch(patch)` -> `Hunk[]` with `{ newStart, newLines: Set<number> }`
  - Pre: patch is a valid unified diff body.
  - Post: union of `newLines` across hunks = exactly the set of valid RIGHT-side
    anchor lines for that file.
- `buildSummaryPrompt(files)` / `buildReviewPrompt(files)` -> messages
  - Post: total content ≤ `max_patch_chars`; includes file stats, patches, and
    the repository context block (visibility, description, default branch,
    primary language, fork/archived flags) fetched via `GET /repos/{o}/{r}`.
- `callLLM(config, messages)` -> `unknown` (parsed JSON)
  - Retries 429/5xx (backoff 2s/8s/32s). An empty completion (reasoning-model
    budget burn) retries once without `response_format`, then falls through to
    the re-ask path; on non-JSON response, re-asks once with a JSON nudge
    appended; throws `LLMError` after 2 parse failures.
- `validateFindings(findings, prFiles)` -> `ValidFinding[]`
  - Post: every returned finding has `path ∈ diff`, `line ∈ newLines(path)`,
    severity ∈ enum, non-empty comment. Invalid ones are logged and dropped.
    Near-duplicates (same path, line within 3) are merged keeping the highest
    severity (first-seen wins ties).
- `postReview(octokit, pr, commitId, findings)` -> review id
  - Posts body + inline comments in one API call.
- `findMarkerComment(octokit, owner, repo, prNumber, marker)` -> comment | null

## Configuration & security

- `api_key` always from secrets; never echoed (core.setSecret).
- LLM receives only: diff text, file paths, repo metadata (name, visibility,
  description, default branch, language, fork/archived), and (for summary) PR
  title/body. **Never** sends file contents beyond the diff hunks.
- `GITHUB_API_URL` respected by Octokit automatically (GHES passthrough).
- Workflow permissions: `pull-requests: write` + `contents: read`; summary mode
  also needs `issues: write` because it posts via the issue-comments API
  (`POST /repos/{o}/{r}/issues/{n}/comments`).

## Concurrency

Both modes use `concurrency: group: ai-review-${{ github.event.pull_request.number }}`
in the example workflows to avoid racing duplicate posts.

## Failure policy

Top-level try/catch in `index.ts`: on any error, `core.error` + set outputs to
`0`/`false`; exit code 1 only when `fail_on_error: true`.
