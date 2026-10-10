// HTTP handler for the "ai" function, written against injected dependencies
// so it runs unchanged in Deno (production) and in Node (unit tests).
//
// Flow: CORS → method → auth → size → JSON → validate → quota → provider →
//       refusal check → parse → validate → (one repair call on bad JSON) → log → respond.
// Never logs learner or model text: only ids, task, model, tokens, timing.

import { validateRequest, parseModelJson, VALIDATORS, AIContractError, ERRORS } from './ai-contract.js';

export const MAX_BODY_BYTES = 32 * 1024;
export const REPAIR_IF_ELAPSED_UNDER_MS = 25_000;

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

function sumTokens(a, b) {
  if (a == null && b == null) return null;
  return (a || 0) + (b || 0);
}

/**
 * @param {object} deps
 * @param {string[]} deps.allowedOrigins
 * @param {(req: Request) => Promise<string|null>} deps.authenticate  user id or null
 * @param {(userId: string, limit: number) => Promise<number|null>} deps.consumeQuota  new count, or null when over the limit
 * @param {{ name: string, repairInvalidJson: boolean, modelFor(task: string): string|null, complete(req: object, ctx?: { requestId?: string, repairOf?: string }): Promise<{ model: string, stop: 'end'|'refusal'|'max_tokens', text: string, inputTokens: number|null, outputTokens: number|null }> }} deps.provider
 * @param {(entry: Record<string, any>) => Promise<void>} deps.log
 * @param {number} deps.dailyLimit
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

    entry.model = deps.provider.modelFor(req.task);
    const call = (repairOf) => deps.provider.complete(req, { requestId, repairOf });

    function providerFail(e) {
      const code = e?.name === 'ProviderError' && ERRORS[e.code] ? e.code : 'server';
      entry.status = e?.logStatus || 'provider_error_unknown';
      return fail(code, origin, requestId);
    }

    let result;
    try {
      result = await call();
    } catch (e) {
      return finish(providerFail(e));
    }
    entry.input_tokens = result.inputTokens ?? null;
    entry.output_tokens = result.outputTokens ?? null;
    entry.model = result.model || entry.model;

    if (result.stop === 'refusal') {
      entry.status = 'refused';
      return finish(fail('refused', origin, requestId));
    }
    if (result.stop === 'max_tokens') {
      entry.status = 'truncated';
      return finish(fail('invalid_response', origin, requestId, 'response truncated'));
    }

    let data;
    try {
      data = VALIDATORS[req.task](parseModelJson(result.text));
      entry.status = 'ok';
    } catch {
      if (deps.provider.repairInvalidJson && result.stop === 'end' && result.text && now() - started < REPAIR_IF_ELAPSED_UNDER_MS) {
        let r2;
        try {
          r2 = await call(result.text);
        } catch (e) {
          return finish(providerFail(e));
        }
        entry.input_tokens = sumTokens(entry.input_tokens, r2.inputTokens);
        entry.output_tokens = sumTokens(entry.output_tokens, r2.outputTokens);
        entry.model = r2.model || entry.model;
        if (r2.stop === 'refusal') {
          entry.status = 'refused';
          return finish(fail('refused', origin, requestId));
        }
        if (r2.stop === 'max_tokens') {
          entry.status = 'truncated';
          return finish(fail('invalid_response', origin, requestId, 'response truncated'));
        }
        try {
          data = VALIDATORS[req.task](parseModelJson(r2.text));
          entry.status = 'ok_repaired';
        } catch {
          entry.status = 'invalid_output';
          return finish(fail('invalid_response', origin, requestId));
        }
      } else {
        entry.status = 'invalid_output';
        return finish(fail('invalid_response', origin, requestId));
      }
    }
    return finish(json(200, { data, request_id: requestId, quota: { used, limit: deps.dailyLimit } }, origin));
  };
}
