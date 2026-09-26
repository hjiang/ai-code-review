# 003 — Configurable LLM request timeout + streaming (long thinking support)

Status: implemented, tested, PR pending
Date: 2026-09-23

## Goal

Let users run models with long reasoning ("thinking") without the action
aborting them. Previously the per-LLM-request deadline was hard-coded at
5 minutes (`TOTAL_TIMEOUT_MS` in `src/llm/client.ts`); any request whose
thinking ran longer was killed mid-flight by `AbortSignal.timeout`. The token
side was already user-controlled (`max_tokens` input + `extra_body` thinking
controls such as Anthropic `budget_tokens` or `reasoning_effort`), so wall
clock was the only missing knob.

## Design

- New action input `timeout` (seconds, default `300` = previous behavior,
  `0` valid = uncapped) → `ActionConfig.timeout` (`src/context.ts`, parsed by
  `strictIntInput` so "0.5"/"-0.5" cannot truncate to 0 = uncapped) →
  `LLMConfig.timeoutMs` (`src/index.ts`, ×1000) → the shared deadline in
  `src/llm/client.ts`.
- Contract: `timeoutMs` is the wall-clock budget for one logical LLM call —
  every HTTP attempt, the `response_format` compat retry, and the JSON re-ask.
  `timeoutMs: 0` (or non-finite) computes `deadline = Infinity`: no break on
  exhausted budget, backoff never clamped, and adapters receive remaining `0`,
  which means "send no `AbortSignal`" (`timeoutMs > 0 ? AbortSignal.timeout(
  min(ms, 2^31-1)) : undefined` in both `openai.ts` and `anthropic.ts`).
- Retry semantics unchanged: 3 attempts, 2s/8s backoff (the 32s table entry is
  unreachable at 3 attempts), 429/5xx/network retryable. Only the deadline
  source changed.
- The deadline is computed ONCE in `callLLM` and threaded into
  `requestWithRetry`, so every round of one logical call — HTTP attempts, the
  `response_format` compat retry, and the JSON re-ask — shares one budget:
  `timeout` bounds the whole call's wall clock (review finding: a per-round
  budget allowed up to 3x the configured cap). A hard-deadline abort is
  classified non-retryable and surfaces as the deadline error.

## Review round (branch review, 4 reviewers)

- SSE parser: approve. Added the multi-byte-UTF-8 split test and documented
  the iterator-abandonment caveat (latent; no consumer does it).
- Adapters: request-changes → fixed. Mid-stream `{"error": ...}` envelopes are
  now retryable failures (were silently discarded → misreported as empty
  completions); a non-SSE 200 (endpoint ignoring `stream: true`, or the
  documented `extra_body {"stream": false}` escape hatch) falls back to
  reading the plain JSON completion instead of misreporting an empty stream;
  Anthropic empty-completion logs now carry `stop_reason`/`thinking`;
  malformed `content_block_delta` lines are skipped.
- Timeout/config: fixed. The deadline is now computed once per `callLLM` (it
  was per retry round, allowing up to 3x the configured cap); hard-deadline
  aborts are non-retryable and surface as the deadline error instead of a
  generic `TimeoutError`; `timeout` is parsed strictly so "0.5"/"-0.5" cannot
  truncate to 0 (uncapped — the opposite of the intent).
- Docs: fixed. Deadline scope corrected across all touchpoints; Anthropic
  thinking guidance now names the `temperature: 1` requirement; the
  `extra_body` 400-retry is implemented for Anthropic too (the claim was
  OpenAI-only); backoff table corrected to 2s/8s; AGENTS.md bullet trimmed.

## Provider-side limit (verified) and resolution

The non-streaming first cut documented `timeout: 0` as "arbitrarily long
thinking" — an overclaim. Verified 2026-09-23 against
docs.claude.com/en/docs/api/errors#long-requests: Anthropic returns 504
`timeout_error` for long-running requests, recommends streaming "especially
those over 10 minutes", and its SDKs validate non-streaming requests against
a 10-minute cap; OpenAI-compatible gateways vary but commonly drop idle
non-streaming connections.

Resolution (user decision: stream both adapters): both LLM adapters now
request SSE (`stream: true`) and accumulate text deltas.

- `src/llm/sse.ts`: provider-agnostic SSE parser (`parseSSE`) with a built-in
  idle-stall guard — no bytes for `STREAM_IDLE_TIMEOUT_MS` (5 min) rejects
  with `StreamStalledError` (retryable). This is what makes `timeout: 0`
  safe: a healthy long-thinking stream keeps producing bytes, a dead one
  fails and retries instead of hanging until the job timeout.
- Hard total-deadline abort per attempt: `AbortSignal.timeout(
  Math.min(timeoutMs, 2**31 - 1))` when `timeoutMs > 0`; `timeoutMs <= 0`
  (or non-finite) sends no signal. The 2^31-1 clamp fixes a review finding:
  Node throws RangeError on Infinity/NaN and clamps ≥2^31 ms to a ~1 ms
  abort.
- OpenAI: `delta.content` accumulated; `delta.reasoning_content` tracked for
  empty-completion diagnostics but never emitted; `[DONE]` terminates.
- Anthropic: only `content_block_delta` with `delta.type=text_delta` is
  output; `thinking_delta` ignored; mid-stream `event: error` (e.g.
  overloaded) → retryable failure.
- Clean cutover: no non-streaming fallback; SSE support is core to both API
  families. Contract documented in action.yml / README / REQUIREMENTS (FR-P5)
  / ARCHITECTURE (`callLLM`).

## Alternatives considered

1. Stay non-streaming, document the ~10-min provider caps honestly —
   rejected by user: streaming delivers the actual ask (unbounded thinking)
   and idle-drop resilience.
2. Stream Anthropic only — rejected: OpenAI-compatible gateways have the
   same idle-drop failure mode; asymmetry complicates the contract.
3. Keep 5-min cap, document `extra_body` only — rejected: wall-clock cap was
   the binding constraint for long-thinking models.

## Verification (TDD)

1. Timeout input: 5 tests written first and observed failing (context parsing
   default 300 / 900 / 0 valid / -5 / 'soon'; client `timeoutMs: 0` no-signal
   on both adapters; custom budget shared across attempts), then implemented.
2. Streaming: `parseSSE` tests (12) written first — parsing, chunk
   reassembly, CRLF, comments, EOF flush, idle stall, timer reset; then the
   adapters in three reviewed slices, each with red-first evidence: anthropic
   13/13 red → green, openai 8/8, plus client guards (non-finite uncapped,
   uncapped attempt-cap, 2^31 clamp).
3. Final: `tsc --noEmit` clean; 245/245 tests across 20 files; coverage
   97.89% lines / 92.32% branches (thresholds 90/80); `npm run build`
   (committed `dist/`) + `test/dist-freshness.test.ts` green. Live smoke
   against api.deepseek.com re-run after the review round: real
   `text/event-stream` response, reasoning deltas never leaked, uncapped
   request carried no abort signal.
4. Docs updated in the same change: `action.yml`, `README.md` inputs table,
   `REQUIREMENTS.md` FR-P5, `ARCHITECTURE.md` (layout + `callLLM` contract),
   `AGENTS.md` conventions, adapter/client JSDoc.
5. Known limitation (review-flagged, deferred): a gateway that rejects
   `stream: true` with 400 hard-fails — there is no non-streaming fallback
   (clean-cutover decision). Follow-up candidate: mirror the
   `response_format`/`extra_body` compat-retry for `stream`.
