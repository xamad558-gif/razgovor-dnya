import { todayKey, yesterdayKey } from './dates.js';

export const STATE_VERSION = 4;
export const MAX_HISTORY = 60;
export const MAX_REVIEW_DAYS = 90;
export const MAX_WORDS = 2000;

export const DEFAULT_REMINDERS = { enabled: true, am: '09:00', chat: '19:00', pm: '21:30' };

export function blankState() {
  return {
    v: STATE_VERSION,
    streak: 0,
    lastDone: null,
    done: {},
    words: [],
    history: [],
    reviews: {},
    revSize: 15,
    reminders: { ...DEFAULT_REMINDERS },
    remSet: false, // the learner has turned reminders on at least once
    chat: null,
    updated: 0,
  };
}

/**
 * Accept state from storage (any earlier version, or garbage) and return a
 * well-formed current-version state. Never throws.
 */
export function normalizeState(raw) {
  const s = blankState();
  if (!raw || typeof raw !== 'object') return s;
  s.streak = Number.isInteger(raw.streak) && raw.streak > 0 ? raw.streak : 0;
  s.lastDone = typeof raw.lastDone === 'string' ? raw.lastDone : null;
  s.done = raw.done && typeof raw.done === 'object' ? { ...raw.done } : {};
  s.words = Array.isArray(raw.words) ? raw.words.filter((w) => w && w.ru).slice(-MAX_WORDS) : [];
  s.history = Array.isArray(raw.history) ? raw.history.filter((h) => h && h.id).slice(-MAX_HISTORY) : [];
  s.reviews = raw.reviews && typeof raw.reviews === 'object' ? { ...raw.reviews } : {};
  s.revSize = [10, 15, 20, 0].includes(raw.revSize) ? raw.revSize : 15;
  s.reminders = { ...DEFAULT_REMINDERS, ...(raw.reminders || {}) };
  s.remSet = raw.remSet === true;
  s.chat = raw.chat && typeof raw.chat === 'object' && Array.isArray(raw.chat.msgs) ? raw.chat : null;
  s.updated = Number(raw.updated) || 0;
  return s;
}

/** A streak survives only if the last completed day is today or yesterday. */
export function effectiveStreak(state, now = new Date()) {
  const t = todayKey(now);
  const y = yesterdayKey(now);
  return state.lastDone === t || state.lastDone === y ? state.streak : 0;
}

/** Mark today's conversation as done. Idempotent within a day. */
export function markConversationDone(state, topicLabel, now = new Date()) {
  const t = todayKey(now);
  if (state.done[t] !== undefined) return state;
  const streak = state.lastDone === yesterdayKey(now) ? effectiveStreak(state, now) + 1 : 1;
  return { ...state, streak, lastDone: t, done: { ...state.done, [t]: topicLabel } };
}

/** Mark a morning/evening review as done for today. Idempotent. */
export function markReviewDone(state, slot, now = new Date()) {
  const t = todayKey(now);
  const day = { ...(state.reviews[t] || {}), [slot]: true };
  const reviews = { ...state.reviews, [t]: day };
  const keys = Object.keys(reviews).sort();
  while (keys.length > MAX_REVIEW_DAYS) delete reviews[keys.shift()];
  return { ...state, reviews };
}

export function reviewDone(state, day, slot) {
  return !!(state.reviews[day] && state.reviews[day][slot]);
}

/** Append a finished/abandoned conversation to the history (dedup by id). */
export function archiveChat(state) {
  const c = state.chat;
  if (!c || !c.msgs || !c.msgs.length) return state;
  const entry = {
    id: c.id,
    date: c.date,
    topic: c.topic,
    custom: c.custom || null,
    score: c.summary ? c.summary.score : null,
    msgs: c.msgs.map((m) =>
      m.role === 'ai'
        ? { role: 'ai', ru: m.ru, ar: m.ar, words: m.words || [] }
        : { role: 'me', ru: m.ru, corr: m.corr || null },
    ),
  };
  const history = state.history.filter((h) => h.id !== entry.id).concat(entry).slice(-MAX_HISTORY);
  return { ...state, history };
}
