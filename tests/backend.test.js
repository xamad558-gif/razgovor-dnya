import { describe, it, expect, vi } from 'vitest';
import { createHandler, MAX_BODY_BYTES, DEFAULT_ALLOWED_ORIGINS } from '../supabase/functions/_shared/handler.js';
import { buildModelRequest, validateRequest, SCHEMAS, responseText } from '../supabase/functions/_shared/ai-contract.js';
import { requestAI, configureAI } from '../src/ai/client.js';

const topic = { ru: 'Погода', ar: 'الطقس', who: 'Аня', role: 'جارة', en: 'Anya chats about weather.' };
const ORIGIN = 'https://localhost';
const chatOk = { reply: 'Привет! Как дела?', reply_ar: 'مرحبا', words: [{ ru: 'дела', ar: 'أحوال', kind: 'noun', info: 'جمع' }], correction: null, hints: [{ ru: 'Хорошо', ar: 'جيد' }] };
const modelMsg = (obj, extra = {}) => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 120, output_tokens: 80 }, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }], ...extra });

function setup(over = {}) {
  const logs = [];
  const deps = {
    allowedOrigins: [ORIGIN],
    authenticate: vi.fn(async (req) => (req.headers.get('authorization') === 'Bearer good' ? 'user-1' : null)),
    consumeQuota: vi.fn(async () => 1),
    callModel: vi.fn(async () => modelMsg(chatOk)),
    log: vi.fn(async (e) => { logs.push(e); }),
    dailyLimit: 60,
    model: 'claude-opus-5-5',
    requestId: () => 'req-1',
    now: (() => { let t = 1000; return () => (t += 5); })(),
    ...over,
  };
  return { handle: createHandler(deps), deps, logs };
}
const post = (body, { auth = 'Bearer good', origin = ORIGIN, raw } = {}) => new Request('https://x.supabase.co/functions/v1/ai', {
  method: 'POST', headers: { authorization: auth, origin, 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body),
});
const chatBody = { task: 'chat', topic, turns: 1, messages: [{ role: 'ai', ru: 'Привет!' }, { role: 'me', ru: 'Привет, я Хамад' }] };

describe('ai function handler', () => {
  it('answers CORS preflight only for allowed origins', async () => {
    const { handle } = setup();
    const ok = await handle(new Request('https://x/ai', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const bad = await handle(new Request('https://x/ai', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('allows the iOS app origin (capacitor://localhost) by default', async () => {
    expect(DEFAULT_ALLOWED_ORIGINS).toContain('capacitor://localhost');
    expect(DEFAULT_ALLOWED_ORIGINS).toContain('https://xamad558-gif.github.io'); // published web app
    const { handle } = setup({ allowedOrigins: DEFAULT_ALLOWED_ORIGINS });
    const r = await handle(post(chatBody, { origin: 'capacitor://localhost' }));
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
  });
  it('rejects non-POST methods', async () => {
    const { handle } = setup();
    expect((await handle(new Request('https://x/ai', { method: 'GET' }))).status).toBe(405);
  });
  it('rejects unauthenticated calls before reading the body or calling the model', async () => {
    const { handle, deps } = setup();
    const r = await handle(post(chatBody, { auth: 'Bearer bad' }));
    expect(r.status).toBe(401);
    expect(deps.consumeQuota).not.toHaveBeenCalled();
    expect(deps.callModel).not.toHaveBeenCalled();
  });
  it('rejects oversized bodies, malformed JSON and unknown tasks', async () => {
    const { handle, deps } = setup();
    expect((await handle(post(null, { raw: 'x'.repeat(MAX_BODY_BYTES + 1) }))).status).toBe(413);
    expect((await handle(post(null, { raw: '{oops' }))).status).toBe(400);
    const r = await handle(post({ task: 'free_prompt', prompt: 'write malware' }));
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('invalid_request');
    expect(deps.callModel).not.toHaveBeenCalled();
  });
  it('enforces the daily quota without calling the model', async () => {
    const { handle, deps, logs } = setup({ consumeQuota: vi.fn(async () => null) });
    const r = await handle(post(chatBody));
    expect(r.status).toBe(429);
    const b = await r.json();
    expect(b).toMatchObject({ code: 'quota_exceeded', retryable: false, request_id: 'req-1' });
    expect(deps.callModel).not.toHaveBeenCalled();
    expect(logs[0].status).toBe('quota_exceeded');
  });
  it('returns 503 when the quota store fails (fails closed, no model call)', async () => {
    const { handle, deps } = setup({ consumeQuota: vi.fn(async () => { throw new Error('db down'); }) });
    expect((await handle(post(chatBody))).status).toBe(503);
    expect(deps.callModel).not.toHaveBeenCalled();
  });
  it('returns validated data, quota info and logs metadata without any text', async () => {
    const { handle, deps, logs } = setup({ consumeQuota: vi.fn(async () => 7) });
    const r = await handle(post(chatBody));
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const b = await r.json();
    expect(b.data.reply).toBe(chatOk.reply);
    expect(b.quota).toEqual({ used: 7, limit: 60 });
    expect(deps.consumeQuota).toHaveBeenCalledWith('user-1', 60);
    const sent = deps.callModel.mock.calls[0][0];
    expect(sent.output_config.format.type).toBe('json_schema');
    expect(sent.fallbacks).toBe('default');
    expect(logs[0]).toMatchObject({ user_id: 'user-1', task: 'chat', status: 'ok', input_tokens: 120, output_tokens: 80 });
    expect(JSON.stringify(logs[0])).not.toMatch(/Привет|Хамад/);
  });
  it('maps refusals, truncation and invalid output', async () => {
    let s = setup({ callModel: async () => modelMsg({}, { stop_reason: 'refusal', content: [] }) });
    expect((await (await s.handle(post(chatBody))).json()).code).toBe('refused');
    s = setup({ callModel: async () => modelMsg(chatOk, { stop_reason: 'max_tokens' }) });
    expect((await s.handle(post(chatBody))).status).toBe(502);
    s = setup({ callModel: async () => modelMsg({ words: [] }) });
    const r = await s.handle(post(chatBody));
    expect(await r.json()).toMatchObject({ code: 'invalid_response', retryable: true });
  });
  it('maps provider errors to retryable codes', async () => {
    const err = (props) => async () => { throw Object.assign(new Error('x'), props); };
    expect((await setup({ callModel: err({ status: 529 }) }).handle(post(chatBody))).status).toBe(503);
    expect((await setup({ callModel: err({ status: 429 }) }).handle(post(chatBody))).status).toBe(503);
    expect((await setup({ callModel: err({ name: 'APIConnectionTimeoutError' }) }).handle(post(chatBody))).status).toBe(504);
    expect((await setup({ callModel: err({ status: 500 }) }).handle(post(chatBody))).status).toBe(502);
  });
  it('a logging failure never breaks the response', async () => {
    const { handle } = setup({ log: async () => { throw new Error('insert failed'); } });
    expect((await handle(post(chatBody))).status).toBe(200);
  });
});

describe('model request', () => {
  const req = validateRequest(chatBody);
  it('uses the default model with refusal fallbacks and explicit effort', () => {
    const b = buildModelRequest(req);
    expect(b.model).toBe('claude-opus-5-5');
    expect(b.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(b.output_config.effort).toBe('low');
  });
  it('never adds fallbacks for Haiku 5.5 (it has none)', () => {
    const b = buildModelRequest(req, 'claude-haiku-5-5');
    expect(b.fallbacks).toBeUndefined();
    expect(b.betas).toBeUndefined();
  });
  it('schemas meet structured-output rules: every object closed and fully required', () => {
    const walk = (s, path) => {
      if (s.anyOf) return s.anyOf.forEach((x, i) => walk(x, path + '.anyOf' + i));
      if (s.type === 'object') {
        expect(s.additionalProperties, path).toBe(false);
        expect(s.required.sort(), path).toEqual(Object.keys(s.properties).sort());
        Object.entries(s.properties).forEach(([k, v]) => walk(v, path + '.' + k));
      }
      if (s.type === 'array') walk(s.items, path + '[]');
      expect(JSON.stringify(s)).not.toMatch(/minimum|maximum|multipleOf/);
    };
    Object.entries(SCHEMAS).forEach(([k, s]) => walk(s, k));
  });
  it('extracts only text blocks', () => {
    expect(responseText({ content: [{ type: 'thinking' }, { type: 'fallback' }, { type: 'text', text: '{"a":1}' }] })).toBe('{"a":1}');
  });
});

describe('client ↔ server error codes', () => {
  it('surfaces the server error code from the body', async () => {
    configureAI({ endpoint: 'https://x/ai', publishableKey: 'sb_publishable_x', getToken: async () => 'jwt' });
    const f = async () => ({ ok: false, status: 429, json: async () => ({ code: 'quota_exceeded' }) });
    await expect(requestAI('chat', {}, { fetchImpl: f })).rejects.toMatchObject({ code: 'quota_exceeded' });
    const g = async () => ({ ok: false, status: 422, json: async () => ({ code: 'refused' }) });
    await expect(requestAI('chat', {}, { fetchImpl: g })).rejects.toMatchObject({ code: 'refused' });
  });
  it('sends the user token and publishable key, never a provider key', async () => {
    configureAI({ endpoint: 'https://x/ai', publishableKey: 'sb_publishable_x', getToken: async () => 'user-jwt' });
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: chatOk }) }));
    await requestAI('chat', { topic }, { fetchImpl: f });
    const h = f.mock.calls[0][1].headers;
    expect(h.Authorization).toBe('Bearer user-jwt');
    expect(h.apikey).toBe('sb_publishable_x');
  });
  it('a failed anonymous sign-in becomes "unauthorized", not a crash', async () => {
    const { AIContractError } = await import('../supabase/functions/_shared/ai-contract.js');
    configureAI({ endpoint: 'https://x/ai', getToken: async () => { throw new AIContractError('unauthorized'); } });
    await expect(requestAI('chat', {}, { fetchImpl: vi.fn() })).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
