import { Capacitor } from '@capacitor/core';
import { TextToSpeech } from '@capacitor-community/text-to-speech';

// Android WebView does not implement window.speechSynthesis, so the native
// engine is required in the app. The web API is kept for browser dev runs.

export async function speakRussian(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (Capacitor.isNativePlatform()) {
    try {
      await TextToSpeech.stop();
      await TextToSpeech.speak({ text: t, lang: 'ru-RU', rate: 0.85 });
      return true;
    } catch {
      return false; // no Russian voice installed, or engine unavailable
    }
  }
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(t);
  u.lang = 'ru-RU';
  u.rate = 0.85;
  const v = window.speechSynthesis.getVoices().find((x) => x.lang && x.lang.startsWith('ru'));
  if (v) u.voice = v;
  window.speechSynthesis.speak(u);
  return true;
}
