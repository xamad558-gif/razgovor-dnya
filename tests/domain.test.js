import { describe, it, expect } from 'vitest';
import { dayKey, todayKey, yesterdayKey, addDays, slotAt, lastDays, parseTime, dayNumber } from '../src/domain/dates.js';
import { norm, esc, highlightTaught } from '../src/domain/text.js';
import { addWords, recordAnswer, findWord, makeWord, KNOWN_AFTER } from '../src/domain/words.js';
import { shuffle, createSession, flip, answerCard, currentCard } from '../src/domain/review.js';
import {
  blankState, normalizeState, effectiveStreak, markConversationDone, markReviewDone, reviewDone, archiveChat, MAX_HISTORY,
} from '../src/domain/progress.js';
import { TOPICS, topicIndexFor, topicOf } from '../src/domain/topics.js';

// Deterministic RNG for tests (mulberry32).
function seeded(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = (ru) => makeWord({ ru, ar: 'x' }, '2026-10-10');

describe('dates', () => {
  it('formats local day keys with padding', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
  it('yesterday crosses month and year boundaries', () => {
    expect(yesterdayKey(new Date(2026, 0, 1, 10))).toBe('2025-12-31');
    expect(yesterdayKey(new Date(2026, 2, 1, 0, 5))).toBe('2026-02-28');
  });
  it('addDays uses the calendar, not 24h steps', () => {
    expect(dayKey(addDays(new Date(2026, 2, 29, 0, 30), 1))).toBe('2026-03-30');
  });
  it('splits review slots at 15:00 local', () => {
    expect(slotAt(new Date(2026, 9, 10, 14, 59))).toBe('am');
    expect(slotAt(new Date(2026, 9, 10, 15, 0))).toBe('pm');
  });
  it('lastDays returns n days oldest first, ending today', () => {
    const now = new Date(2026, 9, 10);
    const d = lastDays(7, now).map(dayKey);
    expect(d).toHaveLength(7);
    expect(d[6]).toBe(todayKey(now));
    expect(d[0]).toBe('2026-10-04');
  });
  it('parses valid HH:MM only', () => {
    expect(parseTime('09:00')).toEqual({ hour: 9, minute: 0 });
    expect(parseTime('21:30')).toEqual({ hour: 21, minute: 30 });
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('9:7')).toBeNull();
    expect(parseTime('')).toBeNull();
  });
  it('dayNumber increments by one per local day', () => {
    expect(dayNumber(new Date(2026, 9, 11, 1)) - dayNumber(new Date(2026, 9, 10, 23))).toBe(1);
  });
});

describe('text', () => {
  it('normalises ё and case', () => {
    expect(norm('  Ёлка ')).toBe('елка');
  });
  it('escapes HTML from untrusted model output', () => {
    expect(esc('<img src=x onerror="a">')).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;');
  });
  it('highlights inflected forms of taught words and escapes the rest', () => {
    const html = highlightTaught('Я люблю гулять <b>', [{ ru: 'гулять' }]);
    expect(html).toContain('<mark class="nw">гулять</mark>');
    expect(html).toContain('&lt;b&gt;');
    expect(highlightTaught('Мы гуляли', [{ ru: 'гулять' }])).toContain('<mark class="nw">гуляли</mark>');
  });
});

describe('words', () => {
  it('adds words without duplicates (ё/case-insensitive) and keeps stats', () => {
    let list = addWords([], [{ ru: 'ёлка', ar: 'شجرة' }], 'd1');
    list[0] = recordAnswer(list[0], true);
    list = addWords(list, [{ ru: 'Елка' }, { ru: 'дом' }, { ru: '' }, null], 'd2');
    expect(list.map((w) => w.ru)).toEqual(['ёлка', 'дом']);
    expect(list[0].right).toBe(1);
  });
  it('rejects unknown kinds and clamps lengths', () => {
    const w = makeWord({ ru: 'а'.repeat(200), kind: 'script' }, 'd');
    expect(w.ru).toHaveLength(80);
    expect(w.kind).toBe('');
  });
  it(`marks a word known after ${KNOWN_AFTER} correct answers in a row, and resets on a miss`, () => {
    let w = W('дом');
    for (let i = 0; i < KNOWN_AFTER; i++) w = recordAnswer(w, true);
    expect(w.known).toBe(true);
    w = recordAnswer(w, false);
    expect(w.known).toBe(false);
    expect(w.streak).toBe(0);
    expect(w.seen).toBe(KNOWN_AFTER + 1);
  });
  it('finds words by normalised form', () => {
    expect(findWord([W('ёж')], 'ЕЖ').ru).toBe('ёж');
  });
});

describe('review sessions', () => {
  const words = ['один', 'два', 'три', 'четыре', 'пять', 'шесть'].map(W);

  it('shuffle is a permutation and does not mutate input', () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input, seeded(1));
    expect(out.slice().sort()).toEqual([1, 2, 3, 4, 5]);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });
  it('order varies between sessions (no fixed order)', () => {
    const rng = seeded(42);
    const orders = new Set();
    for (let i = 0; i < 30; i++) orders.add(createSession({ words, size: 0, slot: 'am', rng }).queue.map((c) => c.ru).join());
    expect(orders.size).toBeGreaterThan(20);
  });
  it('respects the session size and "all"', () => {
    expect(createSession({ words, size: 3, slot: 'am' }).total).toBe(3);
    expect(createSession({ words, size: 0, slot: 'am' }).total).toBe(6);
    expect(createSession({ words, size: 20, slot: 'am' }).total).toBe(6);
  });
  it('an empty word list yields a finished session', () => {
    expect(createSession({ words: [], size: 10, slot: 'pm' }).done).toBe(true);
  });
  it('ignores answers before the card is flipped', () => {
    const s = createSession({ words, size: 2, slot: 'am' });
    expect(answerCard(s, true)).toBe(s);
  });
  it('re-queues a missed card once, from the other side, without double-counting', () => {
    let s = createSession({ words: words.slice(0, 2), size: 0, slot: 'am', rng: seeded(3) });
    const first = currentCard(s);
    s = answerCard(flip(s), false, seeded(9));
    expect(s.queue).toHaveLength(3);
    const again = s.queue.find((c) => c.again);
    expect(again.ru).toBe(first.ru);
    expect(again.dir).not.toBe(first.dir);
    while (!s.done) {
      const c = currentCard(s);
      s = answerCard(flip(s), !c.again ? true : false, seeded(5));
    }
    expect(s.queue).toHaveLength(3); // a re-shown miss is not re-queued again
    expect(s.wrong).toBe(1);
    expect(s.right).toBe(1);
    expect(s.total).toBe(2);
  });
});

describe('progress & streaks', () => {
  const day = (d, h = 12) => new Date(2026, 9, d, h);

  it('normalizes garbage and old versions safely', () => {
    expect(normalizeState(null)).toEqual(blankState());
    const s = normalizeState({ streak: -3, words: [{ ru: 'да' }, null, {}], revSize: 7, chat: { msgs: 'x' } });
    expect(s.streak).toBe(0);
    expect(s.words).toHaveLength(1);
    expect(s.revSize).toBe(15);
    expect(s.chat).toBeNull();
    expect(s.reminders.am).toBe('09:00');
  });
  it('starts, extends and resets the conversation streak', () => {
    let s = markConversationDone(blankState(), 'الطقس', day(8));
    expect(s.streak).toBe(1);
    s = markConversationDone(s, 'الأكل', day(9));
    expect(s.streak).toBe(2);
    expect(effectiveStreak(s, day(10))).toBe(2);
    expect(effectiveStreak(s, day(11))).toBe(0);
    s = markConversationDone(s, 'الفن', day(12));
    expect(s.streak).toBe(1);
  });
  it('marking the same day twice is idempotent', () => {
    const a = markConversationDone(blankState(), 'x', day(8, 9));
    const b = markConversationDone(a, 'y', day(8, 22));
    expect(b).toBe(a);
  });
  it('a conversation finished just after midnight counts for the new day', () => {
    let s = markConversationDone(blankState(), 'x', day(8, 23));
    s = markConversationDone(s, 'y', day(9, 0));
    expect(s.streak).toBe(2);
  });
  it('records morning/evening reviews per day', () => {
    let s = markReviewDone(blankState(), 'am', day(10, 9));
    expect(reviewDone(s, '2026-10-10', 'am')).toBe(true);
    expect(reviewDone(s, '2026-10-10', 'pm')).toBe(false);
    s = markReviewDone(s, 'pm', day(10, 21));
    expect(s.reviews['2026-10-10']).toEqual({ am: true, pm: true });
  });
  it('archives conversations, deduplicated and capped', () => {
    let s = blankState();
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      s = { ...s, chat: { id: 'c' + i, date: 'd', topic: 0, msgs: [{ role: 'me', ru: 'привет' }] } };
      s = archiveChat(s);
    }
    s = archiveChat(s); // same id again
    expect(s.history).toHaveLength(MAX_HISTORY);
    expect(s.history[s.history.length - 1].id).toBe('c' + (MAX_HISTORY + 4));
  });
});

describe('topics', () => {
  it('cycles through every topic once per cycle', () => {
    const seen = new Set();
    for (let i = 0; i < TOPICS.length; i++) seen.add(topicIndexFor(addDays(new Date(2026, 9, 1), i)));
    expect(seen.size).toBe(TOPICS.length);
  });
  it('prefers a custom topic when present', () => {
    expect(topicOf({ topic: 2, custom: { who: 'Антон' } }).who).toBe('Антон');
    expect(topicOf({ topic: 2 }).ru).toBe(TOPICS[2].ru);
  });
});
