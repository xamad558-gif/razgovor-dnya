// Flash-card review sessions. Order is random by design (the learner asked
// for no fixed order). The RNG is injectable so the logic is testable.

export function shuffle(items, rng = Math.random) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const SESSION_SIZES = [10, 15, 20, 0]; // 0 = all words

/**
 * Create a session from the word list.
 * Each card shows either the Russian side ("ru") or the Arabic side ("ar")
 * first, chosen at random.
 */
export function createSession({ words, size, slot, rng = Math.random }) {
  const pool = shuffle(words, rng);
  const n = size ? Math.min(size, pool.length) : pool.length;
  return {
    slot,
    index: 0,
    right: 0,
    wrong: 0,
    total: n,
    flipped: false,
    done: n === 0,
    queue: pool.slice(0, n).map((w) => ({ ru: w.ru, dir: rng() < 0.5 ? 'ru' : 'ar', again: false })),
  };
}

export function currentCard(session) {
  return session && !session.done ? session.queue[session.index] : null;
}

export function flip(session) {
  if (!session || session.done) return session;
  return { ...session, flipped: !session.flipped };
}

/**
 * Record an answer for the current card. A missed card is re-inserted once,
 * at a random later position, shown from the opposite side. Re-shown cards
 * do not change the session score (first attempt counts).
 * Answers are only accepted after the card was flipped.
 */
export function answerCard(session, ok, rng = Math.random) {
  if (!session || session.done || !session.flipped) return session;
  const card = session.queue[session.index];
  const queue = session.queue.slice();
  let { right, wrong } = session;
  if (!card.again) {
    if (ok) right++;
    else wrong++;
  }
  if (!ok && !card.again) {
    const rest = queue.length - session.index - 1;
    const pos = session.index + 1 + Math.floor(rng() * (rest + 1));
    queue.splice(pos, 0, { ru: card.ru, dir: card.dir === 'ru' ? 'ar' : 'ru', again: true });
  }
  const index = session.index + 1;
  return { ...session, queue, right, wrong, index, flipped: false, done: index >= queue.length };
}
