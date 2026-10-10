// HTTP handler for the "ai" function, written against injected dependencies
// so it runs unchanged in Deno (production) and in Node (unit tests).
//
// Flow: CORS → method → auth → size → JSON → validate → quota → model →
//       refusal check → parse → validate → log → respond.
// Never logs learner or model text: only ids, task, model, tokens, timing.

import {
  validateRequest, buildModelRequest, responseText, parseModelJson, VALIDATORS, AIContractError, ERRORS,
} from './ai-contract.js';

export const MAX_BODY_BYTES = 32 * 1024;

// Origins allowed to call the function from a browser/WebView:
// the published web app (GitHub Pages), the iOS (custom scheme) and Android (https) Capacitor
// shells, and localhost dev servers for `npm run dev` / `vite preview`.
export const DEFAULT_ALLOWED_ORIGINS = [
  'https://xamad558-gif.github.io',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost:5173',
  'http://localhost:4173',
];

/**
 * @param {object} deps
 * @param {string[]} deps.allowedOrigins
 * @param {(req: Request) => Promise<string|null>} deps.authenticate  user id or null
 * @param {(userId: string, limit: number) => Promise<number|null>} deps.consumeQuota  new count, or null when over the limit
 * @param {(body: Record<string, any>) => Promise<any>} deps.callModel  Messages API response; throws {status, code?} on provider errors
 * @param {(entry: Record<string, any>) => Promise<void>} deps.log
 * @param {number} deps.dailyLimit
 * @param {string} deps.model
 * @param {() => string} deps.requestId
 * @param {() => number} [deps.now]
 */
export function createHandler(deps) {
  const now = deps.now || (() => Date.now());

  function cors(origin) {
    const h = { Vary: 'Origin' };
    if (origin && deps.allowedOrigins.includes(origin)) {
      h['Access-Control-Allow-Origin'] = origin;
      h['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type, x-client-info';
      h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
      h['Access-Control-Max-Age'] = '86400';
    }
    return h;
  }

  function json(status, payload, origin) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(origin) },
    });
  }

  function fail(code, origin, requestId, message) {
    const e = ERRORS[code] || ERRORS.server;
    return json(e.status, { code, message: message || code, retryable: e.retryable, request_id: requestId }, origin);
  }

  return async function handle(request) {
    const origin = request.headers.get('origin');
    const requestId = deps.requestId();
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST') return fail('method_not_allowed', origin, requestId);

    const started = now();
    const entry = { request_id: requestId, user_id: null, task: null, model: null, status: 'started', input_tokens: null, output_tokens: null, latency_ms: null };
    const finish = async (response) => {
      entry.latency_ms = now() - started;
      if (entry.task) {
        try { await deps.log(entry); } catch { /* logging must never break the request */ }
      }
      return response;
    };

    let userId;
    try {
      userId = await deps.authenticate(request);
    } catch {
      userId = null;
    }
    if (!userId) return fail('unauthorized', origin, requestId);
    entry.user_id = userId;

    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return fail('payload_too_large', origin, requestId);

    let req;
    try {
      req = validateRequest(JSON.parse(raw));
    } catch (e) {
      return fail('invalid_request', origin, requestId, e instanceof AIContractError ? e.message : 'malformed JSON');
    }
    entry.task = req.task;

    let used;
    try {
      used = await deps.consumeQuota(userId, deps.dailyLimit);
    } catch {
      entry.status = 'quota_error';
      return finish(fail('unavailable', origin, requestId));
    }
    if (used === null || used === undefined) {
      entry.status = 'quota_exceeded';
      return finish(fail('quota_exceeded', origin, requestId, `daily limit of ${deps.dailyLimit} requests reached`));
    }

    const body = buildModelRequest(req, deps.model);
    entry.model = body.model;
    let message;
    try {
      message = await deps.callModel(body);
    } catch (e) {
      const status = Number(e?.status) || 0;
      entry.status = 'provider_error_' + (status || e?.code || 'unknown');
      if (e?.code === 'timeout' || e?.name === 'APIConnectionTimeoutError') return finish(fail('timeout', origin, requestId));
      if (status === 429 || status === 529 || status === 503) return finish(fail('unavailable', origin, requestId));
      return finish(fail('server', origin, requestId));
    }
    entry.model = message?.model || entry.model;
    entry.input_tokens = message?.usage?.input_tokens ?? null;
    entry.output_tokens = message?.usage?.output_tokens ?? null;

    if (message?.stop_reason === 'refusal') {
      entry.status = 'refused';
      return finish(fail('refused', origin, requestId));
    }
    if (message?.stop_reason === 'max_tokens') {
      entry.status = 'truncated';
      return finish(fail('invalid_response', origin, requestId, 'response truncated'));
    }

    let data;
    try {
      data = VALIDATORS[req.task](parseModelJson(responseText(message)));
    } catch {
      entry.status = 'invalid_output';
      return finish(fail('invalid_response', origin, requestId));
    }
    entry.status = 'ok';
    return finish(json(200, { data, request_id: requestId, quota: { used, limit: deps.dailyLimit } }, origin));
  };
}
