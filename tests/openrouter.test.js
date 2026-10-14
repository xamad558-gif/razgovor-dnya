import { describe, it, expect, vi } from 'vitest';
import {
  buildOpenRouterRequest, OPENROUTER_DEFAULT_MODELS, OPENROUTER_TASK_SETTINGS, validateRequest,
} from '../supabase/functions/_shared/ai-contract.js';
import {
  OPENROUTER_URL, createOpenRouterProvider, normalizeOpenRouter, resolveOpenRouterModels,
  classifyOpenRouterError, createProviderFromEnv,
} from '../supabase/functions/_shared/providers.js';
import { createHandler } from '../supabase/functions/_shared/handler.js';

const topic = { ru: 'Погода', ar: 'الطقس', who: 'Аня', role: 'جارة', en: 'Anya chats about weather.' };
const chatReq = validateRequest({ task: 'chat', topic, turns: 1, messages: [{ role: 'ai', ru: 'Привет!' }, { role: 'me', ru: 'Привет, я Хамад' }] });
const evaluateReq = validateRequest({ task: 'evaluate', topic, turns: 2, messages: [{ role: 'me', ru: 'Привет, я Хамад' }] });
const topicReq = validateRequest({ task: 'topic', idea: 'weather' });
const chatOkBody = { reply: 'Привет!', reply_ar: 'مرحبا', words: [], correction: null, hints: [] };
const defaultModels = () => ({ chat: [...OPENROUTER_DEFAULT_MODELS], evaluate: [...OPENROUTER_DEFAULT_MODELS], topic: [...OPENROUTER_DEFAULT_MODELS] });

function resJson(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function chatCompletion({ finish_reason = 'stop', content = JSON.stringify(chatOkBody), model = 'google/gemma-4-31b-it:free', usage = { prompt_tokens: 900, completion_tokens: 400 } } = {}) {
  return resJson(200, { model, choices: [{ finish_reason, message: { content } }], usage });
}

/** Harness around createOpenRouterProvider with a programmable fake fetch and a controllable clock. */
function harness({ chatHandlers = [], models, reasoning, apiKey = 'sk-or-x', startNow = 1_700_000_000_000 } = {}) {
  let t = startNow;
  const now = () => t;
  const advance = (ms) => { t += ms; };
  const log = vi.fn();
  const calls = [];
  let n = 0;
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const hdl = chatHandlers[Math.min(n, chatHandlers.length - 1)];
    n += 1;
    return typeof hdl === 'function' ? hdl(init, now, advance) : hdl;
  });
  const provider = createOpenRouterProvider({
    apiKey, models: models || defaultModels(), reasoning, fetch: fetchImpl, now, log,
  });
  return { provider, fetchImpl, calls, log, now, advance };
}

describe('buildOpenRouterRequest', () => {
  it('model/models from the list, one leading system message, roles alternate ending on user', () => {
    const list = ['a/b:free', 'c/d:free'];
    const body = buildOpenRouterRequest(chatReq, list);
    expect(body.model).toBe('a/b:free');
    expect(body.models).toEqual(list);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    const rest = body.messages.slice(1);
    for (let i = 1; i < rest.length; i++) expect(rest[i].role).not.toBe(rest[i - 1].role);
    expect(rest[rest.length - 1].role).toBe('user');
  });

  it('settings per task, response_format json_object, reasoning default low with exclude, stream false', () => {
    const body = buildOpenRouterRequest(chatReq, OPENROUTER_DEFAULT_MODELS);
    expect(body.temperature).toBe(OPENROUTER_TASK_SETTINGS.chat.temperature);
    expect(body.max_tokens).toBe(OPENROUTER_TASK_SETTINGS.chat.maxTokens);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.reasoning).toEqual({ effort: 'low', exclude: true });
    expect(body.stream).toBe(false);

    const bodyNone = buildOpenRouterRequest(chatReq, OPENROUTER_DEFAULT_MODELS, { reasoning: 'none' });
    expect(bodyNone.reasoning).toEqual({ effort: 'none' });
  });

  it('evaluate and topic use their own settings', () => {
    const bodyEval = buildOpenRouterRequest(evaluateReq, OPENROUTER_DEFAULT_MODELS);
    expect(bodyEval.temperature).toBe(OPENROUTER_TASK_SETTINGS.evaluate.temperature);
    expect(bodyEval.max_tokens).toBe(OPENROUTER_TASK_SETTINGS.evaluate.maxTokens);
    const bodyTopic = buildOpenRouterRequest(topicReq, OPENROUTER_DEFAULT_MODELS);
    expect(bodyTopic.temperature).toBe(OPENROUTER_TASK_SETTINGS.topic.temperature);
    expect(bodyTopic.max_tokens).toBe(OPENROUTER_TASK_SETTINGS.topic.maxTokens);
  });
});

describe('OpenRouter provider: headers', () => {
  it('POSTs the OpenRouter URL with the required headers and strips a leading Bearer from the key', async () => {
    const h = harness({ chatHandlers: [() => chatCompletion()], apiKey: '  Bearer sk-or-x ' });
    await h.provider.complete(chatReq, { requestId: 'r1' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe(OPENROUTER_URL);
    const init = h.calls[0].init;
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-or-x');
    expect(init.headers['HTTP-Referer']).toBe('https://xamad558-gif.github.io/razgovor-dnya/');
    expect(init.headers['X-OpenRouter-Title']).toBeTruthy();
    expect(init.headers['X-OpenRouter-App-Visibility']).toBe('hidden');
    const body = JSON.parse(init.body);
    expect(body.user).toBeUndefined();
  });
});

describe('resolveOpenRouterModels', () => {
  it('defaults to OPENROUTER_DEFAULT_MODELS for every task', () => {
    const log = vi.fn();
    expect(resolveOpenRouterModels(() => undefined, log)).toEqual({ chat: OPENROUTER_DEFAULT_MODELS, evaluate: OPENROUTER_DEFAULT_MODELS, topic: OPENROUTER_DEFAULT_MODELS });
  });

  it('OPENROUTER_MODELS applies to every task; a per-task override wins', () => {
    const log = vi.fn();
    const vars1 = { OPENROUTER_MODELS: 'a/b:free, c/d:free' };
    expect(resolveOpenRouterModels((k) => vars1[k], log)).toEqual({ chat: ['a/b:free', 'c/d:free'], evaluate: ['a/b:free', 'c/d:free'], topic: ['a/b:free', 'c/d:free'] });

    const vars2 = { OPENROUTER_MODEL_EVALUATE: 'x/y:free' };
    const resolved2 = resolveOpenRouterModels((k) => vars2[k], log);
    expect(resolved2.evaluate).toEqual(['x/y:free']);
    expect(resolved2.chat).toEqual(OPENROUTER_DEFAULT_MODELS);
    expect(resolved2.topic).toEqual(OPENROUTER_DEFAULT_MODELS);
  });

  it('drops invalid ids (logged), dedupes, caps a 5-item list at 3 (logged), and falls back to default when all invalid', () => {
    const log1 = vi.fn();
    const vars1 = { OPENROUTER_MODELS: 'bad id, a/b:free, a/b:free, nomodel, sk-or-v1-SECRET' };
    expect(resolveOpenRouterModels((k) => vars1[k], log1).chat).toEqual(['a/b:free']);
    expect(log1).toHaveBeenCalled();
    const loggedInvalid = JSON.stringify(log1.mock.calls);
    expect(loggedInvalid).toMatch(/"count":3/);
    // Values are never logged: a key pasted into the wrong secret must not leak.
    expect(loggedInvalid).not.toMatch(/bad id|nomodel|SECRET/);

    const log2 = vi.fn();
    const vars2 = { OPENROUTER_MODELS: 'a/b:free,c/d:free,e/f:free,g/h:free,i/j:free' };
    const resolved = resolveOpenRouterModels((k) => vars2[k], log2);
    expect(resolved.chat).toHaveLength(3);
    expect(resolved.chat).toEqual(['a/b:free', 'c/d:free', 'e/f:free']);
    expect(JSON.stringify(log2.mock.calls)).toMatch(/capped/);

    const log3 = vi.fn();
    const vars3 = { OPENROUTER_MODELS: 'bad id, nomodel' };
    expect(resolveOpenRouterModels((k) => vars3[k], log3)).toEqual({ chat: OPENROUTER_DEFAULT_MODELS, evaluate: OPENROUTER_DEFAULT_MODELS, topic: OPENROUTER_DEFAULT_MODELS });
  });

  it('modelFor(task) is the resolved primary', () => {
    const h = harness({ models: { chat: ['a/b:free', 'c/d:free'], evaluate: OPENROUTER_DEFAULT_MODELS, topic: OPENROUTER_DEFAULT_MODELS } });
    expect(h.provider.modelFor('chat')).toBe('a/b:free');
  });
});

describe('OpenRouter provider: success and finish_reason', () => {
  it('maps a fallback-served model, stop:end, content JSON and usage', async () => {
    const h = harness({ chatHandlers: [() => chatCompletion({ model: 'thinkingmachines/inkling:free', usage: { prompt_tokens: 900, completion_tokens: 400 } })] });
    const result = await h.provider.complete(chatReq, { requestId: 'r1' });
    expect(result).toMatchObject({ stop: 'end', model: 'thinkingmachines/inkling:free', inputTokens: 900, outputTokens: 400 });
    expect(result.text).toBe(JSON.stringify(chatOkBody));
  });

  it('content given as an array of text parts is joined', () => {
    const json = { model: 'm', choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: 'ab' }, { type: 'text', text: 'cd' }, { type: 'image', text: 'x' }] } }] };
    expect(normalizeOpenRouter(json, 'req-model').text).toBe('abcd');
  });

  it('finish_reason length -> max_tokens, content_filter -> refusal, tool_calls -> end', async () => {
    const h1 = harness({ chatHandlers: [() => chatCompletion({ finish_reason: 'length' })] });
    expect((await h1.provider.complete(chatReq, {})).stop).toBe('max_tokens');
    const h2 = harness({ chatHandlers: [() => chatCompletion({ finish_reason: 'content_filter' })] });
    expect((await h2.provider.complete(chatReq, {})).stop).toBe('refusal');
    const h3 = harness({ chatHandlers: [() => chatCompletion({ finish_reason: 'tool_calls' })] });
    expect((await h3.provider.complete(chatReq, {})).stop).toBe('end');
  });
});

describe('OpenRouter provider: error mapping (non-2xx)', () => {
  it('401 -> server/provider_error_401, one log line with status and upstream_message', async () => {
    const h = harness({ chatHandlers: [() => resJson(401, { error: { code: 401, message: 'Invalid API key' } })] });
    await expect(h.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server', status: 401, logStatus: 'provider_error_401' });
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log.mock.calls[0][0]).toMatchObject({ status: 401, upstream_message: 'Invalid API key' });
  });

  it('402 -> billing/provider_billing', async () => {
    const h = harness({ chatHandlers: [() => resJson(402, { error: { code: 402, message: 'Insufficient credits' } })] });
    await expect(h.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'billing', logStatus: 'provider_billing', status: 402 });
  });

  it('403 moderation -> refused/provider_moderation, never logs flagged_input or the learner text; other 403 -> server', async () => {
    const h = harness({
      chatHandlers: [() => resJson(403, { error: { code: 403, message: 'Flagged', metadata: { reasons: ['harassment'], flagged_input: 'Меня зовут Хамад …', provider_name: 'X', model_slug: 'm' } } })],
    });
    await expect(h.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'refused', logStatus: 'provider_moderation', status: 403 });
    const logged = JSON.stringify(h.log.mock.calls);
    expect(logged).toMatch(/harassment/);
    expect(logged).not.toMatch(/flagged_input/);
    expect(logged).not.toMatch(/Хамад/);
    expect(logged).not.toMatch(/upstream_message/);

    const h2 = harness({ chatHandlers: [() => resJson(403, { error: { code: 403, message: 'blocked' } })] });
    await expect(h2.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server', logStatus: 'provider_error_403' });
  });

  it('404 data policy -> provider_data_policy; other 404 -> provider_error_404', async () => {
    const h = harness({ chatHandlers: [() => resJson(404, { error: { code: 404, message: 'No endpoints found matching your data policy' } })] });
    await expect(h.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server', logStatus: 'provider_data_policy' });
    const h2 = harness({ chatHandlers: [() => resJson(404, { error: { code: 404, message: 'no such model' } })] });
    await expect(h2.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server', logStatus: 'provider_error_404' });
  });

  it('408 -> timeout', async () => {
    const h = harness({ chatHandlers: [() => resJson(408, { error: { code: 408, message: 'Request timed out' } })] });
    await expect(h.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'timeout', logStatus: 'provider_error_408' });
  });

  it('429 daily (message, or Remaining:0 + Reset far ahead) -> quota_exceeded; per-minute 429 -> unavailable', async () => {
    const h1 = harness({ chatHandlers: [() => resJson(429, { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } })] });
    await expect(h1.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'quota_exceeded', logStatus: 'provider_quota_day' });

    const h2 = harness({
      chatHandlers: [(init, now) => resJson(429, { error: { code: 429, message: 'Rate limit exceeded' } }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now() + 3 * 60 * 60 * 1000) })],
    });
    await expect(h2.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'quota_exceeded', logStatus: 'provider_quota_day' });

    const h3 = harness({
      chatHandlers: [(init, now) => resJson(429, { error: { code: 429, message: 'Rate limit exceeded' } }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor((now() + 3 * 60 * 60 * 1000) / 1000)) })],
    });
    await expect(h3.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'quota_exceeded', logStatus: 'provider_quota_day' });

    const h4 = harness({
      chatHandlers: [(init, now) => resJson(429, { error: { code: 429, message: 'Rate limit exceeded: free-models-per-min' } }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now() + 30_000) })],
    });
    await expect(h4.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'unavailable', logStatus: 'provider_error_429' });
  });

  it('502/503 -> unavailable; 500 -> server; exactly one fetch call in every error case', async () => {
    const h502 = harness({ chatHandlers: [() => resJson(502, { error: { code: 502, message: 'bad gateway' } })] });
    await expect(h502.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(h502.fetchImpl).toHaveBeenCalledTimes(1);

    const h503 = harness({ chatHandlers: [() => resJson(503, { error: { code: 503, message: 'no provider' } })] });
    await expect(h503.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(h503.fetchImpl).toHaveBeenCalledTimes(1);

    const h500 = harness({ chatHandlers: [() => resJson(500, { error: { code: 500, message: 'internal' } })] });
    await expect(h500.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server' });
    expect(h500.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('OpenRouter provider: error inside a 200', () => {
  it('top-level error, choice error with and without a code, and an unparseable body', async () => {
    const h1 = harness({ chatHandlers: [() => resJson(200, { error: { code: 502, message: 'Provider returned error' } })] });
    await expect(h1.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'unavailable' });

    const h2 = harness({ chatHandlers: [() => resJson(200, { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } })] });
    await expect(h2.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'quota_exceeded' });

    const h3 = harness({
      chatHandlers: [() => resJson(200, { choices: [{ finish_reason: 'error', error: { code: 500, message: 'x' }, message: { content: '{"rep' } }] })],
    });
    await expect(h3.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server' });

    const h4 = harness({
      chatHandlers: [() => resJson(200, { choices: [{ finish_reason: 'error', error: { message: 'no code' } }] })],
    });
    await expect(h4.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server', logStatus: 'provider_error_choice' });

    const h5 = harness({ chatHandlers: [() => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })] });
    await expect(h5.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'invalid_response', logStatus: 'provider_bad_body' });
  });
});

describe('OpenRouter provider: network failures', () => {
  it('a network rejection maps to server/provider_error_network and logs "openrouter error"', async () => {
    const h = harness({ chatHandlers: [() => { throw new TypeError('fetch failed'); }] });
    await expect(h.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'server', logStatus: 'provider_error_network' });
    expect(h.log.mock.calls[0][0]).toMatchObject({ msg: 'openrouter error' });
  });

  it('TimeoutError/AbortError classifies as timeout', async () => {
    const h = harness({ chatHandlers: [() => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; }] });
    await expect(h.provider.complete(chatReq, { requestId: 'r1' })).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('OpenRouter provider: no leaks', () => {
  it('never logs or throws the learner text, the key, or metadata.raw', async () => {
    const chatReqWithName = validateRequest({ task: 'chat', topic, turns: 1, messages: [{ role: 'me', ru: 'Меня зовут Хамад' }] });
    const secrets = ['Меня зовут Хамад', 'sk-or-SECRET', 'echo Хамад'];

    const h1 = harness({ apiKey: 'sk-or-SECRET', chatHandlers: [() => resJson(400, { error: { code: 400, message: 'bad request', metadata: { raw: 'echo Хамад' } } })] });
    let err1;
    try { await h1.provider.complete(chatReqWithName, { requestId: 'r1' }); } catch (e) { err1 = e; }
    expect(err1).toBeTruthy();

    const h2 = harness({ apiKey: 'sk-or-SECRET', chatHandlers: [() => resJson(403, { error: { code: 403, message: 'moderat', metadata: { reasons: ['x'], flagged_input: 'Меня зовут Хамад', raw: 'echo Хамад' } } })] });
    let err2;
    try { await h2.provider.complete(chatReqWithName, { requestId: 'r1' }); } catch (e) { err2 = e; }
    expect(err2).toBeTruthy();

    const h3 = harness({ apiKey: 'sk-or-SECRET', chatHandlers: [() => { throw new TypeError('fetch failed'); }] });
    let err3;
    try { await h3.provider.complete(chatReqWithName, { requestId: 'r1' }); } catch (e) { err3 = e; }
    expect(err3).toBeTruthy();

    for (const h of [h1, h2, h3]) {
      const logged = JSON.stringify(h.log.mock.calls);
      for (const secret of secrets) expect(logged).not.toContain(secret);
    }
    for (const err of [err1, err2, err3]) {
      const thrown = JSON.stringify(err, Object.getOwnPropertyNames(err));
      for (const secret of secrets) expect(thrown).not.toContain(secret);
    }
  });
});

describe('createProviderFromEnv: openrouter selection', () => {
  it('unset AI_PROVIDER + OPENROUTER_API_KEY -> openrouter, with repairInvalidJson:false', () => {
    const vars = { OPENROUTER_API_KEY: 'sk-or-x' };
    const p = createProviderFromEnv((k) => vars[k], { openrouterFetch: vi.fn(), gigachatFetch: vi.fn(), anthropicCreate: vi.fn() });
    expect(p.name).toBe('openrouter');
    expect(p.repairInvalidJson).toBe(false);
  });

  it('unset AI_PROVIDER without OPENROUTER_API_KEY -> not configured, even when GIGACHAT_AUTH_KEY is set', async () => {
    const log = vi.fn();
    const vars = { GIGACHAT_AUTH_KEY: 'key' };
    const p = createProviderFromEnv((k) => vars[k], { openrouterFetch: vi.fn(), gigachatFetch: vi.fn(), anthropicCreate: vi.fn(), log });
    await expect(p.complete()).rejects.toMatchObject({ logStatus: 'provider_not_configured' });
    expect(log.mock.calls[0][0].missing).toBe('OPENROUTER_API_KEY');
  });

  it('AI_PROVIDER=gigachat / anthropic still select those', () => {
    const vars1 = { AI_PROVIDER: 'gigachat', GIGACHAT_AUTH_KEY: 'key' };
    expect(createProviderFromEnv((k) => vars1[k], { openrouterFetch: vi.fn(), gigachatFetch: vi.fn(), anthropicCreate: vi.fn() }).name).toBe('gigachat');
    const vars2 = { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-x' };
    expect(createProviderFromEnv((k) => vars2[k], { openrouterFetch: vi.fn(), gigachatFetch: vi.fn(), anthropicCreate: vi.fn() }).name).toBe('anthropic');
  });

  it("OPENROUTER_REASONING='NONE' builds {effort:'none'}; an invalid value falls back to low and logs once", async () => {
    const vars1 = { OPENROUTER_API_KEY: 'sk-or-x', OPENROUTER_REASONING: 'NONE' };
    const fetchImpl = vi.fn(async () => chatCompletion());
    const p1 = createProviderFromEnv((k) => vars1[k], { openrouterFetch: fetchImpl, gigachatFetch: vi.fn(), anthropicCreate: vi.fn() });
    await p1.complete(chatReq, { requestId: 'r1' });
    const body1 = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body1.reasoning).toEqual({ effort: 'none' });

    const log2 = vi.fn();
    const vars2 = { OPENROUTER_API_KEY: 'sk-or-x', OPENROUTER_REASONING: 'turbo' };
    const fetchImpl2 = vi.fn(async () => chatCompletion());
    const p2 = createProviderFromEnv((k) => vars2[k], { openrouterFetch: fetchImpl2, gigachatFetch: vi.fn(), anthropicCreate: vi.fn(), log: log2 });
    await p2.complete(chatReq, { requestId: 'r1' });
    const body2 = JSON.parse(fetchImpl2.mock.calls[0][1].body);
    expect(body2.reasoning).toEqual({ effort: 'low', exclude: true });
    expect(log2).toHaveBeenCalledTimes(1);
  });
});

describe('OpenRouter through the handler', () => {
  function makeHandler(fetchImpl) {
    const provider = createOpenRouterProvider({ apiKey: 'sk-or-x', models: defaultModels(), fetch: fetchImpl, log: vi.fn() });
    const logged = [];
    const handle = createHandler({
      allowedOrigins: ['https://app.example'],
      authenticate: async () => 'user-1',
      consumeQuota: async () => 1,
      provider,
      log: async (entry) => { logged.push(entry); },
      dailyLimit: 20,
      requestId: () => 'req-1',
    });
    return { handle, logged };
  }
  function postReq(body) {
    return new Request('https://fn.example/ai', { method: 'POST', headers: { origin: 'https://app.example', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  it('invalid JSON from the model -> 502 invalid_response, status invalid_output, exactly 1 fetch (no repair)', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => { calls += 1; return chatCompletion({ content: 'not json at all' }); });
    const { handle, logged } = makeHandler(fetchImpl);
    const res = await handle(postReq({ task: 'chat', topic, turns: 1, messages: [{ role: 'me', ru: 'Привет' }] }));
    expect(res.status).toBe(502);
    expect(calls).toBe(1);
    expect(logged[0].status).toBe('invalid_output');
  });

  it('daily 429 -> HTTP 429 quota_exceeded/not-retryable, status provider_quota_day', async () => {
    const fetchImpl = vi.fn(async () => resJson(429, { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } }));
    const { handle, logged } = makeHandler(fetchImpl);
    const res = await handle(postReq({ task: 'chat', topic, turns: 1, messages: [{ role: 'me', ru: 'Привет' }] }));
    expect(res.status).toBe(429);
    const payload = await res.json();
    expect(payload).toMatchObject({ code: 'quota_exceeded', retryable: false });
    expect(logged[0].status).toBe('provider_quota_day');
  });

  it('content_filter -> 422 refused', async () => {
    const fetchImpl = vi.fn(async () => chatCompletion({ finish_reason: 'content_filter' }));
    const { handle, logged } = makeHandler(fetchImpl);
    const res = await handle(postReq({ task: 'chat', topic, turns: 1, messages: [{ role: 'me', ru: 'Привет' }] }));
    expect(res.status).toBe(422);
    expect(logged[0].status).toBe('refused');
  });

  it('success logs the served model and tokens, and no learner text', async () => {
    const fetchImpl = vi.fn(async () => chatCompletion({ model: 'thinkingmachines/inkling:free', usage: { prompt_tokens: 10, completion_tokens: 20 } }));
    const { handle, logged } = makeHandler(fetchImpl);
    const res = await handle(postReq({ task: 'chat', topic, turns: 1, messages: [{ role: 'me', ru: 'Меня зовут Хамад' }] }));
    expect(res.status).toBe(200);
    expect(logged[0]).toMatchObject({ status: 'ok', model: 'thinkingmachines/inkling:free', input_tokens: 10, output_tokens: 20 });
    expect(JSON.stringify(logged[0])).not.toMatch(/Хамад/);
  });
});
