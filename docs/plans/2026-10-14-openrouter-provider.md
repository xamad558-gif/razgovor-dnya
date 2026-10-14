# Plan: OpenRouter free models as the default conversation provider

- **Date:** 2026-10-14 · **Author:** cto (Claude Opus 5.5) · **Implementer:** implementer (Claude Sonnet 5)
- **Status:** APPROVED (ready for implementer)
- **Decision record:** [ADR 0004](../adr/0004-openrouter-provider.md) (written by cto). ADR 0003's status line is already amended.

## Goal
GigaChat Freemium is closed to new clients (since 2026-09-01), and Anthropic cannot be funded. The owner has an
OpenRouter account. This plan adds an `openrouter` provider that uses free `:free` models and makes it the default,
so the chat works once the owner sets one secret, `OPENROUTER_API_KEY`. The provider interface, handler, prompts,
validators, quota, `ai_requests` logging rules, CORS and auth stay unchanged. The `gigachat` and `anthropic`
providers keep working through `AI_PROVIDER`.

## Requirements touched
| ID | Change | Target status |
|---|---|---|
| A1 | Provider switch now has three values; default `openrouter` | `IMPLEMENTED_NEEDS_FIX → live run with owner's OpenRouter key` |
| R2, R3, R4 | Same behaviour on the new provider | stay `IMPLEMENTED_NEEDS_FIX → live run + quality eval (OpenRouter)` |
| S1 | `OPENROUTER_API_KEY` only in function secrets | `IMPLEMENTED_VERIFIED` (evidence added) |
| S4 | Recommended `AI_DAILY_LIMIT=20` (account-wide free cap 50/day) | unchanged status, evidence/text updated |
| S7 | Moderation `flagged_input` and provider raw errors never logged | `IMPLEMENTED_VERIFIED` (new tests) |
| S9 | Unchanged (CA only for GigaChat). OpenRouter uses default trust | text updated |
| **S10 (new)** | In-app notice that chat text goes to a third-party AI provider; don't type personal data | `MISSING` (follow-up, UI) |

## Verified facts (openrouter.ai docs, 2026-10-14, via WebFetch; the sandbox cannot reach the API)
| Fact | Source |
|---|---|
| `POST https://openrouter.ai/api/v1/chat/completions`, `Authorization: Bearer <key>`. OpenAI-style body: `model`, `models` (fallback array), `messages`, `temperature` [0,2], `max_tokens`, `response_format` (`{type:'json_object'}` or `{type:'json_schema', json_schema}`), `provider`, `reasoning` | API reference overview |
| The `models` array is in priority order. **Any** error (downtime, rate limit, moderation, context length) moves to the next model. The response `model` is the model that served. Examples send `model` = primary plus `models` | Model fallbacks guide |
| `response_format` is a soft preference unless `provider.require_parameters=true`. Providers without support ignore it | Provider selection guide |
| Normalised `finish_reason`: `stop`, `length`, `content_filter`, `tool_calls`, `error`. The provider's raw value is in `native_finish_reason`. Each choice may carry `error` | API reference overview |
| `usage.prompt_tokens`, `usage.completion_tokens`, `usage.cost?`. Reasoning tokens count inside `completion_tokens` **and against `max_tokens`** | Overview; reasoning-tokens guide |
| `reasoning: {effort: 'none'\|'minimal'\|'low'\|…, exclude?: boolean}`. Models marked `mandatory` reject `none`. `exclude` hides the trace but still reasons | Reasoning-tokens guide |
| Error body is `{error: {code, message, metadata?}}`. HTTP: 400 bad params, 401 bad or disabled key, 402 insufficient credits, 403 guardrail or **moderation** (`metadata.reasons[]`, `metadata.flagged_input` = **up to 100 chars of the user's text**, `provider_name`, `model_slug`), 408 timeout, 429 rate limited, 502 model down or invalid response, 503 no provider meets routing. 500/504/529 also exist. `metadata.error_type` is present (e.g. `rate_limit_exceeded`, `server`) | Errors & debugging |
| **Errors after processing starts arrive in an HTTP 200**: a body with top-level `error` and no `choices`, or `choices[0].error` with `finish_reason:'error'` (possibly with partial content) | Errors & debugging |
| Free tier: **20 RPM and 50 RPD account-wide** while lifetime credit purchases are under 10, and 1000 RPD at 10 or more credits. More keys or accounts do not raise it. **Failed requests count.** It resets at 00:00 UTC. A 429 for platform limits carries `X-RateLimit-Limit/Remaining/Reset` and maybe `Retry-After`. The daily message is `"Rate limit exceeded: free-models-per-day"` | Limits page; JanitorAI help article |
| Strict privacy settings can block free endpoints with `404 "No endpoints found matching your data policy"`. The fix is to allow model training for free endpoints in **openrouter.ai/settings/privacy**. OpenRouter's own prompt logging is opt-in and off by default | FAQ; data-collection guide; JanitorAI help |
| `HTTP-Referer` (app URL) plus `X-OpenRouter-Title` (`X-Title` also accepted) attribute usage. `X-OpenRouter-App-Visibility: hidden` keeps the app out of public rankings | App attribution |
| Free models available (openrouter.ai/collections/free-models, costgoat list updated 2026-10-12) include `google/gemma-4-31b-it:free` (dense 31B, "140+ languages", 13 providers), `thinkingmachines/inkling:free` (975B MoE, "multilingual conversational", 1 provider, ~30 tok/s), `nvidia/nemotron-3-ultra-550b-a55b:free` (550B MoE). The others are coding-oriented, tiny or specialised | Free-models collection; model pages |

## Decisions
| # | Decision | Choice | Reason |
|---|---|---|---|
| O1 | Default provider | **`DEFAULT_PROVIDER = 'openrouter'`**. `AI_PROVIDER` still overrides (`gigachat`, `anthropic`). No "pick whichever key exists" logic. | The owner wants it to just work with one secret, and an explicit rule is easier to diagnose. The runbook tells him to **delete or overwrite any old `AI_PROVIDER=gigachat` secret**. |
| O2 | Interface | New `createOpenRouterProvider(o)` in `_shared/providers.js`, returning the same `{ name, repairInvalidJson, modelFor, complete }` shape and throwing `ProviderError`. **`handler.js` is not changed.** | Reuses D1 from ADR 0003. The handler is already provider-neutral. |
| O3 | Transport | Plain `fetch` (injected), default trust. Constant `OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'`, with **no URL override**. In `index.ts` the OpenRouter provider gets the global `fetch`, never `gigachatFetch`. | The Минцифры CA stays scoped to GigaChat (S9). No new dependency (S8). |
| O4 | Headers | `Authorization: Bearer <key>`, `Content-Type: application/json`, `Accept: application/json`, `HTTP-Referer: https://xamad558-gif.github.io/razgovor-dnya/`, `X-OpenRouter-Title: Razgovor dnya`, `X-OpenRouter-App-Visibility: hidden`. **No user ids** (`user` field not sent). | The owner gets per-app analytics while the app stays out of public listings. Data minimisation. |
| O5 | Models | Default list for **all tasks**: `['google/gemma-4-31b-it:free', 'thinkingmachines/inkling:free', 'nvidia/nemotron-3-ultra-550b-a55b:free']`. Body: `model: list[0]`, `models: list`. `OPENROUTER_MODELS` (comma list) replaces the default for all tasks. `OPENROUTER_MODEL_CHAT` / `_EVALUATE` / `_TOPIC` (also a comma list) replace it for that task. Entries are trimmed. Ids not matching `/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i` are dropped with a log. The list is de-duplicated and **capped at 3** (the extra count is logged). If the list ends up empty, use the default. `modelFor(task)` returns `list[0]` (the requested primary); the log records the served model from the response. | Gemma is the primary because it has explicit wide multilingual coverage (Arabic and Russian are in Gemma's set), 13 providers (fewest 503s) and a dense model without mandatory reasoning, so it is quicker. Inkling is the strongest large general model, as a fallback. Nemotron Ultra is a second large fallback. Coding models (Laguna, North Mini Code), tiny ones (LFM 2.6B) and specialised ones (Mercury Decide, content-safety) are excluded. The catalogue changes often, so this is a secret, not code. The order may be swapped after the live A/B (step L5). |
| O6 | Generation settings | `OPENROUTER_TASK_SETTINGS` in `ai-contract.js`: chat `{temperature: 0.5, maxTokens: 3000}`, evaluate `{0.2, 3000}`, topic `{0.9, 1500}`. | Budgets include hidden reasoning tokens, which count against `max_tokens`. |
| O7 | Reasoning | `reasoning: {effort, exclude: true}` with `effort` from `OPENROUTER_REASONING` ∈ {`none`, `minimal`, `low`, `medium`}, default **`low`**. An invalid value means `low` (logged once at boot). For `none`, send `{effort: 'none'}` without `exclude`. | `low` is accepted by models with mandatory reasoning and keeps latency down. The trace is hidden. `none` is the owner's switch for speed if the A/B shows no quality loss. |
| O8 | JSON strategy | Always send `response_format: {type: 'json_object'}`. No `json_schema` and no `require_parameters` (a hard requirement could leave no free provider, which is a 404). Parsing and validators are unchanged. **`repairInvalidJson: false` for OpenRouter.** | Each request uses about 2% of the daily account cap, failures count too, and a second call (25–40 s each on free endpoints) would break the app's 60 s timeout. The learner already gets the «أعد المحاولة» retry button for `invalid_response`. |
| O9 | Timeout and retries | One call, `AbortSignal.timeout(50_000)`. **No client-side retries**: OpenRouter already falls back across models and providers, and retries waste the daily cap. | Fits inside the app's 60 s (`requestAI`), with ~10 s for auth, quota and cold start. |
| O10 | finish_reason | `stop`, `tool_calls` or missing → `end`. `length` → `max_tokens`. `content_filter` → `refusal`. `error` (or `choices[0].error` present) → throw per O11 using `choices[0].error.code` (no code → `server`, logStatus `provider_error_choice`). | Maps onto the existing handler branches (`refused`, `truncated`). |
| O11 | Error mapping | One function `classifyOpenRouterError(httpStatus, errObj, headers, nowMs)`, used for non-2xx responses **and** for 200 bodies with a top-level `error` (status = `error.code`) or `choices[0].error`. Mapping table below. | Errors can arrive inside a 200, and both paths must behave the same. |
| O12 | Daily-cap detection (429) | **Daily** when `error.message` matches `/per-day/i`, **or** when `X-RateLimit-Remaining === '0'` and `X-RateLimit-Reset` is more than 120 s ahead (a Reset value below 1e12 is treated as seconds). Daily → `quota_exceeded` (logStatus `provider_quota_day`). Any other 429 → `unavailable` (logStatus `provider_error_429`). | `quota_exceeded` already shows «وصلت إلى حد الرسائل لهذا اليوم…» with no retry button, which matches "come back tomorrow". A per-minute or upstream 429 shows «الخدمة مزدحمة الآن…». **No app change.** |
| O13 | Logging | On every OpenRouter failure, one line: `{level:'error', msg:'openrouter error', status, request_id, error_code, error_type: metadata.error_type, provider_name: metadata.provider_name, model_slug: metadata.model_slug, reasons: metadata.reasons (array of strings, each ≤60 chars, max 5), upstream_message}`. `upstream_message` is `error.message` sliced to 300 chars, **except on 403 moderation, where it is omitted**. **Never log** `metadata.flagged_input`, `metadata.raw`, any other metadata field, request or response bodies, model text, or the key. Non-JSON error bodies are logged as `non-json body (<n> chars)` (same rule as GigaChat). Network failures log `{phase:'chat', error_name, error_message ≤300}`. Success adds nothing beyond the handler's `ai_requests` row (model = served model slug, tokens). | `flagged_input` is learner text (S7). `reasons` and `error_type` are enough for diagnosis. |
| O14 | `classifyFetchError` reuse | Give the existing helper a `label` parameter (`'gigachat error'` or `'openrouter error'`). GigaChat behaviour is unchanged. | Small, shared and tested. |
| O15 | Daily limit | Recommend **`AI_DAILY_LIMIT=20`** in `.env.example` and the runbook. The code default stays 60. | The free cap is 50/day for the whole account. 20 covers two conversations for the owner and leaves room for other testers and retries. |
| O16 | Privacy toggles | Runbook order: (1) keep OpenRouter **prompt logging off** (default) and **leave the default privacy settings**. (2) Run the smoke test. (3) Only if logs show `provider_data_policy`, open openrouter.ai/settings/privacy and **turn on the setting that allows free endpoints / model training on inputs**. (4) Leave **any "publish prompts" style setting off** unless a chosen model cannot work without it; then pick a different model rather than enabling it. | Least exposure first, with a clear signal. The owner knowingly accepts training on practice-chat text. Public prompt publishing is not acceptable. |
| O17 | 404 data policy | A 404 whose message matches `/data policy/i` → `server` with logStatus **`provider_data_policy`**. Any other 404 → `server`, `provider_error_404` (unknown model id). | The owner can tell "privacy setting" apart from "bad model id" in the logs. |

### O11 mapping table (OpenRouter)
| Condition | `ProviderError.code` | `logStatus` |
|---|---|---|
| 400 | `server` | `provider_error_400` |
| 401 | `server` | `provider_error_401` (bad or disabled key) |
| 402 | `billing` | `provider_billing` |
| 403 with `metadata.reasons` (array) or message `/moderat\|flagged/i` | `refused` | `provider_moderation` |
| 403 other | `server` | `provider_error_403` |
| 404 + `/data policy/i` | `server` | `provider_data_policy` |
| 404 other | `server` | `provider_error_404` |
| 408 | `timeout` | `provider_error_408` |
| 429 daily (O12) | `quota_exceeded` | `provider_quota_day` |
| 429 other | `unavailable` | `provider_error_429` |
| 502, 503, 529 | `unavailable` | `provider_error_<s>` |
| 500, 504, other 5xx | `server` | `provider_error_<s>` |
| any other / missing code | `server` | `provider_error_<s or 'unknown'>` |
| fetch `TimeoutError` / `AbortError` | `timeout` | `provider_error_timeout` |
| fetch other rejection (`TypeError`) | `server` | `provider_error_network` |
| 200 with unparseable JSON body | `invalid_response` | `provider_bad_body` |

The handler maps `quota_exceeded` to HTTP 429 `{code:'quota_exceeded', retryable:false}`, which the app already
understands. The handler's `quota_exceeded` message text is generic, so it is fine.

## Files
| File | Change |
|---|---|
| `supabase/functions/_shared/ai-contract.js` | `PROVIDERS` += `'openrouter'`. `DEFAULT_PROVIDER = 'openrouter'`. Add `OPENROUTER_DEFAULT_MODELS`, `OPENROUTER_TASK_SETTINGS`, `OPENROUTER_REASONING_EFFORTS`, `buildOpenRouterRequest`. Nothing else changes. |
| `supabase/functions/_shared/providers.js` | Add `OPENROUTER_URL`, `OPENROUTER_TIMEOUT_MS`, `OPENROUTER_HEADERS_STATIC`, `resolveOpenRouterModels`, `classifyOpenRouterError`, `normalizeOpenRouter`, `createOpenRouterProvider`. Add the `label` param to `classifyFetchError`. Add an `openrouter` branch in `createProviderFromEnv` and update its JSDoc. |
| `supabase/functions/ai/index.ts` | Header comment (secrets list incl. OpenRouter; default openrouter). Pass `openrouterFetch: fetch`. Boot log: models per task (primary) and `reasoning`. |
| `supabase/functions/.env.example` | OpenRouter first (`OPENROUTER_API_KEY`, optional models, reasoning), `AI_DAILY_LIMIT=20`. GigaChat and Anthropic as commented alternatives. |
| `tests/openrouter.test.js` | **new** (list below) |
| `tests/gigachat.test.js` | Update only the provider-selection test: unset `AI_PROVIDER` now defaults to openrouter. GigaChat cases use `AI_PROVIDER: 'gigachat'` explicitly. |
| `docs/deploy-backend.md` | OpenRouter becomes the default setup section; secrets table; privacy steps (O16); statuses; daily-cap note; GigaChat/Anthropic as alternatives |
| `docs/requirements.md` | A1, R2–R4, S1, S4, S7, S9 evidence; new S10 row |
| `README.md` | Backend paragraph (free OpenRouter key), status, real test count |
| `.claude/agents/implementer.md` | Replace the lint command with the explicit file list (below). **Ask the owner before editing this file**; if not approved, list it under "Found, not fixed". |

Not touched: `handler.js`, `src/**`, migrations, `deno.json`/`deno.lock`, `package*.json`, `russian-trusted-ca.js`,
ADR 0004 and ADR 0003 (already written by cto), `CLAUDE.md`.

## Steps
1. **Contract** (`ai-contract.js`). Append the following; existing exports stay byte-identical except `PROVIDERS` and
   `DEFAULT_PROVIDER`:
   ```js
   export const OPENROUTER_DEFAULT_MODELS = ['google/gemma-4-31b-it:free', 'thinkingmachines/inkling:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'];
   export const OPENROUTER_TASK_SETTINGS = {
     chat: { temperature: 0.5, maxTokens: 3000 },
     evaluate: { temperature: 0.2, maxTokens: 3000 },
     topic: { temperature: 0.9, maxTokens: 1500 },
   };
   export const OPENROUTER_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium'];
   /** OpenRouter /chat/completions body. models: non-empty array, primary first. */
   export function buildOpenRouterRequest(req, models, { reasoning = 'low' } = {}) {
     // p = buildPrompt(req); s = OPENROUTER_TASK_SETTINGS[req.task]
     // return { model: models[0], models, messages: [{role:'system', content:p.system}, ...p.messages],
     //   temperature: s.temperature, max_tokens: s.maxTokens, response_format: { type: 'json_object' },
     //   reasoning: reasoning === 'none' ? { effort: 'none' } : { effort: reasoning, exclude: true }, stream: false }
   }
   ```
   Verify: `npm test` still passes (the existing GigaChat default test will now fail until step 4; that is expected).
2. **Provider** (`providers.js`):
   - `resolveOpenRouterModels(env, log)` returns `{chat: string[], evaluate: string[], topic: string[]}` per O5. Comma
     lists are parsed by a helper `parseModelList(raw, log)`.
   - `classifyOpenRouterError(status, err, headers, nowMs)` returns a `ProviderError` per the O11 table and O12.
     `headers` is a `Headers`-like object with `.get()` or null.
   - `normalizeOpenRouter(json, requestedModel)` → `{ model, stop, text, inputTokens, outputTokens }` per O10.
     `text` = `choices[0].message.content` if it is a string. If it is an array of parts, join the `text` of parts
     with `type === 'text'`. Otherwise `''`. `model` = `json.model` (string) or `requestedModel`. Tokens come from
     `usage.prompt_tokens` and `usage.completion_tokens`, numbers only, else null. It must **not** be called on bodies
     with top-level `error` or `choices[0].error` / `finish_reason:'error'`; `complete` checks those first and throws.
   - `createOpenRouterProvider({ apiKey, models, reasoning, fetch, now, log })` →
     `{ name:'openrouter', repairInvalidJson:false, modelFor: (t) => models[t][0], async complete(req, { requestId } = {}) }`.
     `complete`:
     1. Build the body.
     2. POST with the O4 headers and `signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS)` (50 000).
     3. A fetch rejection goes to `classifyFetchError(e, 'chat', log, 'openrouter error')`.
     4. Non-OK: read the text, try `JSON.parse(text).error`, log per O13, throw `classifyOpenRouterError`.
     5. OK: parse the JSON (failure → `provider_bad_body`). If `json.error` → log + throw with status
        `Number(json.error.code) || 0`. If `choices[0].error` or `finish_reason === 'error'` → log + throw per O10.
     6. Otherwise return `normalizeOpenRouter(json, models[req.task][0])`.
     The key is trimmed. A leading `Bearer ` (any case) is stripped before use.
   - The O13 log builder must take only the whitelisted fields, so a test can prove that `flagged_input` and
     `metadata.raw` never appear.
   - `createProviderFromEnv`: add `openrouter` (needs `OPENROUTER_API_KEY`, otherwise not-configured with
     `missing:'OPENROUTER_API_KEY'`). `deps.openrouterFetch` is required for it. `OPENROUTER_REASONING` is parsed
     case-insensitively; an invalid value logs once and falls back to `low`. Update the JSDoc (`AI_PROVIDER`
     unset → `openrouter`).
3. **`index.ts`**:
   - Update the header comment.
   - Pass `openrouterFetch: (url: string, init: RequestInit) => fetch(url, init)` to `createProviderFromEnv`.
   - Boot log gets `reasoning` when the provider is openrouter (the exported value from the provider object; add a
     read-only `reasoning` property on the openrouter provider for this).
   - The GigaChat CA client stays as is.
4. **Tests**: write `tests/openrouter.test.js` and update the selection test in `tests/gigachat.test.js` (list below).
5. **`.env.example`** per the Files table.
6. **Docs**:
   - **`docs/deploy-backend.md`**: new default section "3. Get a free OpenRouter key (~5 min)". Plain steps:
     1. Sign in at openrouter.ai.
     2. Go to **openrouter.ai/keys** → **Create key**. Name it `razgovor-dnya`. Optional: credit limit 0. Copy the
        key (`sk-or-…`); it is shown once.
     3. Supabase Dashboard → project `razgovor-dnya` → **Edge Functions → Secrets**:
        - Add `OPENROUTER_API_KEY`.
        - Set `AI_DAILY_LIMIT` = `20`.
        - **If an `AI_PROVIDER` secret exists, delete it or set it to `openrouter`.**
     4. Privacy steps per O16, with the exact error text `No endpoints found matching your data policy` and the
        settings URL.
     5. Never put the key in the app's `.env`, in a `VITE_*` variable, or in chat.

     Also: a secrets table (all OpenRouter variables plus the existing ones); a status list with the O11 statuses;
     an "Operating it" section (daily cap 50 for the whole account, reset 03:00 Moscow; how to check usage at
     openrouter.ai/activity; replacing a dead free model = edit `OPENROUTER_MODELS`; key compromised = delete the key
     at openrouter.ai/keys and create a new one); rollback (`AI_PROVIDER=gigachat|anthropic`, or redeploy previous
     commit `fb4c50d`). Move the GigaChat and Anthropic setup under "Alternative providers".
   - **`docs/requirements.md`**: per "Requirements touched", incl. new S10 row:
     `| S10 | Learner told that chat text goes to a third-party AI provider; no personal data | CTO (ADR 0004) | — | — | MISSING (follow-up, UI) |`.
   - **`README.md`**: "Deploy once with `docs/deploy-backend.md` (Supabase + a free OpenRouter key, ~15 min; GigaChat
     and Anthropic also supported)". Status: "Conversation: backend on OpenRouter free models, N tests".
7. Run every check under "Must pass" and append the Implementation report.

## Tests to add (`tests/openrouter.test.js`)
Use a fake fetch that records `(url, init)` and returns
`new Response(JSON.stringify(body), { status, headers })`. Use `topic`/`chatReq` like `gigachat.test.js`.
1. **Body**: `buildOpenRouterRequest(chatReq, list)`:
   - `model === list[0]`, `models` deep-equals `list`.
   - `messages[0]` is the single system message, and the roles after it alternate and end with `user`.
   - temperature and max_tokens come from the settings; `response_format` is `{type:'json_object'}`;
     `reasoning` is `{effort:'low', exclude:true}`; `stream === false`.
   - With `reasoning:'none'`, `reasoning` is `{effort:'none'}`.
   - Evaluate and topic use their own settings.
2. **Headers**:
   - URL is `OPENROUTER_URL`, method POST.
   - `Authorization` is `Bearer sk-or-x`; a key given as `'  Bearer sk-or-x '` is sent as `Bearer sk-or-x`.
   - `HTTP-Referer` is `https://xamad558-gif.github.io/razgovor-dnya/`; `X-OpenRouter-Title` and
     `X-OpenRouter-App-Visibility: hidden` are set.
   - No `user` field in the body.
3. **Model list resolution**:
   - Default.
   - `OPENROUTER_MODELS='a/b:free, c/d:free'` gives `['a/b:free','c/d:free']` for all tasks.
   - `OPENROUTER_MODEL_EVALUATE='x/y:free'` overrides evaluate only.
   - Invalid ids (`'bad id'`, `'nomodel'`) are dropped and logged; duplicates are removed; a 5-item list is capped
     at 3 and logged.
   - All-invalid falls back to the default.
   - `modelFor('chat')` is the primary.
4. **Success**: 200 with `model:'thinkingmachines/inkling:free'` (fallback served), `finish_reason:'stop'`, content
   JSON and usage `{prompt_tokens: 900, completion_tokens: 400}` gives `{stop:'end', model:'thinkingmachines/inkling:free', inputTokens:900, outputTokens:400}`.
   Content given as an array of text parts also works.
5. **finish_reason**: `length` → `max_tokens`; `content_filter` → `refusal`; `tool_calls` → `end`.
6. **401** → `server`, logStatus `provider_error_401`, one log line with `status:401` and `upstream_message`.
7. **402** → `billing` / `provider_billing`.
8. **403 moderation** (`error.metadata = {reasons:['harassment'], flagged_input:'Меня зовут Хамад …', provider_name:'X', model_slug:'m'}`)
   → `refused` / `provider_moderation`. The log contains `reasons` but **no** `flagged_input`, no `Хамад`, and no
   `upstream_message`. 403 without reasons → `server`.
9. **404 data policy** (`message:'No endpoints found matching your data policy'`) → `provider_data_policy`. Other 404
   → `provider_error_404`.
10. **408** → `timeout`.
11. **429 daily**:
    - message `'Rate limit exceeded: free-models-per-day'` → `quota_exceeded` / `provider_quota_day`.
    - `X-RateLimit-Remaining: 0` with Reset now + 3 h (ms) → `quota_exceeded`.
    - Reset given in seconds is handled.
    - **429 per-minute** (message `free-models-per-min`, Remaining 0, Reset now + 30 s) → `unavailable` /
      `provider_error_429`.
12. **502 / 503** → `unavailable`; **500** → `server`; exactly 1 fetch call (no retries) in every error case.
13. **Error inside 200**:
    - Body `{error:{code:502, message:'Provider returned error'}}` → `unavailable`.
    - Body `{error:{code:429, message:'… per-day'}}` → `quota_exceeded`.
    - Choices `[{finish_reason:'error', error:{code:500, message:'x'}, message:{content:'{"rep'}}]` → `server`.
    - Choice error without a code → `server` / `provider_error_choice`.
    - Unparseable 200 body → `invalid_response` / `provider_bad_body`.
14. **Network** (`TypeError('fetch failed')`) → `server` / `provider_error_network`, log `msg:'openrouter error'`.
    **TimeoutError** → `timeout`.
15. **No leaks**: run 400, 403-moderation and network failures with learner text `'Меня зовут Хамад'`, key
    `'sk-or-SECRET'` and an error metadata `raw: 'echo Хамад'`. `JSON.stringify` of all log calls and of each thrown
    error contains none of `Хамад`, `sk-or-SECRET` or `echo`.
16. **Selection** (`createProviderFromEnv`):
    - Unset `AI_PROVIDER` + `OPENROUTER_API_KEY` → `name:'openrouter'`.
    - Unset `AI_PROVIDER` without the key → not configured (`missing:'OPENROUTER_API_KEY'`), even when
      `GIGACHAT_AUTH_KEY` is set.
    - `AI_PROVIDER=gigachat` / `anthropic` still select those.
    - `OPENROUTER_REASONING='NONE'` gives a body with `{effort:'none'}`; `'turbo'` falls back to `low` and logs once.
    - The openrouter provider has `repairInvalidJson === false`.
17. **Through the handler** (in `tests/openrouter.test.js` using `createHandler` with the OpenRouter provider + fake
    fetch):
    - (a) Invalid JSON from the model → 502 `invalid_response`, status `invalid_output`, **exactly 1 fetch** (no
      repair).
    - (b) Daily 429 → HTTP 429 `{code:'quota_exceeded', retryable:false}` and status `provider_quota_day`.
    - (c) `content_filter` → 422 `refused`.
    - (d) Success → `ai_requests` entry has the served model and tokens, and no learner text.

Update in `tests/gigachat.test.js`: the "defaults to gigachat" case becomes "AI_PROVIDER=gigachat selects gigachat";
the unset case moves to test 16. No other GigaChat assertion changes.

## Must pass
- [ ] `npm test`: all tests, 0 failures. Report the exact count (it was 102 before).
- [ ] `npm run build`
- [ ] `cd supabase/functions/ai && /home/claude/probe/node_modules/deno/deno check --config deno.json index.ts`
- [ ] `cd supabase/functions/ai && /home/claude/probe/node_modules/deno/deno lint --config deno.json index.ts ../_shared/ai-contract.js ../_shared/handler.js ../_shared/providers.js ../_shared/russian-trusted-ca.js`
      (the explicit list: `lint ..` only checks 1 file). Must report "Checked 5 files", exit 0.
- [ ] `git diff --stat -- package.json package-lock.json supabase/functions/ai/deno.json supabase/functions/ai/deno.lock src supabase/migrations supabase/functions/_shared/handler.js supabase/functions/_shared/russian-trusted-ca.js` is **empty**
- [ ] `grep -rn "OPENROUTER\|sk-or" src/` has no hits
- [ ] `grep -n "flagged_input" supabase/functions/_shared/providers.js` appears only in a comment saying it is never logged (or not at all)

## Out of scope
- App UI (the S10 notice is a follow-up plan); `src/**` is unchanged because existing codes cover every case.
- Paid models or credits, streaming, tool calls, the `openrouter/free` auto-router, `json_schema` mode.
- Removing GigaChat or Anthropic code.
- Deploying (main session, after review).

## Risks / rollback
| Risk | Likelihood | Mitigation |
|---|---|---|
| A default free model is removed or renamed | High over months | `OPENROUTER_MODELS` secret, no deploy. 3-model fallback chain. Monthly re-check. |
| Fallback attempts each count against 50 RPD (undocumented) | Medium | Watch `openrouter.ai/activity` against `ai_requests` counts on day 1. If attempts are counted, reduce the list to 2 models. |
| Free endpoint latency > 50 s → timeout | Medium | `OPENROUTER_REASONING=none`, or move Gemma (fastest) first. The error is `timeout`, and the learner can retry. |
| JSON quality (prose, missing `words`) without repair | Medium | `json_object` + tolerant parser. Measure the `invalid_output` rate. If over 10%, revisit O8 (repair only when elapsed < 20 s). |
| Privacy: free providers train on chat text | Certain once the toggle is on | ADR 0004 notice; owner consent; S10 follow-up; no personal data. |
| Account cap 50/day shared by every user | Certain | `AI_DAILY_LIMIT=20`; `quota_exceeded` message; 10 credits raise it to 1000/day. |
| Owner's old `AI_PROVIDER=gigachat` secret overrides the new default | Medium | Runbook step 3 + boot log `provider`. |

**Rollback:** set the `AI_PROVIDER` secret to `gigachat` or `anthropic` (needs their keys), or redeploy commit
`fb4c50d`. No data change.

## Deployment bundle for edge function `ai`
Paths are relative to `supabase/functions/`. Entrypoint is `ai/index.ts`; `import_map_path: "deno.json"` (=
`ai/deno.json`).
- `ai/index.ts`, `ai/deno.json`
- `_shared/ai-contract.js`, `_shared/handler.js`, `_shared/providers.js`, `_shared/russian-trusted-ca.js`

(Same six files as before; no new file. `index.ts` still imports the CA module for the GigaChat path.)

## Live verification (after review, owner's key)
- L1: Owner creates the key, sets `OPENROUTER_API_KEY` and `AI_DAILY_LIMIT=20`, and removes `AI_PROVIDER` (or sets it
  to `openrouter`). Then deploy.
- L2: Boot log shows `provider:'openrouter'`, the models, and `reasoning:'low'`.
- L3: App → Chat → «ابدأ المحادثة». Expect `ai_requests.status='ok'` with the served model slug and tokens. Map
  failures with the log `status`:
  - `provider_error_401`: wrong key.
  - `provider_data_policy`: apply the O16 toggle.
  - `provider_error_404`: model id gone; edit `OPENROUTER_MODELS`.
  - `timeout`: try `OPENROUTER_REASONING=none`.
- L4: Compare the request count at openrouter.ai/activity with `ai_requests` rows for the day (fallback counting
  risk).
- L5: Quality A/B, ≤ 20 requests/day budget: 2 conversations (weather; a religion/philosophy topic) with the default
  order, and 2 with `OPENROUTER_MODELS` starting with Inkling. Record:
  - `ok` / `invalid_output` / `refused` counts
  - share of chat replies with ≥ 1 word (target ≥ 80%)
  - corrections the owner judges right
  - median latency

  Keep the better order and add the result to ADR 0004.

---

## Implementation report

DONE: Steps 1–7, all complete.
1. Contract: added `OPENROUTER_DEFAULT_MODELS`, `OPENROUTER_TASK_SETTINGS`, `OPENROUTER_REASONING_EFFORTS`,
   `buildOpenRouterRequest` to `ai-contract.js`; `PROVIDERS` += `'openrouter'`; `DEFAULT_PROVIDER = 'openrouter'`.
2. Provider: added `OPENROUTER_URL`, `OPENROUTER_TIMEOUT_MS`, `OPENROUTER_HEADERS_STATIC`,
   `resolveOpenRouterModels`, `classifyOpenRouterError`, `normalizeOpenRouter`, `createOpenRouterProvider` to
   `providers.js`; added the `label` param to `classifyFetchError`; added the `openrouter` branch (checked first)
   in `createProviderFromEnv` and updated its JSDoc.
3. `index.ts`: updated the header comment (secrets list incl. OpenRouter; default `openrouter`); pass
   `openrouterFetch: (url, init) => fetch(url, init)` (plain fetch, never the GigaChat CA client) to
   `createProviderFromEnv`; boot log now includes `reasoning` when `provider.name === 'openrouter'`, read off a
   read-only `reasoning` property added to the openrouter provider object.
4. Tests: added `tests/openrouter.test.js` (30 tests, items 1–17 of the plan's list, consolidated into fewer `it`
   blocks where several assertions shared one harness run). Updated `tests/gigachat.test.js`: the "defaults to
   gigachat" case is now "AI_PROVIDER=gigachat selects gigachat" (with `AI_PROVIDER: 'gigachat'` set explicitly),
   and the GigaChat-without-a-key and GIGACHAT_STRUCTURED cases also now set `AI_PROVIDER: 'gigachat'` explicitly
   (needed because the default provider changed to `openrouter`, which the plan's step 16 unset-provider case
   covers in the new file). No other GigaChat assertion changed.
5. `.env.example`: OpenRouter first (`AI_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, optional model/reasoning
   overrides), `AI_DAILY_LIMIT=20`; GigaChat and Anthropic as commented "Alternative provider" blocks.
6. Docs: rewrote `docs/deploy-backend.md` (OpenRouter default setup section, secrets table, O16 privacy steps,
   O11 status list, operating/rollback notes, GigaChat and Anthropic moved under "Alternative providers");
   updated `docs/requirements.md` (A1, R2–R4, S1, S4, S7, S8, S9 evidence/text; added the S10 row verbatim as
   specified); updated `README.md` (backend paragraph, test count 102→132, status line).
7. Ran every "Must pass" check (below) and filled this report.

FILES CHANGED:
- /home/claude/razgovor-dnya/supabase/functions/_shared/ai-contract.js
- /home/claude/razgovor-dnya/supabase/functions/_shared/providers.js
- /home/claude/razgovor-dnya/supabase/functions/ai/index.ts
- /home/claude/razgovor-dnya/supabase/functions/.env.example
- /home/claude/razgovor-dnya/tests/openrouter.test.js (new)
- /home/claude/razgovor-dnya/tests/gigachat.test.js
- /home/claude/razgovor-dnya/docs/deploy-backend.md
- /home/claude/razgovor-dnya/docs/requirements.md
- /home/claude/razgovor-dnya/README.md

RAN / PASSED:
- `npm test` — PASSED. 132 tests, 0 failures (6 test files; was 102 before, +30 new OpenRouter tests).
- `npm run build` — PASSED. `dist/` built in ~0.3–1.2s, no errors.
- `cd supabase/functions/ai && deno check --config deno.json index.ts` — PASSED (`Check index.ts`, exit 0).
- `cd supabase/functions/ai && deno lint --config deno.json index.ts ../_shared/ai-contract.js ../_shared/handler.js ../_shared/providers.js ../_shared/russian-trusted-ca.js` — PASSED (`Checked 5 files`, exit 0).
- `git diff --stat -- package.json package-lock.json supabase/functions/ai/deno.json supabase/functions/ai/deno.lock src supabase/migrations supabase/functions/_shared/handler.js supabase/functions/_shared/russian-trusted-ca.js` — PASSED (empty).
- `grep -rn "OPENROUTER\|sk-or" src/` — PASSED (no hits).
- `grep -n "flagged_input" supabase/functions/_shared/providers.js` — PASSED (one hit, the comment on the whitelist
  log-entry builder stating it is never logged; no runtime code path touches it).

NOT RUN: `npx cap sync android` (no app/plugin code changed — `src/**` untouched, as the plan requires); deploying
(explicitly out of scope and the task forbade it); the "Live verification" section (L1–L5, needs the owner's real
OpenRouter key, which the sandbox cannot reach anyway).

DEVIATIONS:
- `.claude/agents/implementer.md`'s lint-command fix was skipped per the task's explicit instruction, and the task
  told me to use the explicit file list myself instead of asking the owner. Listed under "Found, not fixed" since
  I did not get the owner's approval to edit that file.
- The plan's test list (items 1–17) describes ~50+ individual assertions; I grouped several into single `it` blocks
  per harness run (e.g. one `it` covers all four 429-daily/per-minute variants) to keep the harness overhead low,
  the same style `gigachat.test.js` already uses. Every assertion in the plan's list is present; none were dropped
  or weakened.
- `docs/requirements.md`: besides the listed rows, I also touched S1, S4, S8 and S9's "Implementation"/"Evidence"
  text (not just status) to mention OpenRouter, since the plan's "Requirements touched" table said their text
  should be updated even where status does not change (S4, S9) or evidence should be added (S1). S8's text was
  touched to say OpenRouter also uses plain `fetch` (no new dependency), matching the existing S8 wording pattern.

FOUND, NOT FIXED:
- `.claude/agents/implementer.md`'s "Checks" section still says `deno lint --config deno.json ..`, which only
  checks 1 file (a stale command this plan's "Must pass" section explicitly worked around with an explicit file
  list). Fixing it needs the owner's approval before editing an agent definition file.
- `.claude/skills/` (referenced by `CLAUDE.md` and by `implementer.md`'s "Before writing code" step 2) does not
  exist in this repository; there was nothing to read for `supabase`/`claude-api` guidance before this change.

QUESTIONS: none — the plan was unambiguous at every step I reached; no decision needed the owner.

## Review
**Verdict: APPROVED** (cto, 2026-10-14), with one small fix applied during review. Nothing is committed yet.

**Re-run by the reviewer:**
- `npm test`: 132 passed, 0 failed, 6 files.
- `npm run build`: ok.
- `deno check --config deno.json index.ts`: exit 0.
- `deno lint` with the explicit 5-file list: "Checked 5 files", exit 0.
- Protected-paths diff (`package*.json`, `deno.json`/`deno.lock`, `src/`, migrations, `handler.js`,
  `russian-trusted-ca.js`): empty.
- `grep OPENROUTER|sk-or src/`: no hits.
- `grep unsafely|DENO_TLS_CA_STORE|rejectUnauthorized supabase/`: no hits.

**Security:**
- Transport: OpenRouter gets plain `fetch` with default trust (`openrouterFetch`). The Минцифры CA client is used only
  by `gigachatFetch` (S9 holds).
- Logging: error logs go through a whitelist builder. `flagged_input`, `metadata.raw`, bodies and model text are
  never logged, and the upstream message is omitted on moderation (tested). The key is stripped of `Bearer `, sent
  only in `Authorization`, and appears in no log or error (tested).
- No user id is sent to OpenRouter. The app is attributed with `X-OpenRouter-App-Visibility: hidden`.

**AI contract:**
- Prompts, schemas and validators are unchanged. The body has a single leading system message plus `json_object`,
  hidden low reasoning and a 3-model fallback list.
- `repairInvalidJson: false`; one fetch per request, no client retries (tested).
- Errors inside a 200 body or a choice are classified like HTTP errors.
- The daily-cap 429 maps to `quota_exceeded` (existing Arabic message, no retry button). Other 429s map to
  `unavailable`.
- `handler.js` is untouched.

**Fix applied in review:**
- File: `providers.js` `parseModelList`.
- Problem: it logged invalid model-list entries verbatim. A secret pasted into the wrong variable (for example the
  API key in `OPENROUTER_MODELS`) fails the id pattern and would have been logged in full.
- Fix: it now logs only `count`.
- The test in `tests/openrouter.test.js` was updated to assert that values (including an `sk-or-…` entry) are never
  logged.

**Found, not fixed (owner decision):**
- `.claude/agents/implementer.md` still lists `deno lint --config deno.json ..`, which checks 1 file. It should use
  the explicit 5-file list.
- `.claude/skills/` is missing.

**Definition of Done:**
- Met for the code stage: tests and build pass; ADR 0004, runbook, requirements (A1, S10) and README are updated;
  rollback is defined.
- Pending by design: live verification L1–L5 (A1, R2–R4 stay `IMPLEMENTED_NEEDS_FIX`) and the S10 in-app privacy
  notice (follow-up plan).

**Deploy bundle for `ai`** (paths relative to `supabase/functions/`; entrypoint `ai/index.ts`;
`import_map_path: "deno.json"` = `ai/deno.json`):
- `ai/index.ts`
- `ai/deno.json`
- `_shared/ai-contract.js`
- `_shared/handler.js`
- `_shared/providers.js`
- `_shared/russian-trusted-ca.js`

Deploy order: the owner first sets `OPENROUTER_API_KEY` and `AI_DAILY_LIMIT=20`, and removes `AI_PROVIDER` (or sets
it to `openrouter`). Then deploy, then follow L2–L5.
