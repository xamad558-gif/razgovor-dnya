import { createClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { AIContractError } from '../shared/ai-contract.js';

// Every install gets an anonymous Supabase user on first AI use, with no sign-up form.
// The session (refresh token) lives in app-private Preferences on Android.
// Phase 3 can link this user to an email/Google account without losing data.

const url = (import.meta.env?.VITE_SUPABASE_URL || '').replace(/\/$/, '');
export const publishableKey = import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY || '';
export const aiEndpoint = url ? url + '/functions/v1/ai' : '';

const nativeStorage = {
  getItem: async (key) => (await Preferences.get({ key })).value,
  setItem: (key, value) => Preferences.set({ key, value }),
  removeItem: (key) => Preferences.remove({ key }),
};

export const supabase = url && publishableKey
  ? createClient(url, publishableKey, {
    auth: {
      storage: Capacitor.isNativePlatform() ? nativeStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  })
  : null;

export const backendConfigured = () => !!supabase;

let signingIn = null;

/** Return a valid access token, creating the anonymous user on first use. */
export async function getAccessToken() {
  if (!supabase) return '';
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.access_token;
  if (!signingIn) signingIn = supabase.auth.signInAnonymously().finally(() => { signingIn = null; });
  const { data: res, error } = await signingIn;
  if (error || !res?.session) throw new AIContractError('unauthorized', error?.message || 'anonymous sign-in failed');
  return res.session.access_token;
}

/** Pause token refresh in the background, resume in the foreground (Supabase guidance for mobile). */
export function setForeground(active) {
  if (!supabase) return;
  if (active) supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
}
