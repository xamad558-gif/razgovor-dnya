import { VALIDATORS, AIContractError } from '../shared/ai-contract.js';

// The app NEVER holds an AI provider key. It calls our backend function,
// which holds the key, owns the prompts, and rate-limits per user.
// The endpoint and publishable key are public values by design.

const cfg = {
  endpoint: '',
  publishableKey: '',
  getToken: async () => '', // returns the user's access token (see auth/session.js)
};

const SERVER_CODES = ['invalid_request', 'unauthorized', 'payload_too_large', 'refused', 'quota_exceeded', 'server', 'invalid_response', 'unavailable', 'timeout'];

export function configureAI(overrides) {
  Object.assign(cfg, overrides);
}

export function aiConfigured() {
  return !!cfg.endpoint;
}

/**
 * Call the backend for one AI task and return the validated payload.
 * Rejects with AIContractError whose `code` is one of:
 * not_configured | offline | timeout | network | rate_limited | quota_exceeded |
 * unauthorized | refused | payload_too_large | invalid_request | server | unavailable | invalid_response
 */
export async function requestAI(task, payload, { timeoutMs = 60000, fetchImpl = globalThis.fetch } = {}) {
  if (!cfg.endpoint) throw new AIContractError('not_configured');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new AIContractError('offline');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const headers = { 'Content-Type': 'application/json' };
  let token;
  try {
    token = await cfg.getToken();
  } catch (e) {
    clearTimeout(timer);
    throw e instanceof AIContractError ? e : new AIContractError(navigator?.onLine === false ? 'offline' : 'unauthorized');
  }
  if (token) headers.Authorization = 'Bearer ' + token;
  if (cfg.publishableKey) headers.apikey = cfg.publishableKey;
  let res;
  try {
    res = await fetchImpl(cfg.endpoint, { method: 'POST', headers, body: JSON.stringify({ task, ...payload }), signal: ctl.signal });
  } catch {
    throw new AIContractError(ctl.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let code = null;
    try {
      const err = await res.json();
      if (err && SERVER_CODES.includes(err.code)) code = err.code;
    } catch { /* non-JSON error body (gateway); fall back to status */ }
    if (!code) {
      if (res.status === 429) code = 'rate_limited';
      else if (res.status === 401 || res.status === 403) code = 'unauthorized';
      else if (res.status >= 500) code = 'server';
      else code = 'invalid_request';
    }
    throw new AIContractError(code);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new AIContractError('invalid_response');
  }
  return VALIDATORS[task](body && body.data !== undefined ? body.data : body);
}

export const AI_ERROR_AR = {
  not_configured: 'المحادثة تحتاج ربط الخادم أولًا. البطاقات والمراجعة تعمل الآن بدون إنترنت.',
  offline: 'لا يوجد اتصال بالإنترنت. اتصل ثم أعد المحاولة، ورسالتك محفوظة.',
  timeout: 'استغرق الرد وقتًا طويلًا فأوقفته. أعد المحاولة.',
  network: 'انقطع الاتصال قبل وصول الرد. أعد المحاولة، ورسالتك محفوظة.',
  rate_limited: 'أرسلت بسرعة كبيرة. انتظر قليلًا ثم أعد المحاولة.',
  quota_exceeded: 'وصلت إلى حد الرسائل لهذا اليوم. البطاقات والمراجعة متاحة، وتعود المحادثة غدًا.',
  refused: 'لا أستطيع المتابعة في هذه الجملة. جرّب صياغة أخرى أو موضوعًا آخر.',
  payload_too_large: 'الرسالة طويلة جدًا. اختصرها ثم أرسلها.',
  unavailable: 'الخدمة مزدحمة الآن. أعد المحاولة بعد دقيقة.',
  unauthorized: 'انتهت جلستك. أعد فتح التطبيق ثم حاول مرة أخرى.',
  invalid_request: 'الطلب غير صالح. أعد المحاولة.',
  server: 'الخادم لا يستجيب الآن. أعد المحاولة بعد قليل.',
  invalid_response: 'وصل الرد ناقصًا. أعد المحاولة.',
};
