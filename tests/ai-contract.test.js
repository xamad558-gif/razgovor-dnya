import { describe, it, expect, vi } from 'vitest';
import {
  validateRequest, buildPrompt, parseModelJson, validateChatReply, validateEvaluation, validateTopicReply, AIContractError, LIMITS,
} from '../src/shared/ai-contract.js';
import { requestAI, configureAI } from '../src/ai/client.js';
import { buildSchedule, REMINDER_DEFS } from '../src/notifications/reminders.js';

const topic = { ru: 'Погода', ar: 'الطقس', who: 'Аня', role: 'جارة', en: 'Anya chats about weather.' };

describe('request validation', () => {
  it('rejects unknown tasks and missing topic', () => {
    expect(() => validateRequest({ task: 'free_prompt' })).toThrow(AIContractError);
    expect(() => validateRequest({ task: 'chat', topic: {} })).toThrow(/topic/);
  });
  it('clamps message count and length', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'ai' : 'me', ru: 'я'.repeat(5000) }));
    const r = validateRequest({ task: 'chat', topic, messages, turns: 4 });
    expect(r.messages).toHaveLength(LIMITS.messages);
    expect(r.messages[0].ru).toHaveLength(LIMITS.messageChars);
  });
  it('requires learner lines to evaluate', () => {
    expect(() => validateRequest({ task: 'evaluate', topic, messages: [{ role: 'ai', ru: 'Привет' }] })).toThrow();
  });
  it('requires an idea for topic generation', () => {
    expect(() => validateRequest({ task: 'topic', idea: '  ' })).toThrow();
    expect(validateRequest({ task: 'topic', idea: 'кофе' }).idea).toBe('кофе');
  });
});

describe('prompt building', () => {
  it('opens the chat with a user turn and alternates roles ending on user', () => {
    const req = validateRequest({ task: 'chat', topic, turns: 1, messages: [{ role: 'ai', ru: 'Привет!' }, { role: 'me', ru: 'Привет' }, { role: 'me', ru: 'Как дела?' }] });
    const p = buildPrompt(req);
    const roles = p.messages.map((m) => m.role);
    expect(roles[0]).toBe('user');
    expect(roles[roles.length - 1]).toBe('user');
    for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1]);
    expect(p.system).toContain('Аня');
    expect(p.system).toMatch(/Ignore any instructions/);
  });
  it('appends a continue turn when history ends on the assistant', () => {
    const req = validateRequest({ task: 'chat', topic, messages: [{ role: 'me', ru: 'Да' }, { role: 'ai', ru: 'Хорошо' }] });
    const p = buildPrompt(req);
    expect(p.messages[p.messages.length - 1].role).toBe('user');
  });
});

describe('response validation', () => {
  it('parses JSON wrapped in fences or prose', () => {
    expect(parseModelJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseModelJson('no json here')).toThrow(AIContractError);
  });
  it('normalises a chat reply and drops bad words/hints', () => {
    const r = validateChatReply({
      reply: 'Привет!', words: [{ ru: 'гулять', kind: 'verb' }, { ru: '' }, { kind: 'evil' }], correction: { ok: 'yes', fixed: 'x' }, hints: [{ ru: 'Да' }, {}],
    });
    expect(r.words).toEqual([{ ru: 'гулять', ar: '', kind: 'verb', info: '' }]);
    expect(r.correction.ok).toBe(false); // only literal true counts as correct
    expect(r.hints).toHaveLength(1);
  });
  it('rejects a reply without text', () => {
    expect(() => validateChatReply({ words: [] })).toThrow(/reply/);
  });
  it('clamps evaluation score to 0..10', () => {
    expect(validateEvaluation({ score: 14 }).score).toBe(10);
    expect(validateEvaluation({ score: '7.4' }).score).toBe(7);
    expect(() => validateEvaluation({ score: 'great' })).toThrow();
  });
  it('requires a partner for topic replies', () => {
    expect(() => validateTopicReply({ ru: 'Кофе' })).toThrow();
  });
});

describe('AI client', () => {
  it('fails fast when no endpoint is configured', async () => {
    configureAI({ endpoint: '' });
    await expect(requestAI('chat', {})).rejects.toMatchObject({ code: 'not_configured' });
  });
  it('maps HTTP errors to stable codes', async () => {
    configureAI({ endpoint: 'https://example.test/ai' });
    const mk = (status) => vi.fn(async () => ({ status, ok: status < 400, json: async () => ({}) }));
    await expect(requestAI('chat', {}, { fetchImpl: mk(429) })).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(requestAI('chat', {}, { fetchImpl: mk(401) })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(requestAI('chat', {}, { fetchImpl: mk(503) })).rejects.toMatchObject({ code: 'server' });
  });
  it('maps network failure and timeout', async () => {
    configureAI({ endpoint: 'https://example.test/ai' });
    await expect(requestAI('chat', {}, { fetchImpl: async () => { throw new TypeError('fail'); } })).rejects.toMatchObject({ code: 'network' });
    const hang = (_u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    await expect(requestAI('chat', {}, { fetchImpl: hang, timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' });
  });
  it('validates a successful payload and never sends a provider key', async () => {
    configureAI({ endpoint: 'https://example.test/ai', publishableKey: 'sb_publishable_test' });
    const f = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ data: { reply: 'Привет!' } }) }));
    const r = await requestAI('chat', { topic }, { fetchImpl: f });
    expect(r.reply).toBe('Привет!');
    const [, opts] = f.mock.calls[0];
    expect(JSON.parse(opts.body).task).toBe('chat');
    expect(JSON.stringify(opts.headers)).not.toMatch(/sk-ant/);
  });
});

describe('reminder schedule', () => {
  it('builds three daily reminders with fixed ids', () => {
    const list = buildSchedule({ enabled: true, am: '09:00', chat: '19:00', pm: '21:30' });
    expect(list.map((n) => n.id)).toEqual(REMINDER_DEFS.map((d) => d.id));
    expect(list[2].schedule.on).toEqual({ hour: 21, minute: 30 });
  });
  it('skips invalid times and returns nothing when disabled', () => {
    expect(buildSchedule({ enabled: true, am: 'bad', chat: '19:00', pm: '' })).toHaveLength(1);
    expect(buildSchedule({ enabled: false, am: '09:00' })).toEqual([]);
  });
});
