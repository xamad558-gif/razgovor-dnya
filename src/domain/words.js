import { norm } from './text.js';

export const WORD_KINDS = ['noun', 'verb', 'adj', 'adv', 'phrase'];
export const KNOWN_AFTER = 3; // consecutive correct answers before a word counts as learned

/** Build a clean word record from untrusted input. Returns null if unusable. */
export function makeWord(input, day) {
  const ru = String(input?.ru ?? '').trim().slice(0, 80);
  if (!ru) return null;
  return {
    ru,
    ar: String(input?.ar ?? '').trim().slice(0, 160),
    kind: WORD_KINDS.includes(input?.kind) ? input.kind : '',
    info: String(input?.info ?? '').trim().slice(0, 400),
    date: input?.date || day,
    seen: Number(input?.seen) || 0,
    right: Number(input?.right) || 0,
    wrong: Number(input?.wrong) || 0,
    streak: Number(input?.streak) || 0,
    known: !!input?.known,
  };
}

export function findWord(words, ru) {
  const n = norm(ru);
  return words.find((w) => norm(w.ru) === n) || null;
}

/**
 * Add new words without duplicates (match on normalised Russian form).
 * Returns a NEW array; existing records (and their review stats) are kept.
 */
export function addWords(words, incoming, day) {
  const out = words.slice();
  const index = new Map(out.map((w, i) => [norm(w.ru), i]));
  for (const raw of incoming || []) {
    const w = makeWord(raw, day);
    if (!w) continue;
    const key = norm(w.ru);
    if (index.has(key)) continue;
    index.set(key, out.length);
    out.push(w);
  }
  return out;
}

/** Apply one review answer to a word. Returns a NEW word object. */
export function recordAnswer(word, ok) {
  const w = { ...word, seen: (word.seen || 0) + 1 };
  if (ok) {
    w.right = (word.right || 0) + 1;
    w.streak = (word.streak || 0) + 1;
    if (w.streak >= KNOWN_AFTER) w.known = true;
  } else {
    w.wrong = (word.wrong || 0) + 1;
    w.streak = 0;
    w.known = false;
  }
  return w;
}
