# ADR 0004: OpenRouter free models as the default conversation provider

**Status:** Accepted (14 Oct 2026). Supersedes ADR 0003 as the default; the GigaChat and Anthropic paths stay
available through `AI_PROVIDER`.

## Context
- **Anthropic** (ADR 0002): the owner cannot fund the API. The account has no credit, a Claude Pro subscription does
  not include API usage, and Russia is not a supported Anthropic region.
- **GigaChat** (ADR 0003): built and reviewed, but it cannot be used. developers.sber.ru now says the individual
  Freemium package applies only to existing clients from 1 Sep 2026; new clients are sent to paid usage on cloud.ru.
  The owner registered after that date.
- **OpenRouter:** the owner has registered at openrouter.ai. It offers free model variants (ids ending `:free`)
  through one OpenAI-compatible API, at no cost and without a card.

## Decision
- Add a third provider, `openrouter`, behind the existing provider interface (ADR 0003, D1). Make it the **default**:
  when `AI_PROVIDER` is unset or empty, the function uses OpenRouter, so setting `OPENROUTER_API_KEY` alone is enough.
  `AI_PROVIDER=gigachat|anthropic` still overrides it.
- Requests use plain `fetch` to `https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer <key>` and
  the default (Mozilla) trust store. No custom CA and no new dependency.
- Each request sends a model list in priority order. If the first model fails (downtime, rate limit, moderation,
  context), OpenRouter tries the next. Defaults:
  1. `google/gemma-4-31b-it:free`: dense 31B, "140+ languages", 13 providers, so the highest availability.
  2. `thinkingmachines/inkling:free`: 975B MoE, multilingual conversation, a single provider.
  3. `nvidia/nemotron-3-ultra-550b-a55b:free`: 550B MoE.

  The list is configurable with `OPENROUTER_MODELS` and `OPENROUTER_MODEL_<TASK>`, with no redeploy.
- JSON: send `response_format: {type: "json_object"}`. OpenRouter treats it as a soft preference that providers
  without support ignore. The prompts already say "Reply ONLY with JSON", and the backend parser and validators
  still run. **No repair call for OpenRouter.** Every request, including a failed one, counts toward the free daily
  cap, and free endpoints are slow (~30 tokens/s), so a second call would also break the app's 60 s timeout.
- Reasoning is kept small and hidden (`reasoning: {effort: "low", exclude: true}`, configurable).
- App attribution: send `HTTP-Referer` and `X-OpenRouter-Title`, plus `X-OpenRouter-App-Visibility: hidden`. The
  owner gets per-app analytics without a public listing.

## Capacity: the binding constraint
OpenRouter free models allow **20 requests per minute and 50 requests per day for the whole account** while lifetime
credit purchases are under 10. That limit covers all users and all keys, and failed requests count too. It resets at
00:00 UTC, the same moment as our per-user quota day.

| Item | Requests |
|---|---|
| One daily conversation (≈8 chat turns + 1 evaluate + 0–1 topic) | ≈ 10 |
| Whole app per day | 50, so ≈ 4–5 conversations |
| Recommended `AI_DAILY_LIMIT` per user | **20**: two conversations for the owner, with headroom for retries |

When the account-wide daily cap is hit, the backend returns `quota_exceeded`. The app already shows the Arabic
message «وصلت إلى حد الرسائل لهذا اليوم…». A per-minute or upstream 429 returns `unavailable` («الخدمة مزدحمة الآن…»).
Buying 10 credits once raises the cap to 1000 requests per day. That is the scale-up path if the owner can pay.

## Privacy
- OpenRouter itself does not store prompts or completions unless the account opts in. Logging is off by default;
  keep it off.
- Free endpoints are run by third-party providers, and **some of them log or train on prompts**. The account's
  privacy settings (openrouter.ai/settings/privacy) decide which endpoints are allowed. With the strictest settings,
  free models can fail with `404 "No endpoints found matching your data policy"`. The owner then has to allow model
  training for free endpoints. He decides with this in mind: the conversation text, his practice Russian, is sent to
  and may be kept by those providers.
- Learners must not type personal data into the chat. An in-app notice is a follow-up (requirement S10).
- Moderation errors include `metadata.flagged_input`, a 100-character excerpt of the learner's text. The backend never
  logs it (S7).

## Consequences
- Zero cost. Quality and availability vary because the free catalogue changes. The model list is a secret, so
  replacing a model needs no deploy. Re-check models monthly on openrouter.ai/models?max_price=0.
- Free endpoints are slower (~25–40 s for a full chat reply), so the per-call timeout is 50 s, inside the app's 60 s.
- This is not production capacity for many learners. Opening the app to other learners needs credits or another
  paid provider.

## Alternatives rejected
- **GigaChat paid via cloud.ru:** paid. The code stays available if the owner pays later.
- **Paid OpenRouter models:** the owner cannot fund them now. Switching later only takes a change to the model list
  plus credits.
- **The `openrouter/free` auto-router:** the model is not predictable, which makes quality hard to compare.
- **Calling OpenRouter from the app:** exposes the key (P0).

## Reversibility
Fully reversible with one secret (`AI_PROVIDER=gigachat|anthropic`). No data or schema change.
