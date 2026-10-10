import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { normalizeState } from '../domain/progress.js';

// One JSON document holds the learner's state. On Android it lives in
// Preferences (app-private storage, survives restarts and updates, removed on
// uninstall). In a browser (dev) it falls back to localStorage.
// Phase 3 adds cloud sync; this module stays the single persistence boundary.

const KEY = 'razgovor-state-v4';
const LEGACY_KEYS = ['razgovor-v3'];
const native = Capacitor.isNativePlatform();

async function rawGet(key) {
  if (native) return (await Preferences.get({ key })).value;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

async function rawSet(key, value) {
  if (native) return Preferences.set({ key, value });
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked: state stays in memory for this session */
  }
}

export async function loadState() {
  for (const key of [KEY, ...LEGACY_KEYS]) {
    const raw = await rawGet(key);
    if (!raw) continue;
    try {
      return normalizeState(JSON.parse(raw));
    } catch {
      /* corrupt value: try the next key, else start fresh */
    }
  }
  return normalizeState(null);
}

let timer = null;
let pending = null;

/** Debounced save; call flush() before the app goes to the background. */
export function saveState(state) {
  pending = state;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 500);
}

export async function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!pending) return;
  const s = pending;
  pending = null;
  await rawSet(KEY, JSON.stringify({ ...s, updated: Date.now() }));
}
