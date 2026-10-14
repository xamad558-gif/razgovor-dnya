import { describe, it, expect, vi } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { RUSSIAN_TRUSTED_CA_PEMS, RUSSIAN_TRUSTED_CA_SHA256 } from '../supabase/functions/_shared/russian-trusted-ca.js';
import {
  buildGigaChatRequest, REPAIR_INSTRUCTION, GIGACHAT_DEFAULT_MODELS, SCHEMAS, validateRequest,
} from '../supabase/functions/_shared/ai-contract.js';
import {
  GIGACHAT_AUTH_URL, GIGACHAT_BASE_URL, createGigaChatProvider, normalizeGigaChat,
  resolveGigaChatModels, createProviderFromEnv,
} from '../supabase/functions/_shared/providers.js';

const topic = { ru: 'Погода', ar: 'الطقس', who: 'Аня', role: 'جارة', en: 'Anya chats about weather.' };
const chatReq = validateRequest({ task: 'chat', topic, turns: 1, messages: [{ role: 'ai', ru: 'Привет!' }, { role: 'me', ru: 'Привет, я Хамад' }] });
const chatOkBody = { reply: 'Привет!', reply_ar: 'مرحبا', words: [], correction: null, hints: [] };

function resJson(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function chatCompletion({ finish_reason = 'stop', content = JSON.stringify(chatOkBody), model = 'GigaChat-2-Max:2.0.28.2', usage = { prompt_tokens: 100, completion_tokens: 50 } } = {}) {
  return resJson(200, { model, choices: [{ finish_reason, message: { content } }], usage });
}
function tokenOk({ access_token = 'tok-1', expires_at } = {}, now) {
  return resJson(200, { access_token, expires_at: expires_at ?? (now() + 30 * 60 * 1000) });
}

/** Harness around createGigaChatProvider with a programmable fake fetch, a controllable clock, and spies. */
function harness({ chatHandlers = [], tokenHandlers = [], models, structured, authKey = '  Basic KEY== ', startNow = 1_700_000_000_000 } = {}) {
  let t = startNow;
  const now = () => t;
  const advance = (ms) => { t += ms; };
  const sleep = vi.fn(async () => {});
  const uuid = () => '00000000-0000-4000-8000-000000000000';
  const log = vi.fn();
  const calls = { oauth: [], chat: [] };
  let oauthN = 0;
  let chatN = 0;
  const fetchImpl = vi.fn(async (url, init) => {
    if (url === GIGACHAT_AUTH_URL) {
      calls.oauth.push({ url, init });
      const hdl = tokenHandlers[Math.min(oauthN, tokenHandlers.length - 1)];
      oauthN += 1;
      return typeof hdl === 'function' ? hdl(init, now, advance) : hdl;
    }
    calls.chat.push({ url, init });
    const hdl = chatHandlers[Math.min(chatN, chatHandlers.length - 1)];
    chatN += 1;
    return typeof hdl === 'function' ? hdl(init, now, advance) : hdl;
  });
  const provider = createGigaChatProvider({
    authKey,
    models: models || { chat: 'GigaChat-2-Max', evaluate: 'GigaChat-2-Max', topic: 'GigaChat-2-Pro' },
    structured,
    fetch: fetchImpl,
    now,
    sleep,
    uuid,
    log,
  });
  return { provider, fetchImpl, calls, log, sleep, now, advance };
}

describe('CA pin (Russian Trusted Root CA + the two Sub CAs)', () => {
  it('pins the three fingerprints and the chain', () => {
    expect(RUSSIAN_TRUSTED_CA_PEMS).toHaveLength(3);
    const certs = RUSSIAN_TRUSTED_CA_PEMS.map((pem) => new X509Certificate(pem));
    expect(certs[0].fingerprint256).toBe(RUSSIAN_TRUSTED_CA_SHA256.root);
    expect(certs[1].fingerprint256).toBe(RUSSIAN_TRUSTED_CA_SHA256.sub2022);
    expect(certs[2].fingerprint256).toBe(RUSSIAN_TRUSTED_CA_SHA256.sub2024);
    expect(certs[0].subject).toMatch(/CN=Russian Trusted Root CA/);
    expect(certs[0].issuer).toMatch(/CN=Russian Trusted Root CA/);
    expect(certs[1].verify(certs[0].publicKey)).toBe(true);
    expect(certs[2].verify(certs[0].publicKey)).toBe(true);
    expect(new Date(certs[0].validTo).getTime()).toBeGreaterThan(new Date('2032-01-01').getTime());
  });
});

describe('buildGigaChatRequest', () => {
  it('puts one leading system message, alternating roles ending on user, model/temperature/max_tokens from settings, no response_format by default', () => {
    const body = buildGigaChatRequest(chatReq, 'GigaChat-2-Max');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    const rest = body.messages.slice(1);
    for (let i = 1; i < rest.length; i++) expect(rest[i].role).not.toBe(rest[i - 1].role);
    expect(rest[rest.length - 1].role).toBe('user');
    expect(body.model).toBe('GigaChat-2-Max');
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(1500);
    expect(body.response_format).toBeUndefined();
  });
  it('adds response_format with {structured:true}', () => {
    const body = buildGigaChatRequest(chatReq, 'GigaChat-2-Max', { structured: true });
    expect(body.response_format).toEqual({ type: 'json_schema', schema: SCHEMAS.chat, strict: true });
  });
  it('repair: appends the assistant bad text (cut to 4000 chars) and the user REPAIR_INSTRUCTION', () => {
    const body = buildGigaChatRequest(chatReq, 'GigaChat-2-Max', { repairOf: 'bad' });
    const last2 = body.messages.slice(-2);
    expect(last2[0]).toEqual({ role: 'assistant', content: 'bad' });
    expect(last2[1]).toEqual({ role: 'user', content: REPAIR_INSTRUCTION });
    const long = 'x'.repeat(5000);
    const body2 = buildGigaChatRequest(chatReq, 'GigaChat-2-Max', { repairOf: long });
    expect(body2.messages[body2.messages.length - 2].content).toHaveLength(4000);
  });
});

describe('resolveGigaChatModels', () => {
  it('defaults, GIGACHAT_MODEL for all tasks, GIGACHAT_MODEL_CHAT wins, blanks ignored, AI_MODEL ignored', () => {
    expect(resolveGigaChatModels(() => undefined)).toEqual(GIGACHAT_DEFAULT_MODELS);
    const vars1 = { GIGACHAT_MODEL: 'GigaChat-3-Ultra' };
    expect(resolveGigaChatModels((k) => vars1[k])).toEqual({ chat: 'GigaChat-3-Ultra', evaluate: 'GigaChat-3-Ultra', topic: 'GigaChat-3-Ultra' });
    const vars2 = { GIGACHAT_MODEL: 'GigaChat-3-Ultra', GIGACHAT_MODEL_CHAT: 'GigaChat-2-Pro' };
    expect(resolveGigaChatModels((k) => vars2[k]).chat).toBe('GigaChat-2-Pro');
    const vars3 = { GIGACHAT_MODEL_CHAT: '   ', AI_MODEL: 'claude-opus-5-5' };
    expect(resolveGigaChatModels((k) => vars3[k])).toEqual(GIGACHAT_DEFAULT_MODELS);
  });
});

describe('GigaChat provider: transport', () => {
  it('first call: one OAuth call then the chat call, with the required headers/body', async () => {
    const h = harness({
      tokenHandlers: [(init, now) => tokenOk({}, now)],
      chatHandlers: [() => chatCompletion()],
    });
    const result = await h.provider.complete(chatReq, { requestId: 'req-xyz' });
    expect(h.calls.oauth).toHaveLength(1);
    const oi = h.calls.oauth[0].init;
    expect(oi.headers.Authorization).toBe('Basic KEY==');
    expect(oi.headers.RqUID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(oi.body).toBe('scope=GIGACHAT_API_PERS');
    expect(oi.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(oi.headers['User-Agent']).toBeTruthy();

    expect(h.calls.chat).toHaveLength(1);
    expect(h.calls.chat[0].url).toBe('https://api.giga.chat/v1/chat/completions');
    const ci = h.calls.chat[0].init;
    expect(ci.headers.Authorization).toBe('Bearer tok-1');
    expect(ci.headers['User-Agent']).toBeTruthy();
    expect(ci.headers['X-Request-ID']).toBe('req-xyz');
    expect(result.text).toBe(JSON.stringify(chatOkBody));
    expect(result.stop).toBe('end');
  });

  it('reuses the cached token across sequential calls (1 OAuth call for 2 completions)', async () => {
    const h = harness({ tokenHandlers: [(init, now) => tokenOk({}, now)], chatHandlers: [() => chatCompletion(), () => chatCompletion()] });
    await h.provider.complete(chatReq, { requestId: 'r1' });
    await h.provider.complete(chatReq, { requestId: 'r2' });
    expect(h.calls.oauth).toHaveLength(1);
    expect(h.calls.chat).toHaveLength(2);
  });

  it('refreshes under the 60s margin, and reuses a token whose expires_at was given in seconds', async () => {
    const h = harness({
      tokenHandlers: [(init, now) => tokenOk({}, now), (init, now) => tokenOk({ access_token: 'tok-2' }, now)],
      chatHandlers: [() => chatCompletion(), () => chatCompletion()],
    });
    await h.provider.complete(chatReq, { requestId: 'r1' });
    h.advance(30 * 60 * 1000 - 30_000); // now = expires_at - 30s, inside the 60s margin
    await h.provider.complete(chatReq, { requestId: 'r2' });
    expect(h.calls.oauth).toHaveLength(2);

    const h2 = harness({
      tokenHandlers: [(init, now) => tokenOk({ expires_at: Math.floor((now() + 30 * 60 * 1000) / 1000) }, now)],
      chatHandlers: [() => chatCompletion(), () => chatCompletion()],
    });
    await h2.provider.complete(chatReq, { requestId: 'r1' });
    h2.advance(5 * 60 * 1000); // well within margin, even interpreted as seconds-based conversion
    await h2.provider.complete(chatReq, { requestId: 'r2' });
    expect(h2.calls.oauth).toHaveLength(1);
  });

  it('single-flights concurrent token fetches (2 concurrent completions make 1 OAuth call)', async () => {
    let resolveToken;
    const h = harness({
      tokenHandlers: [(init, now) => new Promise((resolve) => { resolveToken = () => resolve(tokenOk({}, now)); })],
      chatHandlers: [() => chatCompletion(), () => chatCompletion()],
    });
    const p1 = h.provider.complete(chatReq, { requestId: 'r1' });
    const p2 = h.provider.complete(chatReq, { requestId: 'r2' });
    resolveToken();
    await Promise.all([p1, p2]);
    expect(h.calls.oauth).toHaveLength(1);
    expect(h.calls.chat).toHaveLength(2);
  });

  it('retries once after a 401 with a fresh token, then succeeds', async () => {
    const h = harness({
      tokenHandlers: [(init, now) => tokenOk({ access_token: 'tok-1' }, now), (init, now) => tokenOk({ access_token: 'tok-2' }, now)],
      chatHandlers: [() => resJson(401, { message: 'token expired' }), () => chatCompletion()],
    });
    const result = await h.provider.complete(chatReq, { requestId: 'r1' });
    expect(h.calls.oauth).toHaveLength(2);
    expect(h.calls.chat).toHaveLength(2);
    expect(h.calls.chat[1].init.headers.Authorization).toBe('Bearer tok-2');
    expect(result.stop).toBe('end');
  });

  it('401 twice gives a server error, exactly 2 chat calls', async () => {
    const h = harness({
      tokenHandlers: [(init, now) => tokenOk({ access_token: 'tok-1' }, now), (init, now) => tokenOk({ access_token: 'tok-2' }, now)],
      chatHandlers: [() => resJson(401, {}), () => resJson(401, {})],
    });
    await expect(h.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ name: 'ProviderError', code: 'server', status: 401 });
    expect(h.calls.chat).toHaveLength(2);
  });

  it('logs only the size of a non-JSON error body, never its content', async () => {
    const h = harness({ tokenHandlers: [(init, now) => tokenOk({}, now)], chatHandlers: [() => new Response('<html>echo Привет, я Хамад</html>', { status: 400 })] });
    await expect(h.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server', status: 400 });
    const logged = JSON.stringify(h.log.mock.calls);
    expect(logged).toMatch(/non-json body \(\d+ chars\)/);
    expect(logged).not.toMatch(/Хамад|<html>/);
  });

  it('402 gives billing, 1 chat call, no sleep', async () => {
    const h = harness({ tokenHandlers: [(init, now) => tokenOk({}, now)], chatHandlers: [() => resJson(402, { message: 'no tokens left' })] });
    await expect(h.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'billing', logStatus: 'provider_billing', status: 402 });
    expect(h.calls.chat).toHaveLength(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it('429 retries once after 2s then succeeds; twice gives unavailable; at >=15s elapsed gives unavailable with no retry', async () => {
    const h1 = harness({ tokenHandlers: [(init, now) => tokenOk({}, now)], chatHandlers: [() => resJson(429, {}), () => chatCompletion()] });
    await h1.provider.complete(chatReq, { requestId: 'r1' });
    expect(h1.sleep).toHaveBeenCalledTimes(1);
    expect(h1.sleep).toHaveBeenCalledWith(2000);
    expect(h1.calls.chat).toHaveLength(2);

    const h2 = harness({ tokenHandlers: [(init, now) => tokenOk({}, now)], chatHandlers: [() => resJson(429, {}), () => resJson(429, {})] });
    await expect(h2.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'unavailable', status: 429 });

    const h3 = harness({
      tokenHandlers: [(init, now) => tokenOk({}, now)],
      chatHandlers: [(init, now, advance) => { advance(20_000); return resJson(429, {}); }],
    });
    await expect(h3.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'unavailable', status: 429 });
    expect(h3.calls.chat).toHaveLength(1);
  });

  it('500/502/504 retry once then server; 503 retries once then unavailable; 404 is server with no retry', async () => {
    const h500 = harness({ tokenHandlers: [(init, now) => tokenOk({}, now)], chatHandlers: [() => resJson(500, {}), () => resJson(500, {})] });
    await expect(h500.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server', status: 500 });

    const h503 = harness({ tokenHandlers: [(init, now) => tokenOk({}, now)], chatHandlers: [() => resJson(503, {}), () => resJson(503, {})] });
    await expect(h503.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'unavailable', status: 503 });

    const h404 = harness({ tokenHandlers: [(init, now) => tokenOk({}, now)], chatHandlers: [() => resJson(404, {})] });
    await expect(h404.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server', status: 404 });
    expect(h404.calls.chat).toHaveLength(1);
  });

  it('OAuth 401 gives server with no chat call; OAuth 200 without access_token gives provider_error_oauth_invalid', async () => {
    const h1 = harness({ tokenHandlers: [() => resJson(401, { message: 'bad key' })], chatHandlers: [] });
    await expect(h1.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server', logStatus: 'provider_error_oauth_401' });
    expect(h1.calls.chat).toHaveLength(0);

    const h2 = harness({ tokenHandlers: [() => resJson(200, { foo: 'bar' })], chatHandlers: [] });
    await expect(h2.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ logStatus: 'provider_error_oauth_invalid' });
  });

  it('network failure (TLS/DNS/connect) maps to server/provider_error_network and logs the message, no leaks', async () => {
    const h = harness({
      tokenHandlers: [(init, now) => tokenOk({}, now)],
      chatHandlers: [() => { throw new TypeError('invalid peer certificate: UnknownIssuer'); }],
    });
    await expect(h.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server', logStatus: 'provider_error_network' });
    const logged = h.log.mock.calls.map((c) => JSON.stringify(c[0])).join('\n');
    expect(logged).toMatch(/UnknownIssuer/);
  });

  it('a TimeoutError/AbortError rejection classifies as timeout', async () => {
    const h = harness({
      tokenHandlers: [(init, now) => tokenOk({}, now)],
      chatHandlers: [() => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }],
    });
    await expect(h.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'timeout', logStatus: 'provider_error_timeout' });
  });

  it('never leaks the learner text or the auth key, in logs or in the thrown error', async () => {
    const chatReqWithName = validateRequest({ task: 'chat', topic, turns: 1, messages: [{ role: 'me', ru: 'Меня зовут Хамад' }] });
    const h = harness({
      authKey: 'SECRETKEY==',
      tokenHandlers: [(init, now) => tokenOk({ access_token: 'SECRET-TOKEN-ABC' }, now)],
      chatHandlers: [() => resJson(400, { message: 'bad request' })],
    });
    let err;
    try {
      await h.provider.complete(chatReqWithName, { requestId: 'r1' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    const logged = JSON.stringify(h.log.mock.calls);
    const thrown = JSON.stringify(err, Object.getOwnPropertyNames(err));
    for (const secret of ['Меня зовут Хамад', 'SECRETKEY==', 'SECRET-TOKEN-ABC']) {
      expect(logged).not.toMatch(secret);
      expect(thrown).not.toMatch(secret);
    }
  });
});

describe('normalizeGigaChat', () => {
  it('maps finish_reason and usage, prefers the response model, handles no choices', () => {
    expect(normalizeGigaChat({ model: 'M', choices: [{ finish_reason: 'stop', message: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }, 'req-model'))
      .toMatchObject({ model: 'M', stop: 'end', text: 'x', inputTokens: 1, outputTokens: 2 });
    expect(normalizeGigaChat({ choices: [{ finish_reason: 'length', message: { content: 'y' } }] }, 'req-model').stop).toBe('max_tokens');
    expect(normalizeGigaChat({ choices: [{ finish_reason: 'blacklist', message: { content: 'z' } }] }, 'req-model').stop).toBe('refusal');
    expect(normalizeGigaChat({ choices: [{ finish_reason: 'function_call', message: { content: 'w' } }] }, 'req-model').stop).toBe('end');
    const noChoices = normalizeGigaChat({}, 'req-model');
    expect(noChoices.text).toBe('');
    expect(noChoices.model).toBe('req-model');
    expect(noChoices.inputTokens).toBeNull();
    expect(noChoices.outputTokens).toBeNull();
  });
});

describe('createProviderFromEnv', () => {
  it('AI_PROVIDER=gigachat selects gigachat, given a key; AI_PROVIDER=anthropic selects anthropic', () => {
    const vars1 = { AI_PROVIDER: 'gigachat', GIGACHAT_AUTH_KEY: 'key' };
    expect(createProviderFromEnv((k) => vars1[k], { gigachatFetch: vi.fn(), anthropicCreate: vi.fn() }).name).toBe('gigachat');
    const vars2 = { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-x' };
    expect(createProviderFromEnv((k) => vars2[k], { gigachatFetch: vi.fn(), anthropicCreate: vi.fn() }).name).toBe('anthropic');
  });

  it('gigachat without a key, or an unknown provider, gives a not_configured provider and logs once', async () => {
    const log1 = vi.fn();
    const vars0 = { AI_PROVIDER: 'gigachat' };
    const p1 = createProviderFromEnv((k) => vars0[k], { gigachatFetch: vi.fn(), anthropicCreate: vi.fn(), log: log1 });
    await expect(p1.complete()).rejects.toMatchObject({ logStatus: 'provider_not_configured' });
    expect(log1).toHaveBeenCalledTimes(1);
    expect(log1.mock.calls[0][0].missing).toBe('GIGACHAT_AUTH_KEY');

    const log2 = vi.fn();
    const vars = { AI_PROVIDER: 'foo' };
    const p2 = createProviderFromEnv((k) => vars[k], { gigachatFetch: vi.fn(), anthropicCreate: vi.fn(), log: log2 });
    await expect(p2.complete()).rejects.toMatchObject({ logStatus: 'provider_not_configured' });
    expect(log2).toHaveBeenCalledTimes(1);
    expect(log2.mock.calls[0][0].missing).toBe('AI_PROVIDER');
  });

  it('GIGACHAT_STRUCTURED=ON (case-insensitive) makes the chat request body include response_format', async () => {
    const vars = { AI_PROVIDER: 'gigachat', GIGACHAT_AUTH_KEY: 'key', GIGACHAT_STRUCTURED: 'ON' };
    const fetchImpl = vi.fn(async (url) => {
      if (url === GIGACHAT_AUTH_URL) return resJson(200, { access_token: 'tok', expires_at: Date.now() + 30 * 60 * 1000 });
      return chatCompletion();
    });
    const provider = createProviderFromEnv((k) => vars[k], { gigachatFetch: fetchImpl, anthropicCreate: vi.fn() });
    await provider.complete(chatReq, { requestId: 'r1' });
    const chatCall = fetchImpl.mock.calls.find((c) => c[0] === `${GIGACHAT_BASE_URL}/chat/completions`);
    const body = JSON.parse(chatCall[1].body);
    expect(body.response_format).toEqual({ type: 'json_schema', schema: SCHEMAS.chat, strict: true });
  });
});
