// All dates are the learner's LOCAL calendar days, stored as "YYYY-MM-DD".
// The device clock/timezone is authoritative: streaks and review slots follow
// the learner's day, never UTC or a server timezone.

const pad = (n) => (n < 10 ? '0' + n : String(n));

export function dayKey(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function todayKey(now = new Date()) {
  return dayKey(now);
}

export function addDays(now, delta) {
  // Use the calendar (setDate) rather than adding 86 400 000 ms so DST
  // transitions never skip or repeat a day.
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() + delta);
  return d;
}

export function yesterdayKey(now = new Date()) {
  return dayKey(addDays(now, -1));
}

/** Stable integer for the local calendar day, used to rotate the daily topic. */
export function dayNumber(now = new Date()) {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
}

/** Review slot for a moment: morning before 15:00 local, evening after. */
export function slotAt(now = new Date()) {
  return now.getHours() < 15 ? 'am' : 'pm';
}

/** Last `n` local days ending today, oldest first. */
export function lastDays(n, now = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(now, -i));
  return out;
}

/** Parse "HH:MM" (24h). Returns null when invalid. */
export function parseTime(s) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s || '').trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}
