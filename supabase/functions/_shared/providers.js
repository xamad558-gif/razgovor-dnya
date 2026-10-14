// Conversation providers: GigaChat (default) and Anthropic, behind one normalised interface
// (see handler.js). Runtime-agnostic: fetch, now, sleep and uuid are injected so this file is
// unit-tested in Node and used unchanged from Deno (ai/index.ts).
//
// Never logs: the GigaChat Authorization key, the access token, request bodies, or learner/model text.

import {
  DEFAULT_MODEL, DEFAULT_PROVIDER, GIGACHAT_DEFAULT_MODELS, OPENROUTER_DEFAULT_MODELS, OPENROUTER_REASONING_EFFORTS,
  buildGigaChatRequest, buildModelRequest, buildOpenRouterRequest, responseText,
} from './ai-contract.js';

export const GIGACHAT_AUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
export const GIGACHAT_BASE_URL = 'https://api.giga.chat/v1';
export const GIGACHAT_SCOPE = 'GIGACHAT_API_PERS';
export const USER_AGENT = 'razgovor-dnya/0.1';
export const TIMEOUTS = { oauthMs: 10_000, chatMs: 25_000 };
export const RETRY = { delayMs: 2_000, ifElapsedUnderMs: 15_000 };
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_TIMEOUT_MS = 50_000;
export const OPENROUTER_HEADERS_STATIC = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'HTTP-Referer': 'https://xamad558-gif.github.io/razgovor-dnya/',
  'X-OpenRouter-Title': 'Razgovor dnya',
  'X-OpenRouter-App-Visibility': 'hidden',
};
const OPENROUTER_MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

const RETRYABLE_CHAT_STATUSES = [429, 500, 502, 503, 504];
const UNAVAILABLE_STATUSES = [429, 503];

export class ProviderError extends Error {
  constructor(code, { status = 0, logStatus, message } = {}) {
    super(message || code);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.logStatus = logStatus || `provider_error_${status || 'unknown'}`;
  }
}

function isHttpsUrl(v) {
  if (typeof v !== 'string' || !v) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

function resolveUrl(candidate, fallback, name, log) {
  if (!candidate) return fallback;
  if (isHttpsUrl(candidate)) return candidate;
  log({ level: 'error', msg: 'gigachat invalid url override ignored', name });
  return fallback;
}

/** chat/evaluate/topic → model id. env: (name) => string|undefined */
export function resolveGigaChatModels(env) {
  const trimmed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const general = trimmed(env('GIGACHAT_MODEL'));
  return {
    chat: trimmed(env('GIGACHAT_MODEL_CHAT')) || general || GIGACHAT_DEFAULT_MODELS.chat,
    evaluate: trimmed(env('GIGACHAT_MODEL_EVALUATE')) || general || GIGACHAT_DEFAULT_MODELS.evaluate,
    topic: trimmed(env('GIGACHAT_MODEL_TOPIC')) || general || GIGACHAT_DEFAULT_MODELS.topic,
  };
}

/** GigaChat JSON → normalised result (D13). */
export function normalizeGigaChat(json, requestedModel) {
  const choice = json?.choices?.[0];
  const fr = choice?.finish_reason;
  /** @type {'end'|'refusal'|'max_tokens'} */
  const stop = fr === 'length' ? 'max_tokens' : fr === 'blacklist' ? 'refusal' : 'end';
  const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  const model = typeof json?.model === 'string' && json.model ? json.model : requestedModel;
  const inputTokens = typeof json?.usage?.prompt_tokens === 'number' ? json.usage.prompt_tokens : null;
  const outputTokens = typeof json?.usage?.completion_tokens === 'number' ? json.usage.completion_tokens : null;
  return { model, stop, text, inputTokens, outputTokens };
}

async function readUpstreamMessage(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return '';
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.message === 'string') return parsed.message.slice(0, 300);
  } catch {
    /* not JSON */
  }
  // Never log an unknown raw body (it could echo request content); only its size.
  return `non-json body (${text.length} chars)`;
}

function classifyFetchError(e, phase, log, label = 'gigachat error') {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return new ProviderError('timeout', { logStatus: 'provider_error_timeout' });
  }
  log({
    level: 'error', msg: label, phase,
    error_name: e?.name ?? null,
    error_message: String(e?.message ?? e).slice(0, 300),
  });
  return new ProviderError('server', { logStatus: 'provider_error_network' });
}

function finalChatError(status) {
  if (status === 402) return new ProviderError('billing', { status, logStatus: 'provider_billing' });
  if (UNAVAILABLE_STATUSES.includes(status)) return new ProviderError('unavailable', { status, logStatus: `provider_error_${status}` });
  return new ProviderError('server', { status, logStatus: `provider_error_${status}` });
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
  const log = o.log || ((e) => console.error(JSON.stringify(e)));
  const scope = o.scope || GIGACHAT_SCOPE;
  const authKey = String(o.authKey || '').trim().replace(/^basic\s+/i, '');
  const authUrl = resolveUrl(o.authUrl, GIGACHAT_AUTH_URL, 'GIGACHAT_AUTH_URL', log);
  const baseUrl = resolveUrl(o.baseUrl, GIGACHAT_BASE_URL, 'GIGACHAT_BASE_URL', log);
  const fetchImpl = o.fetch;
  const now = o.now || (() => Date.now());
  const sleep = o.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const uuid = o.uuid || (() => crypto.randomUUID());
  const models = o.models;
  const structured = !!o.structured;

  let cache = null; // { token, expiresAt }
  let pending = null;

  async function fetchToken() {
    let res;
    try {
      res = await fetchImpl(authUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authKey}`,
          RqUID: uuid(),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({ scope }).toString(),
        signal: AbortSignal.timeout(TIMEOUTS.oauthMs),
      });
    } catch (e) {
      throw classifyFetchError(e, 'oauth', log);
    }
    if (!res.ok) {
      const upstream_message = await readUpstreamMessage(res);
      log({ level: 'error', msg: 'gigachat error', phase: 'oauth', status: res.status, upstream_message });
      throw new ProviderError('server', { status: res.status, logStatus: `provider_error_oauth_${res.status}` });
    }
    let json;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!json || typeof json.access_token !== 'string') {
      log({ level: 'error', msg: 'gigachat error', phase: 'oauth', status: res.status, upstream_message: 'missing access_token' });
      throw new ProviderError('server', { status: res.status, logStatus: 'provider_error_oauth_invalid' });
    }
    let expiresAt = Number(json.expires_at);
    if (!Number.isFinite(expiresAt)) expiresAt = now() + 25 * 60 * 1000;
    else if (expiresAt < 1e12) expiresAt *= 1000;
    return { token: json.access_token, expiresAt };
  }

  function getToken() {
    if (cache && cache.expiresAt - now() > TOKEN_REFRESH_MARGIN_MS) return Promise.resolve(cache.token);
    if (!pending) {
      pending = fetchToken()
        .then((c) => {
          cache = c;
          return c.token;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  async function doChat(token, requestId, body) {
    try {
      return await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'X-Request-ID': requestId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUTS.chatMs),
      });
    } catch (e) {
      throw classifyFetchError(e, 'chat', log);
    }
  }

  async function complete(req, ctx = {}) {
    const { requestId, repairOf } = ctx;
    const t0 = now();
    const model = models[req.task];
    const body = buildGigaChatRequest(req, model, { structured, repairOf });

    let token = await getToken();
    let res = await doChat(token, requestId, body);
    let retried = false;

    while (!res.ok && !retried) {
      if (res.status === 401) {
        retried = true;
        if (cache && cache.token === token) cache = null;
        token = await getToken();
        res = await doChat(token, requestId, body);
        continue;
      }
      if (RETRYABLE_CHAT_STATUSES.includes(res.status) && now() - t0 < RETRY.ifElapsedUnderMs) {
        retried = true;
        await sleep(RETRY.delayMs);
        res = await doChat(token, requestId, body);
        continue;
      }
      break;
    }

    if (!res.ok) {
      const upstream_request_id = res.headers.get('x-request-id');
      const upstream_message = await readUpstreamMessage(res);
      log({
        level: 'error', msg: 'gigachat error', phase: 'chat', status: res.status,
        request_id: requestId, upstream_request_id, upstream_message,
      });
      throw finalChatError(res.status);
    }

    let json;
    try {
      json = await res.json();
    } catch {
      throw new ProviderError('invalid_response', { status: 200, logStatus: 'provider_bad_body' });
    }
    return normalizeGigaChat(json, model);
  }

  return {
    name: 'gigachat',
    repairInvalidJson: true,
    modelFor: (task) => models[task],
    complete,
  };
}

/** Anthropic SDK wrapper; create = (body) => anthropic.beta.messages.create(body). Behaviour identical to today. */
export function createAnthropicProvider({ create, model = DEFAULT_MODEL }) {
  return {
    name: 'anthropic',
    repairInvalidJson: false,
    modelFor: () => model,
    async complete(req) {
      const body = buildModelRequest(req, model);
      let msg;
      try {
        msg = await create(body);
      } catch (e) {
        throw classifyAnthropicError(e);
      }
      /** @type {'end'|'refusal'|'max_tokens'} */
      const stop = msg?.stop_reason === 'refusal' ? 'refusal' : msg?.stop_reason === 'max_tokens' ? 'max_tokens' : 'end';
      return {
        model: msg?.model || model,
        stop,
        text: responseText(msg),
        inputTokens: msg?.usage?.input_tokens ?? null,
        outputTokens: msg?.usage?.output_tokens ?? null,
      };
    },
  };
}

export function classifyAnthropicError(e) {
  const status = Number(e?.status) || 0;
  if (e?.code === 'timeout' || e?.name === 'APIConnectionTimeoutError') {
    return new ProviderError('timeout', { status, logStatus: 'provider_error_' + (status || 'timeout') });
  }
  const providerMsg = String(e?.error?.error?.message ?? e?.message ?? '');
  if (/credit balance|billing/i.test(providerMsg)) {
    return new ProviderError('billing', { status, logStatus: 'provider_billing' });
  }
  if (status === 429 || status === 529 || status === 503) {
    return new ProviderError('unavailable', { status, logStatus: 'provider_error_' + (status || e?.code || 'unknown') });
  }
  return new ProviderError('server', { status, logStatus: 'provider_error_' + (status || e?.code || 'unknown') });
}

// ---------- OpenRouter ----------

/** Comma list → validated, deduped, capped-at-3 model id array, or null (caller falls back). Logs drops/caps. */
function parseModelList(raw, log) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = [];
  const invalid = [];
  for (const p of parts) {
    if (OPENROUTER_MODEL_ID_RE.test(p)) valid.push(p);
    else invalid.push(p);
  }
  // Log only the count: a secret pasted into the wrong variable (e.g. the API key) must never reach the logs.
  if (invalid.length) log({ level: 'error', msg: 'openrouter invalid model id dropped', count: invalid.length });
  const deduped = [...new Set(valid)];
  if (!deduped.length) return null;
  if (deduped.length > 3) {
    log({ level: 'error', msg: 'openrouter model list capped at 3', dropped: deduped.length - 3 });
    return deduped.slice(0, 3);
  }
  return deduped;
}

/** chat/evaluate/topic → model id array, primary first (O5). env: (name) => string|undefined */
export function resolveOpenRouterModels(env, log) {
  const general = parseModelList(env('OPENROUTER_MODELS'), log) || OPENROUTER_DEFAULT_MODELS;
  return {
    chat: parseModelList(env('OPENROUTER_MODEL_CHAT'), log) || general,
    evaluate: parseModelList(env('OPENROUTER_MODEL_EVALUATE'), log) || general,
    topic: parseModelList(env('OPENROUTER_MODEL_TOPIC'), log) || general,
  };
}

/** AI_PROVIDER=openrouter reasoning effort (O7). Invalid value logs once and falls back to 'low'. */
function resolveOpenRouterReasoning(env, log) {
  const raw = String(env('OPENROUTER_REASONING') || '').trim().toLowerCase();
  if (!raw) return 'low';
  if (OPENROUTER_REASONING_EFFORTS.includes(raw)) return raw;
  log({ level: 'error', msg: 'openrouter invalid reasoning effort, using low', value: raw });
  return 'low';
}

/** Is this 429 the account-wide daily cap (O12)? headers: Headers-like with .get(), or null. */
function isOpenRouterDailyLimit(err, headers, nowMs) {
  if (/per-day/i.test(String(err?.message || ''))) return true;
  const remaining = headers && typeof headers.get === 'function' ? headers.get('x-ratelimit-remaining') : null;
  const resetRaw = headers && typeof headers.get === 'function' ? headers.get('x-ratelimit-reset') : null;
  if (remaining === '0' && resetRaw != null) {
    let resetMs = Number(resetRaw);
    if (Number.isFinite(resetMs)) {
      if (resetMs < 1e12) resetMs *= 1000; // given in seconds
      if (resetMs - nowMs > 120_000) return true;
    }
  }
  return false;
}

/** HTTP status (or error.code for an in-body error) + err {code,message,metadata} + headers → ProviderError (O11/O12/O17). */
export function classifyOpenRouterError(status, err, headers, nowMs) {
  const message = String(err?.message || '');
  const metadata = err?.metadata;
  if (status === 400) return new ProviderError('server', { status, logStatus: 'provider_error_400' });
  if (status === 401) return new ProviderError('server', { status, logStatus: 'provider_error_401' });
  if (status === 402) return new ProviderError('billing', { status, logStatus: 'provider_billing' });
  if (status === 403) {
    if ((Array.isArray(metadata?.reasons) && metadata.reasons.length) || /moderat|flagged/i.test(message)) {
      return new ProviderError('refused', { status, logStatus: 'provider_moderation' });
    }
    return new ProviderError('server', { status, logStatus: 'provider_error_403' });
  }
  if (status === 404) {
    if (/data policy/i.test(message)) return new ProviderError('server', { status, logStatus: 'provider_data_policy' });
    return new ProviderError('server', { status, logStatus: 'provider_error_404' });
  }
  if (status === 408) return new ProviderError('timeout', { status, logStatus: 'provider_error_408' });
  if (status === 429) {
    if (isOpenRouterDailyLimit(err, headers, nowMs)) return new ProviderError('quota_exceeded', { status, logStatus: 'provider_quota_day' });
    return new ProviderError('unavailable', { status, logStatus: 'provider_error_429' });
  }
  if (status === 502 || status === 503 || status === 529) {
    return new ProviderError('unavailable', { status, logStatus: `provider_error_${status}` });
  }
  return new ProviderError('server', { status, logStatus: `provider_error_${status || 'unknown'}` });
}

/** OK 200 body (no top-level or choice error) → normalised result (O10). */
export function normalizeOpenRouter(json, requestedModel) {
  const choice = json?.choices?.[0];
  const fr = choice?.finish_reason;
  /** @type {'end'|'refusal'|'max_tokens'} */
  const stop = fr === 'length' ? 'max_tokens' : fr === 'content_filter' ? 'refusal' : 'end';
  let text = '';
  const content = choice?.message?.content;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
  }
  const model = typeof json?.model === 'string' && json.model ? json.model : requestedModel;
  const inputTokens = typeof json?.usage?.prompt_tokens === 'number' ? json.usage.prompt_tokens : null;
  const outputTokens = typeof json?.usage?.completion_tokens === 'number' ? json.usage.completion_tokens : null;
  return { model, stop, text, inputTokens, outputTokens };
}

/** Read a non-OK response's `{error:{...}}` body. Never returns the raw body text (O13). */
async function readOpenRouterError(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object') return parsed.error;
  } catch {
    /* not JSON */
  }
  return { message: `non-json body (${text.length} chars)` };
}

/** Whitelisted log fields only (O13): never flagged_input, metadata.raw, bodies, model/learner text or the key. */
function openRouterErrorLogEntry(status, err, requestId, isModeration) {
  const reasons = (Array.isArray(err?.metadata?.reasons) ? err.metadata.reasons : [])
    .filter((r) => typeof r === 'string')
    .map((r) => r.slice(0, 60))
    .slice(0, 5);
  const entry = {
    level: 'error', msg: 'openrouter error', status,
    request_id: requestId ?? null,
    error_code: err?.code ?? null,
    error_type: err?.metadata?.error_type ?? null,
    provider_name: err?.metadata?.provider_name ?? null,
    model_slug: err?.metadata?.model_slug ?? null,
    reasons,
  };
  if (!isModeration) entry.upstream_message = typeof err?.message === 'string' ? err.message.slice(0, 300) : null;
  return entry;
}

/**
 * @param {object} o
 * @param {string} o.apiKey  OpenRouter key (trim; strip a leading "Bearer ")
 * @param {{chat:string[], evaluate:string[], topic:string[]}} o.models
 * @param {string} [o.reasoning]  default 'low'
 * @param {(url:string, init:RequestInit)=>Promise<Response>} o.fetch
 * @param {() => number} [o.now]
 * @param {(entry:object)=>void} [o.log]
 */
export function createOpenRouterProvider(o) {
  const log = o.log || ((e) => console.error(JSON.stringify(e)));
  const apiKey = String(o.apiKey || '').trim().replace(/^bearer\s+/i, '');
  const models = o.models;
  const reasoning = o.reasoning || 'low';
  const fetchImpl = o.fetch;
  const now = o.now || (() => Date.now());

  async function complete(req, ctx = {}) {
    const { requestId } = ctx;
    const modelList = models[req.task];
    const body = buildOpenRouterRequest(req, modelList, { reasoning });

    let res;
    try {
      res = await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, ...OPENROUTER_HEADERS_STATIC },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
      });
    } catch (e) {
      throw classifyFetchError(e, 'chat', log, 'openrouter error');
    }

    if (!res.ok) {
      const err = await readOpenRouterError(res);
      const classified = classifyOpenRouterError(res.status, err, res.headers, now());
      log(openRouterErrorLogEntry(res.status, err, requestId, classified.logStatus === 'provider_moderation'));
      throw classified;
    }

    let json;
    try {
      json = await res.json();
    } catch {
      throw new ProviderError('invalid_response', { status: 200, logStatus: 'provider_bad_body' });
    }

    if (json && json.error && typeof json.error === 'object') {
      const err = json.error;
      const status = Number(err.code) || 0;
      const classified = classifyOpenRouterError(status, err, null, now());
      log(openRouterErrorLogEntry(status, err, requestId, classified.logStatus === 'provider_moderation'));
      throw classified;
    }

    const choice0 = json?.choices?.[0];
    if (choice0?.error || choice0?.finish_reason === 'error') {
      const err = choice0?.error || {};
      let classified;
      if (err.code != null) {
        classified = classifyOpenRouterError(Number(err.code) || 0, err, null, now());
      } else {
        classified = new ProviderError('server', { status: 0, logStatus: 'provider_error_choice' });
      }
      log(openRouterErrorLogEntry(Number(err.code) || 0, err, requestId, classified.logStatus === 'provider_moderation'));
      throw classified;
    }

    return normalizeOpenRouter(json, modelList[0]);
  }

  return {
    name: 'openrouter',
    repairInvalidJson: false,
    modelFor: (task) => models[task][0],
    reasoning,
    complete,
  };
}

function notConfiguredProvider(name) {
  return {
    name,
    repairInvalidJson: false,
    modelFor: () => null,
    complete() {
      return Promise.reject(new ProviderError('server', { status: 500, logStatus: 'provider_not_configured' }));
    },
  };
}

/**
 * env: (name)=>string|undefined. deps: { openrouterFetch, gigachatFetch, anthropicCreate, log, now?, sleep?, uuid? }
 * AI_PROVIDER unset/'' → 'openrouter'. 'openrouter' needs OPENROUTER_API_KEY; 'gigachat' needs GIGACHAT_AUTH_KEY;
 * 'anthropic' needs ANTHROPIC_API_KEY.
 * Unknown provider or missing key → { name, repairInvalidJson:false, modelFor:()=>null, complete: throws
 *   ProviderError('server', {status:500, logStatus:'provider_not_configured'}) }, and log once
 *   {level:'error', msg:'ai provider not configured', provider, missing:'OPENROUTER_API_KEY'|'GIGACHAT_AUTH_KEY'|'ANTHROPIC_API_KEY'|'AI_PROVIDER'}.
 * GIGACHAT_STRUCTURED: 'on'|'true'|'1' (case-insensitive) → structured true; anything else false.
 */
export function createProviderFromEnv(env, deps) {
  const log = deps.log || ((e) => console.error(JSON.stringify(e)));
  const raw = (env('AI_PROVIDER') || '').trim().toLowerCase();
  const providerName = raw || DEFAULT_PROVIDER;

  if (providerName === 'openrouter') {
    const apiKey = env('OPENROUTER_API_KEY');
    if (!apiKey) {
      log({ level: 'error', msg: 'ai provider not configured', provider: providerName, missing: 'OPENROUTER_API_KEY' });
      return notConfiguredProvider(providerName);
    }
    return createOpenRouterProvider({
      apiKey,
      models: resolveOpenRouterModels(env, log),
      reasoning: resolveOpenRouterReasoning(env, log),
      fetch: deps.openrouterFetch,
      now: deps.now,
      log,
    });
  }

  if (providerName === 'gigachat') {
    const authKey = env('GIGACHAT_AUTH_KEY');
    if (!authKey) {
      log({ level: 'error', msg: 'ai provider not configured', provider: providerName, missing: 'GIGACHAT_AUTH_KEY' });
      return notConfiguredProvider(providerName);
    }
    const structuredRaw = (env('GIGACHAT_STRUCTURED') || '').trim().toLowerCase();
    const structured = structuredRaw === 'on' || structuredRaw === 'true' || structuredRaw === '1';
    return createGigaChatProvider({
      authKey,
      scope: env('GIGACHAT_SCOPE'),
      models: resolveGigaChatModels(env),
      structured,
      fetch: deps.gigachatFetch,
      authUrl: env('GIGACHAT_AUTH_URL'),
      baseUrl: env('GIGACHAT_BASE_URL'),
      now: deps.now,
      sleep: deps.sleep,
      uuid: deps.uuid,
      log,
    });
  }

  if (providerName === 'anthropic') {
    const apiKey = env('ANTHROPIC_API_KEY');
    if (!apiKey) {
      log({ level: 'error', msg: 'ai provider not configured', provider: providerName, missing: 'ANTHROPIC_API_KEY' });
      return notConfiguredProvider(providerName);
    }
    return createAnthropicProvider({ create: deps.anthropicCreate, model: env('AI_MODEL') || DEFAULT_MODEL });
  }

  log({ level: 'error', msg: 'ai provider not configured', provider: providerName, missing: 'AI_PROVIDER' });
  return notConfiguredProvider(providerName);
}
