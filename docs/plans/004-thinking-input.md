# 004 — First-class `thinking` input (levels) + auto budget_tokens

Status: implemented, verified live on DeepSeek; Anthropic path covered by
tests only (no Anthropic key in this environment)
Date: 2026-09-24

## Goal

Users should not have to hand-write provider JSON to turn on thinking.
New input `thinking: auto | off | low | medium | high | max` (default `auto` =
today's behavior), mapped per provider, and Anthropic legacy `budget_tokens`
derived from `max_tokens` automatically.

## Verified provider facts (2026-09-24, live probes + vendor docs)

- DeepSeek (`api.deepseek.com`, probed): `reasoning_effort` accepts
  minimal/low/medium/high/max/xhigh, and effort alone (no `thinking` key)
  enables reasoning on both `deepseek-flash` and `deepseek-chat`. Effort
  measurably changes reasoning volume (one review-like prompt: 3.2k → 17.7k
  reasoning chars across levels; not monotonic at n=1). `thinking:
  {"type":"disabled"}` is accepted. Without any control, `deepseek-chat` does
  not reason; `deepseek-flash` is pinned on by this action's auto-default.
- Anthropic (docs): `thinking.enabled` + `budget_tokens` is deprecated on
  Claude 4.6 and **rejected (400) on 4.7+**; modern models use
  `thinking:{"type":"adaptive"}` plus top-level `output_config.effort`
  (low/medium/high/xhigh/max). Effort is unsupported on 4.5-and-earlier
  (except opus-4-5-20251101), which remain extended-thinking-only.
  `budget_tokens`: min 1024, strictly < `max_tokens`.
  Claude 4.7+/5.x reject any non-default temperature/top_p/top_k even without
  thinking — the action's always-sent `temperature: 0.2` means those models
  currently 400 on every request (bug found while researching this).
- OpenRouter-style gateways: unified `reasoning` parameter — documented via
  `extra_body`, not first-class (user decision).

## Design

- `thinking` levels: `auto` (default) | `off` | `low` | `medium` | `high` |
  `max`. Parsed/validated in `context.ts`; carried as `LLMConfig.thinking`
  (provider-specific request shaping lives in the adapters).
- OpenAI-compatible adapter (DeepSeek/OpenAI-style):
  - level → `{"reasoning_effort": "<level>"}` (effort alone enables reasoning
    on DeepSeek; standard on OpenAI reasoning models).
  - `off` → DeepSeek base URLs send `{"thinking":{"type":"disabled"}}`
    (officially correct control, probed accepted); other base URLs send
    nothing. `off` also suppresses the DeepSeek flash auto-default.
- Anthropic adapter:
  - level → modern shape `{"thinking":{"type":"adaptive"}}` +
    `{"output_config":{"effort":"<level>"}}`; on a thinking/effort-related 400
    (legacy models), fail over once to the extended shape
    `{"thinking":{"type":"enabled","budget_tokens":<auto>}}`.
  - auto budget from `max_tokens`: `low 15%`, `medium 30%`, `high 50%`,
    `max 70%`, clamped to `[1024, max_tokens - 1024]`; `loadConfig` rejects
    `thinking` + Anthropic + `max_tokens < 2048` up front with a clear error.
  - `off` → omit thinking/effort entirely (newest models reject
    `{"type":"disabled"}`).
- Temperature policy (user decision): `temperature` is optional in
  `LLMConfig`; Anthropic omits it unless the input is set explicitly (its
  default is thinking-compatible on every generation), OpenAI-compatible keeps
  today's `0.2` default.
- Precedence: `thinking`-derived keys are the base; user `extra_body` is
  merged last and wins (existing invariant). `extra_body` set alone still
  replaces the DeepSeek auto-default, as today.
- Rejected params still self-heal: the existing "drop extra_body once on 400"
  retry remains the last resort on both adapters.

## Verification plan

- Red-first tests: config parsing/validation + precedence; OpenAI mapping
  (level, off-on-DeepSeek, off-elsewhere, extra_body wins); Anthropic modern
  shape, legacy failover, auto-budget math + clamp, `max_tokens` precondition;
  temperature omission on both adapters.
- Live probe vs `api.deepseek.com`: `thinking: high` through `callLLM`
  actually streams `reasoning_content`; `off` streams none.
- Full suite + coverage + `dist/` rebuild; docs (action.yml, README,
  REQUIREMENTS, ARCHITECTURE) updated in the same change.
