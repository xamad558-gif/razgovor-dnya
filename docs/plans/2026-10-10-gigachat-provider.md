# Plan: GigaChat as the conversation provider (Anthropic kept behind a switch)

- **Date:** 2026-10-10 · **Author:** cto (Claude Opus 5.5) · **Implementer:** implementer (Claude Sonnet 5)
- **Status:** APPROVED (ready for implementer)

## Goal
The owner (a student in Moscow) cannot fund the Anthropic API: the account has no credit, a Claude Pro subscription
does not include API usage, and Russia is not an Anthropic-supported region. He chose **GigaChat (Sber) Freemium for
individuals**: 365M tokens for 12 months, split per model (250M Lite `GigaChat-2`, 40M `GigaChat-2-Pro`, 25M
`GigaChat-2-Max`, 50M `GigaChat-3-Ultra`), with one concurrent request stream.

This change makes GigaChat the default provider of the `ai` Edge Function. Everything else stays the same: the app UI,
the three tasks (`chat`, `evaluate`, `topic`), the prompts, the validators, the quota, the `ai_requests` log, CORS and
auth. The Anthropic path keeps working behind `AI_PROVIDER=anthropic`, so the owner can switch back with one secret
and no redeploy.

## Requirements touched
| ID | Change | Target status |
|---|---|---|
| R2, R3, R4 | Same behaviour, new provider. Evidence text mentions GigaChat | stay `IMPLEMENTED_NEEDS_FIX → needs live run with GigaChat key + quality eval` |
| S1 | `GIGACHAT_AUTH_KEY` lives only in backend secrets | `IMPLEMENTED_VERIFIED` (add the evidence) |
| S7 | Provider error logs carry status, phase and ids only, never text | `IMPLEMENTED_VERIFIED` (new tests) |
| S8 | **No new dependencies** (plain `fetch`) | unchanged |
| **A1 (new)** | Conversation provider switchable: GigaChat default, Anthropic kept | `IMPLEMENTED_NEEDS_FIX → live run with owner's key` |
| **S9 (new)** | Extra TLS trust (Russian Trusted Root CA) only on GigaChat requests; verification never disabled | `IMPLEMENTED_NEEDS_FIX → live TLS handshake from Supabase` |

## Verified facts this plan relies on (checked 2026-10-10)
| Fact | Source |
|---|---|
| OAuth is `POST https://ngw.devices.sberbank.ru:9443/api/v2/oauth`, header `Authorization: Basic <Authorization key>` plus `RqUID: <uuid4>`, form body `scope=GIGACHAT_API_PERS`. It returns `{access_token, expires_at}`, where `expires_at` is in **milliseconds** (the official SDK compares it with `time.time()*1000`). Tokens last 30 min. Token requests are limited to 10/s. | OpenAPI `api.yml`; `ai-forever/gigachat` `client.py:332`, `api/auth.py` |
| The chat base URL is now **`https://api.giga.chat/v1`**, the single address for new connections since 17 Jul 2026. The old `gigachat.devices.sberbank.ru` still works for existing clients only. The official Python SDK defaults to `https://api.giga.chat/v1`. | changelog (spring-ai-gigachat #138, vc.ru); SDK `settings.py` |
| `api.giga.chat` answers **403 when no `User-Agent` is sent** | errors-description page |
| The chat body is `{model, messages[{role: system\|user\|assistant, content}], temperature (>0), max_tokens (>0), response_format?}`. Only one system message is allowed and it must come first (otherwise 422). | OpenAPI `api.yml` |
| `response_format: {type:"json_schema", schema, strict}` exists on v1 (top level). The official SDK calls it **"Beta... strict is best-effort"**. The supported JSON-Schema subset (`anyOf`, `null`, `enum`) is not documented. | structured-output guide; SDK `models/response_format.py` |
| `finish_reason` is one of `stop`, `length`, `function_call`, `blacklist` (topic restriction) or `error`. `usage` has `prompt_tokens`, `completion_tokens`, `total_tokens`, `precached_prompt_tokens`. | JS SDK `interfaces/finish_reason.ts`; OpenAPI |
| Errors: 401 means a missing or expired token, **402 means tokens exhausted ("Payment Required")**, 403 means no User-Agent, 404 means an unknown model, 413/422 mean bad size or order, **429 means too many concurrent streams (individuals: 1)**, 500 is internal. | errors-description page |
| Model ids: `GigaChat-2` (Lite), `GigaChat-2-Pro`, `GigaChat-2-Max`, `GigaChat-3-Ultra` (Ultra is freemium-only). | individual-tariffs page; Ultra model page |
| GigaChat TLS chains to the **НУЦ Минцифры "Russian Trusted Root CA"**, which is not in the Mozilla store. The cert is needed for both OAuth and chat. | Sber "certificates" page; official SDK README |
| **The Supabase Edge Runtime supports `Deno.createHttpClient({ caCerts })` + `fetch(url, { client })`.** It is exported in `ext/runtime/js/denoOverrides.js`, and integration test `test_issue_208` proves custom CAs work and that without them the error is `invalid peer certificate: UnknownIssuer`. The default root store is Mozilla. | `supabase/edge-runtime` @ d4a4f60 (2026-10-01) |
| In Deno 2.9.6, `createHttpClient` is stable and type-checks. `caCerts` are added **in addition to** the default roots. | `deno types`, local `deno check` |
| Supabase project `stgqlhszrrzzulokbpxs` is in region `eu-central-1` (Frankfurt) | Supabase MCP `get_project` |

Not verifiable from here, because the sandbox proxy blocks `*.sberbank.ru`, `api.giga.chat`, `gu-st.ru` and
`gosuslugi.ru`: whether GigaChat accepts calls from non-Russian IPs, whether port 9443 is reachable from Supabase, the
real latency, and the real JSON quality. See "Live verification".

## Decisions
| # | Decision | Choice | Reason |
|---|---|---|---|
| D1 | Provider interface | The handler takes **`deps.provider`** in place of `deps.callModel` + `deps.model`. It is an object `{ name, repairInvalidJson, modelFor(task), complete(req, ctx) }`. `complete` returns a **normalised result** `{ model, stop: 'end'\|'refusal'\|'max_tokens', text, inputTokens, outputTokens }` or throws a `ProviderError { name:'ProviderError', code, status, logStatus }`, where `code` is a key of `ERRORS`. | The handler stops knowing the Anthropic response shape. Each provider maps its own stop reasons, usage and errors in one tested place. The handler stays runtime-agnostic. |
| D2 | Where code lives | Prompts and per-provider model settings go in `_shared/ai-contract.js`, which stays the single source of truth for both. Transport (OAuth, fetch, retries, error mapping, env selection) goes in a new **`_shared/providers.js`**, runtime-agnostic with injected `fetch`, `now`, `sleep` and `uuid`. `ai/index.ts` only wires Deno things (env, `createHttpClient`, SDK, Supabase admin client). | Follows CLAUDE.md layout rules. Everything except `index.ts` is unit-tested in Node. |
| D3 | HTTP client | **Plain `fetch`, no GigaChat SDK, no new dependency.** | It is ~150 lines. The official JS SDK is Node/axios-oriented and was last updated Apr 2026. Fewer supply-chain risks (S8). |
| D4 | TLS | `Deno.createHttpClient({ caCerts: RUSSIAN_TRUSTED_CA_PEMS })` is created **once at module scope**. It is used **only** by the GigaChat fetch wrapper. Every other fetch (Supabase, Anthropic) keeps the default trust. The PEMs are committed as a JS module (public certificates) with SHA-256 fingerprints pinned by a unit test. **TLS verification is never disabled** (no `unsafelyIgnoreCertificateErrors`, no `DENO_TLS_CA_STORE` changes). | Scoped trust: the Минцифры root is trusted for GigaChat traffic only. A JS module is bundled by the deploy without static-file config. |
| D5 | Which certs | Three certs: the root plus the two Sub CAs (2022, 2024). | The Sub CAs are signed by the root, so trusting them adds **no** trust beyond the root. They make the handshake work even if a server omits its intermediate, because rustls does no AIA fetching. |
| D6 | If `createHttpClient` throws at boot | Catch it, log `{msg:'gigachat ca client unavailable', error}`, and fall back to plain `fetch`. The fallback is still TLS-verified, so it fails closed with `UnknownIssuer`, which the logs show. Contingency (not built now): a small relay in Russia (Yandex Cloud Function, Node 22 with the CA in `tls.ca`), called by the Edge Function over public-CA TLS with a shared secret. Written down in ADR 0003. | Never crash the boot. Never weaken TLS. The contingency is also the answer if GigaChat geo-blocks non-Russian IPs. |
| D7 | Endpoints | Chat: `https://api.giga.chat/v1/chat/completions`. OAuth: `https://ngw.devices.sberbank.ru:9443/api/v2/oauth`. Both are constants in `providers.js` and overridable by `GIGACHAT_BASE_URL` / `GIGACHAT_AUTH_URL`, but **only `https:` URLs are accepted**. Any other value is ignored and logged. | These are the official current addresses. An override lets the owner switch to the legacy host without a redeploy if needed. |
| D8 | Request headers | Chat: `Authorization: Bearer <token>`, `Content-Type: application/json`, `Accept: application/json`, `User-Agent: razgovor-dnya/0.1`, `X-Request-ID: <our request_id>`. OAuth: `Authorization: Basic <key>`, `RqUID: <uuid4>`, `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`, `User-Agent` (same). **No `X-Client-ID`/`X-Session-ID`** (no user ids sent to the provider). | The User-Agent is mandatory (403 otherwise). `X-Request-ID` correlates our log with Sber support. Data minimisation. |
| D9 | Token cache | Module-scope cache `{ token, expiresAt }`, **refreshed when fewer than 60 s remain** (the official SDK's default buffer). Refresh is **single-flight**: concurrent callers await one pending OAuth promise. `expires_at` < 1e12 is treated as seconds (×1000). If it is missing or invalid, use now + 25 min. The key is trimmed and a leading `Basic ` (any case) is stripped. | Avoids an OAuth call per request and stampedes. Tolerates format drift. |
| D10 | 401 on chat | Invalidate the cache only if the cached token is still the one that failed. Get a new token and **retry once**. A second 401 gives `ProviderError('server', 401, 'provider_error_401')`. | Tokens can expire between check and use. A bounded retry cannot loop. |
| D11 | Error mapping (GigaChat) | 402 → `billing` (logStatus `provider_billing`). 429 → retry once after 2 s if elapsed < 15 s, then `unavailable`. 500/502/504 → retry once (same rule), then `server`. 503 → retry once, then `unavailable`. 400/403/404/413/422 → `server`, no retry. Network `TypeError` (TLS, DNS, connect) → `server`, logStatus `provider_error_network`. `TimeoutError`/`AbortError` → `timeout`. OAuth non-200 → `server`, logStatus `provider_error_oauth_<status>`. An unparseable 200 body → `invalid_response`. | Reuses the existing codes, so **the app needs no change**. The `billing` Arabic text in `src/ai/client.js` is already generic ("رصيد حساب الذكاء الاصطناعي نفد"), so it is **not changed**. |
| D12 | Timeouts / deadline | OAuth 10 s and chat 25 s per call (`AbortSignal.timeout`). Retry only if elapsed < 15 s. JSON repair only if elapsed < 25 s. The worst case stays under the app's 60 s client timeout. | The app aborts at 60 s (`requestAI` default). With one stream, a hung request blocks the next one. |
| D13 | finish_reason | `stop` → `end`. `length` → `max_tokens` (handler: `invalid_response` "response truncated", status `truncated`). `blacklist` → `refusal` (handler: `refused` 422). `function_call`, `error`, missing or unknown → `end`, and parsing decides. | Maps onto the existing handler branches. |
| D14 | JSON strategy | **Default: prompt-only JSON** (the existing "Reply ONLY with JSON" lines) + `parseModelJson` + `VALIDATORS`, plus **at most one repair call** when parsing or validation fails, the provider has `repairInvalidJson: true`, the stop is `end`, the text is non-empty, and elapsed < 25 s. The repair call is the same prompt plus `{role:'assistant', content: badText.slice(0, 4000)}` and `{role:'user', content: REPAIR_INSTRUCTION}`. The repair prompt lives in `ai-contract.js`. **Opt-in `GIGACHAT_STRUCTURED=on`** adds `response_format: {type:'json_schema', schema: SCHEMAS[task], strict: true}`. Validators still run. | Structured output is Beta with an undocumented schema subset. Our schemas use `anyOf`+`null` and `enum`, so a 422 would break every request. The owner turns it on during live verification only if it works. The repair costs tokens only on failure and consumes **no extra quota unit**. Anthropic keeps `repairInvalidJson: false`, because its schema-constrained output makes repair pointless, so the Anthropic path is unchanged. |
| D15 | Models per task (defaults) | `chat` → **`GigaChat-2-Max`**, `evaluate` → **`GigaChat-2-Max`**, `topic` → **`GigaChat-2-Pro`**. Precedence: `GIGACHAT_MODEL_<TASK>` (e.g. `GIGACHAT_MODEL_CHAT`) > `GIGACHAT_MODEL` > default. **`AI_MODEL` stays Anthropic-only.** | Corrections and Arabic grammar notes are the core product, so use the strongest mature model. Max is the model in Sber's structured-output examples. Quota math (below) gives ~2.4× headroom for one learner on the 25M Max bucket. Topic generation is simple, so it goes to Pro and spreads load. `GigaChat-3-Ultra` (50M, newest) is evaluated live as a challenger and switched in by secret, no redeploy. A stale `AI_MODEL=claude-…` secret cannot break GigaChat. |
| D16 | Generation settings | `chat`: temperature 0.5, max_tokens 1500. `evaluate`: 0.2, 1500. `topic`: 0.9, 600. No `top_p`, `repetition_penalty` or `profanity_check` (provider defaults). | GigaChat has no thinking tokens, so these budgets fit the JSON shapes (~600–900 tokens for chat). Low temperature for grading, high for creative topics. |
| D17 | Provider selection | `AI_PROVIDER` = `gigachat` (default when unset or empty) \| `anthropic`. An unknown value or a missing key for the chosen provider gives a provider whose `complete` throws `ProviderError('server', 500, 'provider_not_configured')` and logs it once at boot. **No throw at module top level.** | One secret switches providers with no redeploy. A misconfiguration shows up as a clear log status, not a boot crash. |
| D18 | Logging | Unchanged `ai_requests` columns. `model` = the response's `model` string when present (e.g. `GigaChat-2-Max:2.0.28.2`, which includes the version), else the requested id. New statuses: `ok_repaired`, `provider_billing`, `provider_error_<status>`, `provider_error_network`, `provider_error_oauth_<status>`, `provider_not_configured`. Function log line on each provider failure: `{level:'error', msg:'gigachat error', phase:'oauth'\|'chat', status, request_id, upstream_request_id (response header x-request-id), upstream_message (JSON body .message, ≤300 chars), error_name, error_message (≤300 chars)}`. One boot line: `{level:'info', msg:'ai provider', provider, models, structured, ca_client: true\|false}`. **Never**: learner or model text, request bodies, the auth key, the access token. Tokens: input = `prompt_tokens`, output = `completion_tokens`, summed over the repair call. | Diagnosis after deploy depends on these logs. The TLS error message (`invalid peer certificate: UnknownIssuer`) and Sber error messages contain no conversation text. No migration needed (status is free text). |
| D19 | Docs | **New ADR 0003** (provider decision and the owner's reason). ADR 0002 status line amended ("model/provider section superseded by ADR 0003"). The rest of 0002 stays valid. | ADRs are append-only. 0002's architecture still holds. |
| D20 | CLAUDE.md | **Not edited by the implementer.** The CTO recommends that the owner or main session change the line "Model id is `claude-opus-5-5` unless the owner decides otherwise (ADR 0002)" to "Default provider GigaChat (ADR 0003); Anthropic model `claude-opus-5-5` when `AI_PROVIDER=anthropic`". | Project-instruction changes need the owner's own approval, not an agent's. |

### Quota math (D15)
Rough GigaChat token counts, input + output both billed: chat request ≈ 2.5k (system ≈ 0.8k + history + ≈ 0.6k
output); evaluate ≈ 3.5k; topic ≈ 1k.

| Usage | Tokens/day | Tokens/12 mo | Bucket | Headroom |
|---|---|---|---|---|
| Typical day: 10 chat + 1 evaluate on Max | ≈ 28.5k | ≈ 10.4M | Max 25M | ≈ 2.4× |
| Heavy day: 2 conversations | ≈ 57k | ≈ 20.8M | Max 25M | ≈ 1.2× |
| Worst case `AI_DAILY_LIMIT=60`, all chat | ≈ 150k | the bucket lasts ≈ 165 days | Max 25M | n/a |
| Same typical usage on Ultra (challenger) | ≈ 28.5k | ≈ 10.4M | Ultra 50M | ≈ 4.8× |
| Topic on Pro, ~2/week | tiny | ≈ 0.1M | Pro 40M | huge |

If the Max bucket runs out, 402 maps to `billing`. The fix is a secret change (`GIGACHAT_MODEL_CHAT=GigaChat-3-Ultra` or
`GigaChat-2-Pro`), with no deploy. Recommend lowering `AI_DAILY_LIMIT` to **30** for the single-learner freemium setup
(documented in the runbook; the owner's choice).

## Files
| File | Change |
|---|---|
| `supabase/functions/_shared/russian-trusted-ca.js` | **new**: `RUSSIAN_TRUSTED_CA_PEMS` (3 PEM strings) and `RUSSIAN_TRUSTED_CA_SHA256` (3 fingerprints), header comment with source and verification |
| `supabase/functions/_shared/ai-contract.js` | add `PROVIDERS`, `DEFAULT_PROVIDER`, `GIGACHAT_DEFAULT_MODELS`, `GIGACHAT_TASK_SETTINGS`, `REPAIR_INSTRUCTION`, `buildRepairPrompt`, `buildGigaChatRequest`. Existing exports unchanged. |
| `supabase/functions/_shared/providers.js` | **new**: `ProviderError`, `createAnthropicProvider`, `createGigaChatProvider` (token manager inside), `normalizeGigaChat`, `resolveGigaChatModels`, `createProviderFromEnv`, constants |
| `supabase/functions/_shared/handler.js` | use `deps.provider` (D1); repair loop (D14); error mapping via `ProviderError` |
| `supabase/functions/ai/index.ts` | provider wiring, `createHttpClient`, boot log, header comment |
| `supabase/functions/.env.example` | GigaChat secrets first; Anthropic optional |
| `tests/backend.test.js` | adapt `setup()` to the provider interface; add handler tests (below) |
| `tests/gigachat.test.js` | **new**: contract builders, provider transport, CA pin, env selection |
| `docs/adr/0003-gigachat-provider.md` | **new** |
| `docs/adr/0002-ai-backend.md` | status line only |
| `docs/deploy-backend.md` | GigaChat setup for the owner (simple steps), secrets table, statuses, rollback |
| `docs/requirements.md` | rows A1, S9; evidence for R2–R4, S1, S7 |
| `README.md` | backend paragraph + status (provider, test count) |

Not touched: `src/**` (app), `supabase/migrations/**`, `deno.json`/`deno.lock`, `package.json`, `CLAUDE.md`.

## Steps

### Step 1: vendor the CA certificates
1. Fetch the cross-check source into the scratchpad (not the repo):
   `git clone --depth 1 --filter=blob:none --sparse https://github.com/qwerty-ll/CombinedPortal.git <scratch>/cp && git -C <scratch>/cp sparse-checkout set server/app/assets/certs`.
   Expected commit `6cedeabee3e69a92e2382a887432158256c4a979`. If it differs, verify fingerprints anyway (below).
2. From `server/app/assets/certs/russian_trusted_ca.pem` copy **only** the three `-----BEGIN CERTIFICATE-----…END-----`
   blocks, byte-exact including line breaks, into `supabase/functions/_shared/russian-trusted-ca.js`:
   ```js
   // НУЦ Минцифры (Russian Ministry of Digital Development) CA certificates. GigaChat's TLS chain ends at this root,
   // which is not in Deno's default (Mozilla) store. Trusted ONLY by the GigaChat fetch client (ai/index.ts).
   // Official source: https://www.gosuslugi.ru/crt (root PEM: https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt)
   // Verify: openssl x509 -in <file> -noout -fingerprint -sha256   (values below are pinned by tests/gigachat.test.js)
   export const RUSSIAN_TRUSTED_CA_SHA256 = {
     root: 'D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31', // Russian Trusted Root CA, valid to 2032-02-27
     sub2022: 'BB:BD:E2:10:3E:79:0B:99:9E:C6:2B:D0:3C:F6:25:A5:A2:E7:C3:16:E1:0A:FE:6A:49:0E:ED:EA:D8:B3:FD:9B', // Russian Trusted Sub CA, valid to 2027-03-06
     sub2024: '21:55:78:50:36:C9:00:DB:B5:F1:BB:2A:15:69:C8:0C:55:59:5B:D6:BF:94:86:7A:29:BB:DD:BC:7D:88:A3:F2', // Russian Trusted Sub CA, valid to 2029-07-19
   };
   export const RUSSIAN_TRUSTED_CA_PEMS = [ROOT_PEM, SUB_2022_PEM, SUB_2024_PEM]; // template literals, root first
   ```
3. Verify now: the test in step 3 (CA pin) must pass. If any fingerprint differs, **stop and report**. Do not "fix"
   the constant.

### Step 2: contract additions (`ai-contract.js`)
Append, without changing existing exports:
```js
export const PROVIDERS = ['gigachat', 'anthropic'];
export const DEFAULT_PROVIDER = 'gigachat';
export const GIGACHAT_DEFAULT_MODELS = { chat: 'GigaChat-2-Max', evaluate: 'GigaChat-2-Max', topic: 'GigaChat-2-Pro' };
export const GIGACHAT_TASK_SETTINGS = {
  chat: { temperature: 0.5, maxTokens: 1500 },
  evaluate: { temperature: 0.2, maxTokens: 1500 },
  topic: { temperature: 0.9, maxTokens: 600 },
};
export const REPAIR_INSTRUCTION =
  'Your previous reply was not valid JSON in the required format. Reply again with ONLY the JSON object in exactly the required format, with no other text.';

/** Same prompt plus the invalid reply and a request to resend valid JSON. */
export function buildRepairPrompt(prompt, badText) { /* {system, messages:[...prompt.messages, {role:'assistant', content:String(badText).slice(0,4000)}, {role:'user', content:REPAIR_INSTRUCTION}]} */ }

/**
 * GigaChat /v1/chat/completions body. The system prompt becomes the first (only) system message.
 * @param {{structured?: boolean, repairOf?: string}} [opts]
 */
export function buildGigaChatRequest(req, model, opts = {}) {
  // prompt = buildPrompt(req); if opts.repairOf → buildRepairPrompt(prompt, opts.repairOf)
  // body = { model, messages:[{role:'system',content:prompt.system}, ...prompt.messages], temperature, max_tokens }
  // if opts.structured → body.response_format = { type:'json_schema', schema: SCHEMAS[req.task], strict: true }
}
```
`buildPrompt`, the prompts and `SCHEMAS` stay byte-identical.

### Step 3: `providers.js` (new, runtime-agnostic)
Exports and exact behaviour:
```js
export const GIGACHAT_AUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
export const GIGACHAT_BASE_URL = 'https://api.giga.chat/v1';
export const GIGACHAT_SCOPE = 'GIGACHAT_API_PERS';
export const USER_AGENT = 'razgovor-dnya/0.1';
export const TIMEOUTS = { oauthMs: 10_000, chatMs: 25_000 };
export const RETRY = { delayMs: 2_000, ifElapsedUnderMs: 15_000 };
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export class ProviderError extends Error {
  constructor(code, { status = 0, logStatus, message } = {}) { super(message || code); this.name = 'ProviderError'; this.code = code; this.status = status; this.logStatus = logStatus || `provider_error_${status || 'unknown'}`; }
}

/** chat/evaluate/topic → model id. env: (name) => string|undefined */
export function resolveGigaChatModels(env) { /* per-task GIGACHAT_MODEL_CHAT|EVALUATE|TOPIC > GIGACHAT_MODEL > GIGACHAT_DEFAULT_MODELS; trim; empty = unset */ }

/** GigaChat JSON → normalised result (D13). */
export function normalizeGigaChat(json, requestedModel) {
  // choice = json?.choices?.[0]; fr = choice?.finish_reason
  // stop = fr==='length' ? 'max_tokens' : fr==='blacklist' ? 'refusal' : 'end'
  // text = typeof choice?.message?.content === 'string' ? content : ''
  // model = typeof json?.model === 'string' && json.model ? json.model : requestedModel
  // inputTokens = json?.usage?.prompt_tokens ?? null; outputTokens = json?.usage?.completion_tokens ?? null
}

/**
 * @param {object} o
 * @param {string} o.authKey  Base64 "Authorization key" (trim; strip leading /^basic\s+/i)
 * @param {string} [o.scope]  default GIGACHAT_SCOPE
 * @param {{chat:string,evaluate:string,topic:string}} o.models
 * @param {boolean} [o.structured]
 * @param {(url:string, init:RequestInit)=>Promise<Response>} o.fetch   (index.ts passes the CA-pinned client)
 * @param {string} [o.authUrl] @param {string} [o.baseUrl]   (https: only, else default + log)
 * @param {() => number} [o.now] @param {(ms:number)=>Promise<void>} [o.sleep] @param {() => string} [o.uuid]
 * @param {(entry:object)=>void} [o.log]   structured error logger (D18); default console.error(JSON.stringify(e))
 */
export function createGigaChatProvider(o) {
  // returns { name:'gigachat', repairInvalidJson:true, modelFor(task), async complete(req, { requestId, repairOf } = {}) }
}

/** Anthropic SDK wrapper; create = (body) => anthropic.beta.messages.create(body). Behaviour identical to today. */
export function createAnthropicProvider({ create, model = DEFAULT_MODEL }) {
  // { name:'anthropic', repairInvalidJson:false, modelFor:()=>model, async complete(req) }
  // body = buildModelRequest(req, model); msg = await create(body) — errors via classifyAnthropicError
  // stop: msg.stop_reason==='refusal'→'refusal', 'max_tokens'→'max_tokens', else 'end'; text = responseText(msg)
  // model = msg.model || model; tokens = msg.usage.input_tokens / output_tokens (?? null)
}
export function classifyAnthropicError(e) {
  // timeout: e.code==='timeout' || e.name==='APIConnectionTimeoutError' → ProviderError('timeout', {status, logStatus:'provider_error_'+(status||'timeout')})
  // /credit balance|billing/i on String(e?.error?.error?.message ?? e?.message) → ProviderError('billing', {status, logStatus:'provider_billing'})
  // status 429|529|503 → 'unavailable'; else 'server'. logStatus default 'provider_error_'+(status||e?.code||'unknown')  (= today's handler)
}

/**
 * env: (name)=>string|undefined. deps: { gigachatFetch, anthropicCreate, log, now?, sleep?, uuid? }
 * AI_PROVIDER unset/'' → 'gigachat'. 'gigachat' needs GIGACHAT_AUTH_KEY; 'anthropic' needs ANTHROPIC_API_KEY.
 * Unknown provider or missing key → { name, repairInvalidJson:false, modelFor:()=>null, complete: throws
 *   ProviderError('server', {status:500, logStatus:'provider_not_configured'}) }, and log once
 *   {level:'error', msg:'ai provider not configured', provider, missing:'GIGACHAT_AUTH_KEY'|'ANTHROPIC_API_KEY'|'AI_PROVIDER'}.
 * GIGACHAT_STRUCTURED: 'on'|'true'|'1' (case-insensitive) → structured true; anything else false.
 */
export function createProviderFromEnv(env, deps) {}
```
GigaChat `complete` algorithm:
1. `t0 = now()`. `model = models[req.task]`. `body = buildGigaChatRequest(req, model, { structured, repairOf })`.
2. `token = await getToken()`. Single-flight: `if (cache && cache.expiresAt - now() > TOKEN_REFRESH_MARGIN_MS) return cache.token; pending ??= fetchToken().finally(() => { pending = null; }); return pending;`
   `fetchToken`: POST the auth URL with the D8 headers, body `new URLSearchParams({ scope }).toString()`, signal
   `AbortSignal.timeout(TIMEOUTS.oauthMs)`. Non-200 → log `{phase:'oauth', status, upstream_message}` and throw
   `ProviderError('server', {status, logStatus:'provider_error_oauth_'+status})`. A 200 without a string `access_token`
   gives the same error with logStatus `provider_error_oauth_invalid`. Store `{ token, expiresAt }` per D9.
3. `res = await fetch(baseUrl + '/chat/completions', { method:'POST', headers (D8), body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUTS.chatMs) })`.
4. 401 → D10 (invalidate if `cache?.token === token`, get a new token, repeat step 3 once). 429/500/502/503/504 →
   if `now() - t0 < RETRY.ifElapsedUnderMs`: `await sleep(RETRY.delayMs)` and repeat step 3 once. At most **one
   retry of any kind per `complete` call** (a 401 refresh counts as that retry).
5. Non-OK after that → log `{phase:'chat', status, upstream_request_id: res.headers.get('x-request-id'), upstream_message}`
   (read the body with `res.text()`, try `JSON.parse(...).message`, slice 300) and throw per D11.
6. OK → `json = await res.json()` (failure gives `ProviderError('invalid_response', {status:200, logStatus:'provider_bad_body'})`), then `return normalizeGigaChat(json, model)`.
7. A fetch rejection: `e.name === 'TimeoutError' || e.name === 'AbortError'` → `ProviderError('timeout', {logStatus:'provider_error_timeout'})`.
   Anything else → log `{phase, error_name, error_message: String(e?.message).slice(0,300)}` and throw
   `ProviderError('server', {logStatus:'provider_error_network'})`. Apply this to both OAuth and chat.
8. `ProviderError` messages and logs must never include `authKey`, the token, request bodies or model text.

### Step 4: handler (`handler.js`)
- Update the deps JSDoc: remove `callModel` and `model`, add
  `deps.provider: { name, repairInvalidJson, modelFor(task), complete(req, ctx) }`.
- Replace the block from `const body = buildModelRequest(...)` to the end with:
  ```text
  entry.model = deps.provider.modelFor(req.task)
  call = (repairOf) => deps.provider.complete(req, { requestId, repairOf })
  try result = await call()  catch e → providerFail(e)
  accumulate tokens; entry.model = result.model || entry.model
  refusal → refused; max_tokens → truncated / invalid_response 'response truncated'   (unchanged texts/statuses)
  try data = VALIDATORS[task](parseModelJson(result.text))
  catch:
    if provider.repairInvalidJson && result.stop==='end' && result.text && now()-started < 25_000 (export const REPAIR_IF_ELAPSED_UNDER_MS = 25_000):
       try r2 = await call(result.text) catch e → providerFail(e)
       accumulate tokens (null-safe sum: null+null=null, null+n=n); entry.model = r2.model || entry.model
       if r2.stop==='refusal' → refused; 'max_tokens' → truncated
       try data = VALIDATORS[task](parseModelJson(r2.text)); entry.status='ok_repaired' catch → invalid_output
    else → invalid_output (unchanged)
  ```
  `providerFail(e)`: `code = e?.name === 'ProviderError' && ERRORS[e.code] ? e.code : 'server'`; `entry.status = e?.logStatus || 'provider_error_unknown'`.
- Remove the now-unused imports (`buildModelRequest`, `responseText`). The handler must not import `providers.js`.
- Keep the order of everything before the model call identical (CORS, method, auth, size, JSON, validate, quota).

### Step 5: `ai/index.ts`
- Header comment: provider switch, secrets list (`AI_PROVIDER`, `GIGACHAT_AUTH_KEY`, `GIGACHAT_SCOPE`,
  `GIGACHAT_MODEL[_CHAT|_EVALUATE|_TOPIC]`, `GIGACHAT_STRUCTURED`, `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_DAILY_LIMIT`,
  `ALLOWED_ORIGINS`).
- Build the CA client at module scope:
  ```ts
  let caClient: Deno.HttpClient | null = null;
  try { caClient = Deno.createHttpClient({ caCerts: RUSSIAN_TRUSTED_CA_PEMS }); }
  catch (e) { console.error(JSON.stringify({ level: 'error', msg: 'gigachat ca client unavailable', error: String((e as Error)?.message ?? e).slice(0, 300) })); }
  const gigachatFetch = (url: string, init: RequestInit) => (caClient ? fetch(url, { ...init, client: caClient }) : fetch(url, init));
  ```
- Construct the Anthropic SDK lazily inside `anthropicCreate`, only when first used. Keep today's Anthropic error
  log, moved into `anthropicCreate`'s catch, and rethrow the raw error so `classifyAnthropicError` sees it.
- `const provider = createProviderFromEnv((k) => Deno.env.get(k), { gigachatFetch, anthropicCreate, log: (e) => console.error(JSON.stringify({ level: 'error', ...e })) });`
- Boot log `{level:'info', msg:'ai provider', provider: provider.name, models: {chat, evaluate, topic} via modelFor, structured, ca_client: !!caClient}`.
  No secrets.
- `createHandler({ ..., provider })` (remove `model`, `callModel`). Everything else is unchanged.

### Step 6: `.env.example`
```
# Provider: gigachat (default) | anthropic
AI_PROVIDER=gigachat
GIGACHAT_AUTH_KEY=paste-the-Authorization-key-from-developers.sber.ru
# Optional
# GIGACHAT_SCOPE=GIGACHAT_API_PERS
# GIGACHAT_MODEL_CHAT=GigaChat-2-Max
# GIGACHAT_MODEL_EVALUATE=GigaChat-2-Max
# GIGACHAT_MODEL_TOPIC=GigaChat-2-Pro
# GIGACHAT_STRUCTURED=off
# Only when AI_PROVIDER=anthropic
# ANTHROPIC_API_KEY=sk-ant-...
# AI_MODEL=claude-opus-5-5
AI_DAILY_LIMIT=30
ALLOWED_ORIGINS=https://xamad558-gif.github.io,capacitor://localhost,https://localhost
```

### Step 7: docs
- **`docs/adr/0003-gigachat-provider.md`** (Status: Accepted, Oct 2026). Sections:
  - Context: the owner's reason, exactly as in Goal.
  - Decision: D1, D4–D5, D14, D15, D17.
  - Quota-math table.
  - Consequences:
    - Learner text now goes to Sber (a Russian provider, Russian law). Acceptable for the owner as the sole learner.
      Before inviting other learners, re-check GigaChat's personal-tariff terms for multi-user / commercial use and
      data use, and move to a paid or legal-entity plan if needed.
    - One concurrent stream, so a second simultaneous request gets 429 / "busy".
    - GigaChat may refuse politics or religion topics (`blacklist` → `refused`). R1 includes those topics, so watch the
      `refused` rate.
    - Sub CA 2022 expires 2027-03-06. The root is valid to 2032-02-27. Calendar a review.
  - Contingency: the Russian relay (D6).
  - Alternatives rejected:
    - Stay on Anthropic: unfundable.
    - OpenAI-compatible resellers / proxies to Claude: ToS and key-exposure risk.
    - YandexGPT: needs Yandex Cloud billing, no comparable free tier for this owner.
    - GigaChat npm SDK: an extra dependency for ~150 lines.
    - Disabling TLS verification: rejected, P0.
- **ADR 0002**: change the status line to `**Status:** Accepted (Oct 2026). Provider/model section superseded by
  [ADR 0003](0003-gigachat-provider.md): default provider is GigaChat; this Anthropic setup remains available with
  AI_PROVIDER=anthropic.` Change nothing else.
- **`docs/deploy-backend.md`**:
  - Header: needs a GigaChat Authorization key (free for individuals) *or* an Anthropic key.
  - New section "2b. Get a GigaChat key (free, ~10 min)", in plain steps:
    1. Go to developers.sber.ru → Войти (Сбер ID) → choose **физическое лицо**.
    2. Create a project → **GigaChat API** → accept the terms. The Freemium package appears.
    3. Project → **Настройки API** → **Получить ключ** → copy the **Authorization key**. It is shown once. It is not
       the Client Secret.
    4. Supabase Dashboard → project `razgovor-dnya` → **Edge Functions → Secrets** → add `AI_PROVIDER` = `gigachat`
       and `GIGACHAT_AUTH_KEY` = (the key). Optional: `AI_DAILY_LIMIT` = `30`.
    5. Never put the key in the app's `.env`, in a `VITE_*` variable, or in chat messages.
  - Secrets table: all variables from step 6 with defaults and meaning.
  - New "Certificate check (one time)": on your own computer, download "Russian Trusted Root CA" from
    https://www.gosuslugi.ru/crt and confirm its SHA-256 equals `D2:6D:2D:02:…:8E:CF:31`, given in full.
    - macOS/Linux: `openssl x509 -in <file> -noout -fingerprint -sha256`.
    - Windows: `certutil -hashfile "<file>.cer" SHA256` (DER file: the file hash is the fingerprint).
  - Statuses list: add the D18 statuses.
  - "Operating it":
    - Key compromised → regenerate the key in the Sber project and update the secret.
    - Tokens exhausted (`provider_billing`) → switch the model secret or buy a package.
    - Busy (`429`) → one stream; wait.
  - Rollback: set `AI_PROVIDER=anthropic` (needs a funded `ANTHROPIC_API_KEY`), or redeploy the previous commit.
  - Keep the Anthropic steps as an "Alternative provider" subsection.
- **`docs/requirements.md`**: rows A1 and S9 from "Requirements touched". Update the R2–R4 evidence to "contract +
  handler + GigaChat provider tests". S1 evidence: add "`GIGACHAT_AUTH_KEY` only in function secrets". S7 evidence:
  add "provider error logs tested for no text/key".
- **`README.md`**: "Deploy once with `docs/deploy-backend.md` (Supabase + a free GigaChat key from Sber, ~20 min;
  Anthropic also supported)". Status: "Conversation: backend on GigaChat (Sber), N tests". Fix the test count to the
  real number.

### Step 8: run every check (see "Must pass") and append the Implementation report.

## Tests to add
**`tests/gigachat.test.js`** (new). Use a fake `fetch` that records `(url, init)` and returns
`new Response(JSON.stringify(...), { status, headers })`, a controllable `now`, `sleep = vi.fn(async () => {})`, and
`uuid = () => '00000000-0000-4000-8000-000000000000'`.
1. **CA pin.** `RUSSIAN_TRUSTED_CA_PEMS` has 3 entries. `new X509Certificate(pem).fingerprint256` equals the
   `RUSSIAN_TRUSTED_CA_SHA256` values in order. The root's subject and issuer contain `CN=Russian Trusted Root CA`.
   Both Sub CAs `verify(root.publicKey)` is true. Root `validTo` is after 2032-01-01.
2. **`buildGigaChatRequest`** for chat:
   - `messages[0].role === 'system'` and it is the only system message.
   - The roles after it alternate and end with `user`.
   - `model`, `temperature` and `max_tokens` come from the settings.
   - No `response_format` by default. With `{structured:true}`, `response_format` equals
     `{type:'json_schema', schema: SCHEMAS.chat, strict:true}`.
   - With `{repairOf:'bad'}`, the last two messages are the assistant `'bad'` and the user `REPAIR_INSTRUCTION`, and
     `repairOf` is cut to 4000 chars.
3. **`resolveGigaChatModels`**: defaults; `GIGACHAT_MODEL` applies to all tasks; `GIGACHAT_MODEL_CHAT` wins over it;
   blank values are ignored; `AI_MODEL=claude-opus-5-5` is ignored.
4. **First call.** One OAuth call to `GIGACHAT_AUTH_URL`:
   - `Authorization` is `Basic <key>`; a key given as `'  Basic KEY== '` is sent as `Basic KEY==`.
   - `RqUID` matches the uuid4 regex. The body is `scope=GIGACHAT_API_PERS`.
   - `Content-Type` is form-urlencoded and `User-Agent` is set.
   Then the chat call goes to `https://api.giga.chat/v1/chat/completions` with `Bearer <token>`, `User-Agent`, and
   `X-Request-ID` = the requestId.
5. **Token reuse**: two sequential `complete` calls make 1 OAuth call.
6. **Refresh**: advance `now` to `expires_at - 30_000` and the next call makes a new OAuth call. With `expires_at`
   given in seconds, the token is still cached (no refresh on the next call).
7. **Single-flight**: two concurrent `complete` calls with a cold cache make exactly 1 OAuth call.
8. **401 then 200**: 2 chat calls, 2 OAuth calls, success. **401 twice** gives ProviderError `server`, status 401,
   exactly 2 chat calls.
9. **402** gives `billing` and logStatus `provider_billing`, with 1 chat call and no sleep.
10. **429 then 200**: success; `sleep` called once with 2000. **429 twice** gives `unavailable`. **429 when elapsed ≥ 15 s**
    gives `unavailable` with no retry (1 chat call).
11. **500 twice** gives `server`. **503 twice** gives `unavailable`. **404** gives `server` with no retry.
12. **OAuth 401** gives `server` with logStatus `provider_error_oauth_401` and no chat call. **OAuth 200 without
    access_token** gives logStatus `provider_error_oauth_invalid`.
13. **Network**: fetch rejects `new TypeError('invalid peer certificate: UnknownIssuer')`. Result: `server`, logStatus
    `provider_error_network`, and the log entry has `error_message` containing `UnknownIssuer`.
14. **Timeout**: fetch rejects an error with `name: 'TimeoutError'`, giving `timeout`.
15. **`normalizeGigaChat`**: `stop` → `end`, `length` → `max_tokens`, `blacklist` → `refusal`, unknown → `end`.
    Usage is mapped. The response `model` is preferred; with no choices, text is `''`.
16. **No leaks**: run a failing 400 call where the learner message is `'Меня зовут Хамад'` and the key is
    `'SECRETKEY=='`. `JSON.stringify` of all log entries and of the thrown error contains neither string, nor the
    access token.
17. **`createProviderFromEnv`**:
    - Unset `AI_PROVIDER` with a key gives `name === 'gigachat'`. `'anthropic'` with `ANTHROPIC_API_KEY` gives
      `'anthropic'`.
    - `'gigachat'` without a key, or `'foo'`, gives `complete` rejecting with logStatus `provider_not_configured`,
      logged once.
    - `GIGACHAT_STRUCTURED=ON` makes the request body include `response_format`.

**`tests/backend.test.js`** (adapt + add):
- `setup()`: default `provider: createAnthropicProvider({ create: callModel, model: 'claude-opus-5-5' })`, where
  `callModel` is the existing mock (exposed on `deps` for assertions). All existing assertions keep their meaning,
  including `sent.output_config.format.type`, `sent.fallbacks`, the credit-balance → `billing` mapping, and
  529/429/timeout/500. Only the plumbing changes.
- New (GigaChat provider + fake fetch through the handler):
  - (a) 200 OK: response `data.reply`; log has `model` = the response model string, `input_tokens`/`output_tokens`
    from usage, and no learner text.
  - (b) `blacklist` → 422 `refused`, status `refused`.
  - (c) `length` → 502 `invalid_response` with message `response truncated`, status `truncated`.
  - (d) Invalid JSON then valid → 200, status `ok_repaired`, tokens summed. The second chat body ends with the
    assistant bad text + `REPAIR_INSTRUCTION`. Exactly 2 chat calls; quota consumed once.
  - (e) Invalid twice → 502 `invalid_response`, status `invalid_output`, 2 chat calls.
  - (f) Invalid JSON when elapsed ≥ 25 s → no repair (1 chat call).
  - (g) Anthropic provider with invalid output → no repair (`callModel` called once).
  - (h) 402 → 503 `billing`, `retryable:false`, status `provider_billing`.
  - (i) `provider_not_configured` → 502 `server`.

## Must pass
- [ ] `npm test`: all existing tests plus the new ones, 0 failures. Report the exact count.
- [ ] `npm run build`
- [ ] `cd supabase/functions/ai && /home/claude/probe/node_modules/deno/deno check --config deno.json index.ts`
      (Deno 2.9.6, the binary used before; `npx deno@2.9.6` is an equivalent fallback)
- [ ] `cd supabase/functions/ai && /home/claude/probe/node_modules/deno/deno lint --config deno.json ..` (covers `_shared/*.js`)
- [ ] `git diff --stat -- package.json package-lock.json supabase/functions/ai/deno.json supabase/functions/ai/deno.lock src supabase/migrations` is **empty**
- [ ] `grep -rn "GIGACHAT_AUTH_KEY\|Authorization key" src/ .env.example` has no hits (the key never reaches the app)
- [ ] `npx cap sync android`: **not needed** (no app change)

## Out of scope
- Any app UI or `src/**` change (error codes are unchanged; the Arabic `billing` text is already provider-neutral).
- Cloud sync (S5), account linking, migrations.
- Streaming, function calling, GigaChat v2 endpoint, `X-Session-ID` prompt caching.
- Building the Russian relay (D6 contingency, only if live verification fails).
- Deploying. The main session deploys after review (below). The owner sets secrets.
- Editing `CLAUDE.md` (D20).

## Risks / rollback
| Risk | Likelihood | Mitigation |
|---|---|---|
| GigaChat blocks non-Russian source IPs (Supabase runs in Frankfurt / edge) | Medium, unknown | The live check shows `provider_error_network`, or a 403 with an upstream message. Next step: the D6 relay in Russia. |
| Port 9443 outbound blocked from Supabase | Low | The OAuth phase log shows a connect error. Same contingency. |
| Hosted runtime rejects `createHttpClient` or the CA | Low (OSS runtime tests it) | Boot log `ca_client:false` or `UnknownIssuer`. Same contingency. Never disable TLS. |
| JSON quality on GigaChat (missing `words`, prose around JSON) | Medium | Parser tolerates prose. One repair. Measure the `invalid_output` / `ok_repaired` rate. Try `GIGACHAT_STRUCTURED=on`. |
| Topic refusals (politics, religion) | Medium | `refused` message already exists. Track the rate per topic. |
| Single stream gives 429 | Low (one learner) | One retry after 2 s, then the "busy" message. |
| Max bucket exhausted | Low at typical use | Model secret switch. `AI_DAILY_LIMIT=30`. |

**Rollback:** set the `AI_PROVIDER=anthropic` secret (immediate, no deploy; needs a funded key), or redeploy the
previous commit (`16a74df`) of the `ai` function. No data migration is involved.

## Live verification (after review, by main session + owner's key)
1. Deploy `ai` with **all** files: `ai/index.ts`, `ai/deno.json`, `_shared/ai-contract.js`, `_shared/handler.js`,
   `_shared/providers.js`, `_shared/russian-trusted-ca.js`, with `import_map_path: "deno.json"`.
2. Owner: certificate check (deploy doc), then set the secrets `AI_PROVIDER=gigachat` and `GIGACHAT_AUTH_KEY`.
3. Function logs: the boot line shows `provider:"gigachat"` and `ca_client:true`.
4. Owner opens the app → Chat → «ابدأ المحادثة». Expect `ai_requests.status = ok`, a `GigaChat-2-Max:<version>` model
   string, and token counts. On failure, read the `gigachat error` log line:
   - `phase:oauth` + network/`UnknownIssuer`: TLS / CA problem.
   - `phase:oauth` + 400/401: wrong key or scope.
   - `phase:chat` + 403: User-Agent or geo.
   - `phase:chat` + 404: model id.
   - 402: freemium not activated.
5. Quality pass: 3 scripted conversations (weather, food, a religion/philosophy topic), 8 turns each, plus evaluate.
   Record: `ok` vs `ok_repaired` vs `invalid_output`, `refused` count, the share of chat replies with ≥1 `words`
   entry (target ≥ 80%), corrections the owner judges correct, and median latency.
6. Repeat step 5 with `GIGACHAT_MODEL_CHAT=GigaChat-3-Ultra` and once with `GIGACHAT_STRUCTURED=on`. The owner keeps
   the best settings. Record the result in ADR 0003 as an addendum.

---

## Implementation report

**DONE:** Steps 1–8, all as specified.
- Step 1: vendored the 3 CA certs into `supabase/functions/_shared/russian-trusted-ca.js`, cross-checked against
  `qwerty-ll/CombinedPortal` commit `6cedeabee3e69a92e2382a887432158256c4a979` (matched exactly, no fallback needed).
  All three SHA-256 fingerprints verified independently with Node's `X509Certificate` before writing the constants,
  and match the plan's pinned values exactly.
- Step 2: added `PROVIDERS`, `DEFAULT_PROVIDER`, `GIGACHAT_DEFAULT_MODELS`, `GIGACHAT_TASK_SETTINGS`,
  `REPAIR_INSTRUCTION`, `buildRepairPrompt`, `buildGigaChatRequest` to `ai-contract.js`. Existing exports untouched.
- Step 3: new `_shared/providers.js` — `ProviderError`, `resolveGigaChatModels`, `normalizeGigaChat`,
  `createGigaChatProvider` (token cache, single-flight refresh, 401/429/5xx retry-once rules, CA-agnostic — it takes
  `fetch` as a dependency), `createAnthropicProvider`, `classifyAnthropicError`, `createProviderFromEnv`.
- Step 4: `handler.js` now takes `deps.provider` instead of `deps.callModel`/`deps.model`; added the one-shot JSON
  repair loop and `providerFail()` error mapping; removed the `buildModelRequest`/`responseText` imports from the
  handler (moved into `providers.js`'s Anthropic wrapper). CORS/method/auth/size/JSON/quota order unchanged.
- Step 5: `ai/index.ts` builds the GigaChat fetch wrapper (`Deno.createHttpClient({ caCerts })`, catch-and-fallback
  per D6), constructs the Anthropic SDK lazily inside `anthropicCreate`, wires `createProviderFromEnv`, logs one
  boot line, and passes `provider` to `createHandler` (removed `model`/`callModel`).
- Step 6: `.env.example` rewritten, GigaChat secrets first, Anthropic commented as the alternative.
- Step 7: `docs/adr/0003-gigachat-provider.md` (new), ADR 0002 status line amended, `docs/deploy-backend.md`
  rewritten (GigaChat steps 2b, certificate check, secrets table, new statuses, rollback), `docs/requirements.md`
  rows A1/S9 added and R2–R4/S1/S7/S8 evidence updated, `README.md` updated (provider, real test count).
- Step 8: all "Must pass" checks run (below).

**FILES CHANGED:**
- `supabase/functions/_shared/russian-trusted-ca.js` (new)
- `supabase/functions/_shared/providers.js` (new)
- `supabase/functions/_shared/ai-contract.js` (additions only)
- `supabase/functions/_shared/handler.js` (provider-based rewrite)
- `supabase/functions/ai/index.ts` (provider wiring, CA client, lazy Anthropic SDK)
- `supabase/functions/.env.example`
- `tests/gigachat.test.js` (new, 22 tests)
- `tests/backend.test.js` (adapted `setup()`/`setupGigaChat()`; added the GigaChat handler tests a–i)
- `docs/adr/0003-gigachat-provider.md` (new)
- `docs/adr/0002-ai-backend.md` (status line only)
- `docs/deploy-backend.md`
- `docs/requirements.md`
- `README.md`

**RAN / PASSED:**
- `npm test` → **101 tests passed, 0 failed** across 5 files (`ai-contract.test.js` 17, `domain.test.js` 28,
  `db.test.js` 6, `backend.test.js` 28 [19 pre-existing, adapted to the provider interface, same assertions, + 9 new
  in the "GigaChat provider" describe block], `gigachat.test.js` 22, all new).
- `npm run build` → built successfully (`dist/`).
- `cd supabase/functions/ai && deno check --config deno.json index.ts` (Deno 2.9.6, `/home/claude/probe/node_modules/deno/deno`)
  → passed, 0 errors (one round of fixes needed — see Deviations).
- `cd supabase/functions/ai && deno lint --config deno.json ..` → passed, 0 diagnostics (one round of fixes needed
  — see Deviations). Confirmed with `--json` that `checked_files`/`diagnostics` are empty, and separately verified
  by explicitly pointing lint at each `_shared/*.js` + `index.ts` file that only the two now-fixed issues ever
  existed; the exact plan command passes with exit 0.
- `git diff --stat -- package.json package-lock.json supabase/functions/ai/deno.json supabase/functions/ai/deno.lock src supabase/migrations`
  → empty, confirmed.
- `grep -rn "GIGACHAT_AUTH_KEY\|Authorization key" src/ .env.example` → no hits, confirmed (grep exit 1).

**NOT RUN:**
- `npx cap sync android` — correctly skipped per the plan ("not needed, no app change"); confirmed `src/**` is
  untouched (empty diff above covers it).
- Live verification section (deploy, real GigaChat key, live TLS handshake, quality pass) — explicitly out of scope
  for this implementer run; left for the main session + owner as the plan specifies. All GigaChat behaviour was
  exercised only through injected `fetch` mocks, per instructions (sandbox cannot reach `sberbank.ru`/`giga.chat`).

**DEVIATIONS:**
1. Two `deno lint` `require-await` findings had to be fixed that the plan's pseudocode did not anticipate:
   `getToken()` (no `await` in its body, since both branches already return promises/values directly) was changed
   from `async function` to a plain function returning `Promise.resolve(cache.token)` on the cache-hit path; and
   `notConfiguredProvider().complete()` (only ever throws, no `await`) was changed from `async complete() { throw }`
   to `complete() { return Promise.reject(...) }`. Behaviour is identical (both are still awaited fine by callers);
   this was needed only to satisfy the lint rule.
2. `deno check` initially failed: TypeScript widened `normalizeGigaChat`'s and `createAnthropicProvider`'s computed
   `stop` variable to `string` instead of the literal union `'end'|'refusal'|'max_tokens'` that `handler.js`'s JSDoc
   requires for `deps.provider.complete()`'s return type. Fixed by adding an explicit
   `/** @type {'end'|'refusal'|'max_tokens'} */` JSDoc annotation above each `const stop = ...` ternary in
   `providers.js`. No behavioural change.
3. Test-harness-only issue (not a product bug): my first draft of `tests/gigachat.test.js`'s token-refresh test used
   a small fake clock (`startNow = 1_000_000`), which is below the `1e12` threshold `createGigaChatProvider` uses to
   distinguish a GigaChat `expires_at` given in seconds from one given in milliseconds (D9). That made a legitimate
   millisecond `expires_at` from my own mock look like a seconds value and get multiplied by 1000, masking the
   refresh. Fixed by using a realistic epoch-scale `startNow` (`1_700_000_000_000`) in the test harness; the
   provider code was correct per the plan and needed no change.
4. `.claude/skills/` referenced by `CLAUDE.md` (`capacitor-*`, `supabase`, `claude-api`) does not exist in this
   checkout — confirmed before starting. Proceeded on the plan's own exhaustive specification, which already named
   the exact facts, decisions and algorithms (D1–D20), since the plan was authored by the CTO specifically to not
   require those skills' guidance for this backend-only change.
5. Everything else matches the plan's steps, decisions and file list exactly; no other deviations.

**FOUND, NOT FIXED (out of scope):**
- None observed beyond what the plan's own "Risks" table already names (GigaChat IP/geo-blocking, port 9443
  reachability, JSON quality, refusal rate — all explicitly deferred to live verification).

**QUESTIONS:** none — the plan's decisions (D1–D20) left no ambiguity that required a stop-and-report; the three
items above were mechanical fixes within the plan's own stated behaviour, not design decisions.

## Review
**Verdict: APPROVED** (cto, 2026-10-10), with one small fix applied during review. Nothing is committed yet.

**Re-run by the reviewer (not taken from the report):**
- `npm test`: 102 passed, 0 failed, 5 files. That is 101 from the implementer plus 1 regression test added in review.
- `npm run build`: ok.
- `deno check --config deno.json index.ts` (Deno 2.9.6): exit 0.
- `deno lint` on `_shared/{providers,handler,ai-contract,russian-trusted-ca}.js` and `ai/index.ts`: exit 0, 5 files.
  The plan's command `deno lint --config deno.json ..` reports "Checked 1 file" only, so this review lint-checked the
  files explicitly. The command in `.claude/agents/implementer.md` should be updated to the explicit file list
  (owner/main session).
- `git diff` of `package*.json`, `deno.json`, `deno.lock`, `src/` and `supabase/migrations/`: empty.
- `grep` for `unsafely`, `DENO_TLS_CA_STORE`, `rejectUnauthorized` and `NODE_TLS`: no hits.
- `grep` for GigaChat names in `src/`: no hits.

**Security:**
- CA scope: `Deno.createHttpClient` is used only by `gigachatFetch`. Supabase and Anthropic keep the default trust,
  and TLS verification is never disabled. If the client can't be built, the fallback is plain fetch, which still
  verifies.
- Certificates: the vendored root PEM is byte-identical to the cross-check copy. All three SHA-256 fingerprints
  were re-computed independently and match the pinned values.
- The auth key and access token never appear in logs or errors (tested). Learner and model text are never logged
  (tested). The app holds no key.

**AI contract:**
- Prompts, `SCHEMAS` and validators are unchanged. The GigaChat request has a single leading system message.
- The repair call is bounded (one call, 25 s gate, non-empty text, `end` only) and consumes no extra quota.
- The Anthropic path behaves as before (same body, same error mapping, no repair). The existing assertions were
  kept.

**Fix applied in review:**
- File: `providers.js` `readUpstreamMessage`.
- Problem: it fell back to logging the first 300 characters of a non-JSON error body. The plan allowed only the JSON
  `.message`, and an unknown body could echo request content.
- Fix: it now logs `non-json body (<n> chars)`.
- Regression test added in `tests/gigachat.test.js`. README test count updated to 102.

**Accepted, follow-up (P3):**
1. Worst-case latency can exceed the app's 60 s timeout. Example: first call ≈25 s, then a repair call that itself
   retries (≤15 s + 2 s + 25 s). The app then shows "timeout" and one quota unit is used; nothing breaks. Fix later
   by passing one absolute deadline from the handler into `complete()`.
2. The boot log re-parses `GIGACHAT_STRUCTURED` in `index.ts`, duplicating `providers.js`. Cosmetic.
3. The Anthropic SDK is still imported statically, so it loads at boot even on GigaChat. Harmless.

**Definition of Done:**
- Met for the code stage: implementation complete, tests and build pass, docs/ADR/requirements/runbook updated,
  rollback defined.
- Not yet done, by design: live verification (A1, S9, R2–R4 stay `IMPLEMENTED_NEEDS_FIX`) and the owner's
  certificate-fingerprint check before deploy.

**Deploy bundle for the `ai` function** (paths relative to `supabase/functions/`; entrypoint `ai/index.ts`;
`import_map_path: "deno.json"`, i.e. `ai/deno.json`):
- `ai/index.ts`
- `ai/deno.json`
- `_shared/ai-contract.js`
- `_shared/handler.js`
- `_shared/providers.js`
- `_shared/russian-trusted-ca.js`

Deploy before the owner sets `AI_PROVIDER`; the default is already `gigachat`. Until `GIGACHAT_AUTH_KEY` is set,
requests fail with `provider_not_configured` and the app shows "server". Recommended order: the owner sets the
secrets, then deploy. Then follow "Live verification" steps 3–6.
