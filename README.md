# Разговор дня

Daily Russian conversation practice, vocabulary flash cards with a morning/evening review schedule, and on-device
reminders. Arabic interface (RTL).

## Use it on your iPhone today (no Mac)
Install the web version from Safari: `docs/web-iphone.md`.

## Run the native app on your iPhone
See `docs/ios.md`: building for iPhone needs a Mac with Xcode (free Apple ID is enough for testing).

## Run it on an Android phone

Prerequisites on your computer: Node.js 22+, Android Studio (with an SDK installed), a phone with USB debugging on.

```bash
npm install
npm test               # 45 unit tests
npm run android:sync   # builds the web app and copies it into android/
npm run android:open   # opens Android Studio
```

In Android Studio press **Run ▶** with the phone connected. On first launch tap **فعّل التذكيرات اليومية** and allow
notifications.

To hear Russian (🔊), the phone needs a Russian voice: Settings → System → Languages → Text-to-speech → Google
engine → install Russian voice data.

## Conversation backend
Deploy once with `docs/deploy-backend.md` (Supabase + Anthropic key, ~20 min), then put the two public values in `.env`
and rebuild. Without them the app still works offline (cards, reviews, reminders) and the chat tab says so.

## Status
- Offline: flash cards, random-order reviews, morning/evening schedule, history, streaks, reminders.
- Conversation: backend built and tested (68 tests, Deno type-check, boot test); waiting for deployment with your key.

See `docs/assessment.md`, `docs/adr/`, `docs/requirements.md`.
