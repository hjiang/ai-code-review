# Plan 002 — Don't repeat previously reported review comments

## Problem

Review mode is re-triggerable (push, `/review` comment, workflow_dispatch).
Each run posts a fresh PR review with inline comments. Today there is no memory
of prior runs: if a thread was already reported — **resolved or not** — a later
run re-reports the same issue at the same location, spamming the PR.
`validateFindings` only dedups *within a single run*; it knows nothing about
the PR's earlier threads.

## Decision (confirmed with user)

- **Semantic matching over positional.** Do NOT use a path+line tolerance
  filter; use text/semantic similarity so repeats are caught even when the
  code moved and line numbers shifted.
- **Scope: every previously reported comment, resolved or not** (any author).
  One entry per review thread (its root comment) = one previously reported
  issue.
- Mechanism = **soft semantic layer (LLM prompt context) as the primary**
  mechanism, plus a conservative **text-overlap safety net** so "no comment
  should be repeated" actually holds even when the LLM disobeys.

## Design

### 1. New module `src/github/threads.ts`

- `interface PreviousComment { path: string; line: number | null; body: string }`
- `fetchPreviousComments(octokit, owner, repo, prNumber)` — paginated
  `pulls.listReviewComments` (per_page 100, page until a short page). For every
  thread (resolved or not) take its **root comment** — a review comment whose
  `in_reply_to_id` is null: `path`, `line ?? original_line ?? null`, trimmed
  `body`. Replies and entries without a path/body are skipped; missing fields
  tolerated.

### 2. `src/github/types.ts`

- Extend `MinimalOctokit.pulls` with `listReviewComments`.
- Add minimal `ReviewComment` structural type (`path`, `line`, `original_line`,
  `body`, `in_reply_to_id`).

### 3. `src/prompt.ts` — soft semantic layer (primary)

- `buildReviewMessages(files, maxChars, repo, previous?: PreviousComment[])`.
- When non-empty, append a compact
  `Previously reported issues (do NOT re-report these):` block in the user
  message: `- path:line — short body` per thread, capped (first ~30 entries,
  each body ~120 chars) so the block stays small.
- Add a rule to `REVIEW_SYSTEM`: if an issue matches something in the
  previously-reported block, skip it — unless the code has genuinely changed
  such that it is a new/different problem.

### 4. `src/review.ts` — text-overlap safety net (guarantee)

- `validateFindings(raw, prFiles, log, previous?: PreviousComment[])`.
- After existing anchor validation + intra-run dedup, drop a finding when the
  **same path** has a previous comment whose normalized text overlaps
  sufficiently (token containment on lowercase alphanumeric tokens, after
  stripping markdown/severity boilerplate and stopwords). Different path ⇒
  distinct instance ⇒ kept. Drop is logged
  (`review: skipping finding — repeats previously reported comment`).
- New constants `REPEAT_CONTAINMENT_THRESHOLD = 0.5`, `REPEAT_MIN_OVERLAP = 4`.
- `runReview` fetches previous comments once, passes them to both the prompt
  builder and the validator; counts/body reflect only post-filter findings.

### 5. `src/util/text.ts`

- `normalizeTokens(text): Set<string>` and `tokenContainment(a, b): number`
  helpers (strip emoji/severity headers + markdown links, lowercase, drop
  stopwords/1-char; keep ordinary parenthesized content).

### Config

- Behavior is always-on: every review run avoids repeating previously
  reported comments. No input toggles it.

## Files touched

- `src/github/threads.ts` (new), `src/github/types.ts`
- `src/review.ts`, `src/prompt.ts`, `src/util/text.ts`
- Tests: `test/github/threads.test.ts` (new), `test/review.test.ts`,
  `test/prompt.test.ts`, `test/util/text.test.ts` (new)
- Docs: `README.md`, `docs/REQUIREMENTS.md`, `docs/ARCHITECTURE.md`

## Test plan (TDD)

1. `fetchPreviousComments`: one entry per thread (root comment); includes both
   resolved and open threads; line falls back to `original_line`; skips
   comment-less threads; pagination; missing fields tolerated.
2. `validateFindings` with previous: near-identical text same path dropped;
   rephrased same issue dropped; identical text different path kept;
   different issue kept; below-threshold kept; drop logged.
3. `runReview`: previous comments passed into the LLM prompt; repeat finding
   not posted (createReview gets only new comments).
4. `prompt.test.ts`: resolved block present/absent; capped.
5. `util/text.test.ts`: normalization + containment helpers.

## Acceptance criteria

- A finding that repeats a previously reported comment (same file, overlapping
  wording) is never posted.
- Genuinely new findings — including the same bug pattern in a *different*
  file — are still posted.
- No behavior change when there are no
  previous threads.
- `npm run typecheck`, `npm test`, `npm run coverage` (thresholds held),
  `npm run build` (dist rebuilt & committed) all pass.
