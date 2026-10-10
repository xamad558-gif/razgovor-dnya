/** Normalise Russian text for comparison: lowercase, ё→е, trimmed. */
export function norm(s) {
  return String(s ?? '').toLowerCase().replace(/ё/g, 'е').trim();
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for safe insertion into HTML (AI output is untrusted). */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/**
 * Wrap words in `text` that start with the stem of any taught word in
 * <mark>. Returns escaped HTML. Stemming is deliberately crude: it only
 * needs to catch inflected forms of the taught word in the same reply.
 */
export function highlightTaught(text, words) {
  const stems = (words || [])
    .map((w) => {
      let b = norm(String(w.ru || '').split(/\s+/)[0]).replace(/(ся|сь)$/, '');
      if (b.length > 5) b = b.slice(0, -3);
      else if (b.length > 3) b = b.slice(0, -1);
      return b;
    })
    .filter((s) => s.length >= 3);
  return String(text ?? '')
    .split(/([А-Яа-яЁё]+)/)
    .map((part) => {
      if (/^[А-Яа-яЁё]+$/.test(part)) {
        const n = norm(part);
        if (stems.some((s) => n.startsWith(s))) return '<mark class="nw">' + esc(part) + '</mark>';
      }
      return esc(part);
    })
    .join('');
}
