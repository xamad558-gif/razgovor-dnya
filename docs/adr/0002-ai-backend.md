# ADR 0002: AI backend as one Supabase Edge Function

**Status:** Accepted (Oct 2026)

## Context
The conversation needs Claude. The app must never hold the provider key, cost must be bounded per user, and the
learner should not need to create an account to start.

## Decision
- One Edge Function `ai` handles three typed tasks (`chat`, `evaluate`, `topic`). Prompts are built server-side from
  validated inputs (`_shared/ai-contract.js`); the app cannot send free-form prompts.
- Users are Supabase **anonymous** users created on first AI use; Phase 3 links them to a real account.
- Per-user daily quota in Postgres (`consume_ai_quota`, atomic upsert, callable by `service_role` only).
- Responses use **structured outputs** (`output_config.format` JSON schema) and are validated again server-side and
  client-side.
- Model: **`claude-opus-5-5`** (Anthropic's current default), overridable with the `AI_MODEL` secret. Effort set
  explicitly per task (`low` for chat/topic, `medium` for evaluation). **Server-side refusal fallbacks are enabled**
  (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) on models that support them; Haiku 5.5 has none.
- Request log (`ai_requests`) stores ids, task, model, tokens, latency and status, never text.

## Cost (estimate, per chat message)
Assumes about 1,500 input and 500 output tokens (including low-effort thinking). List prices per million tokens:
Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50.

| Model | Per message | Daily conversation (~10 requests) | Worst case at quota 60/day |
|---|---|---|---|
| claude-opus-5-5 | ~$0.016 | ~$0.16 | ~$1.00 |
| claude-sonnet-5-5 | ~$0.008 | ~$0.08 | ~$0.50 |
| claude-haiku-5-5 | ~$0.0004 | ~$0.004 | ~$0.03 |

Real numbers come from `ai_requests` after the first week. Changing the model is a product decision (correction
quality for an A2 learner); compare on the same conversations before switching.

## Alternatives rejected
- **Calling Anthropic from the app:** exposes the key. Rejected (P0).
- **Generic proxy endpoint taking prompts:** abuse as a free LLM. Rejected.
- **Separate server (Node/Python on a VPS):** more to operate; no gain at this scale.

## Consequences
- The backend is ~150 lines plus a 60-line migration, all unit-tested; the HTTP handler is runtime-agnostic.
- Quota day is UTC (midnight UTC = 03:00 Moscow): acceptable for a cost guard, not shown to the learner as a calendar.
- A failed model call still consumes one quota unit (fails safe on cost).
