# Web version on iPhone (installed from Safari)

Same code as the native app, built as an installable web app (PWA) and hosted on GitHub Pages. No Mac, no Apple fee.

## Publish (once)
1. Create a **public** GitHub repository (e.g. `razgovor-dnya`) and push this project to `main`.
2. Repository → **Settings → Pages → Source: GitHub Actions**.
3. The `pages` workflow runs tests, builds, and publishes to `https://<user>.github.io/<repo>/`.
4. After the backend is deployed (`docs/deploy-backend.md`), add repository **Variables** `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY` and re-run the workflow to enable the conversation.

## Install on the iPhone
Open the link in **Safari** → Share → **Add to Home Screen** → Add. Open it from the home-screen icon (not from
Safari) so it runs full-screen and keeps its own storage.

## What works / what doesn't
| Feature | Web on iPhone |
|---|---|
| Cards, random reviews, schedule, history, streaks | ✅ offline (service worker caches the app) |
| Saved progress | ✅ on the phone (home-screen apps keep their storage; the app also requests persistent storage) |
| Russian pronunciation 🔊 | ✅ iOS built-in voice |
| Conversation | ✅ once the backend is deployed and the two variables are set |
| Scheduled reminders from inside the app | ❌ not possible for web apps on iOS; use the Reminders app (already set) or server push (future work) |

Updates: every push to `main` publishes a new version; the app picks it up the next time it is opened online.
