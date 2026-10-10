# CTO Assessment: Разговор дня (Oct 2026)

## Executive assessment

**What exists.** A single-file HTML app (~900 lines) published as a claude.ai artifact. It runs a daily Russian
conversation with an AI partner, collects new vocabulary, runs flip-card reviews in random order with a morning and
evening schedule, and tracks streaks and history. It relies on the claude.ai host for three things: AI calls through the
viewer's own Claude account (`sample`), per-user storage (`db`), and identity (`user`).

**Quality.** The product logic is sound and the UX is thoughtful (RTL, dark mode, error states, offline detection,
draft preservation). The engineering is prototype-grade: one file mixes domain logic, rendering, storage and AI calls;
there are no tests; HTML is built with string concatenation and inline `onclick` handlers.

**Main risk.** The app cannot leave claude.ai as it is. Its three load-bearing dependencies (AI, storage, identity) are
host capabilities that do not exist in a phone app. Reminders were never part of the app at all: they were created by
hand in the phone's Reminders app.

**Production readiness.** Not production-ready as a mobile app. Ready as a personal artifact.

**Most important recommendation.** Keep the product and UI. Re-platform the foundations: Capacitor (Android first),
pure tested domain modules, on-device storage and notifications now, and a small backend that owns the AI key and
prompts next.

## What should stay
- Product behaviour: daily topic rotation, custom topics, corrections with Arabic explanations, word extraction,
  random card order with re-queue of missed cards, morning/evening slots, streaks, history.
- Visual identity: the tear-off calendar sheet, palette tokens, typography, RTL layout, dark mode.
- Topic catalogue and prompt rules.

## Findings

| # | Problem | Evidence | Impact | Sev | Fix (status) |
|---|---|---|---|---|---|
| 1 | AI depends on claude.ai `sample` | `claude.use("sample")` | Conversation cannot work outside claude.ai | P0 for mobile | Backend function owns key + prompts; app calls it via a typed contract (contract + client done; backend = Phase 2) |
| 2 | Provider key would be exposed if called from the app | Earlier file version called `api.anthropic.com` from the browser | Key theft, unbounded cost | P0 | App never holds a key; `.env.example` documents this; tests assert no key in headers (done) |
| 3 | Raw prompts sent from client | Prompt text built in the page | Any client could use the endpoint as a free general LLM proxy | P1 | Prompts moved to the shared contract, built server-side from validated task inputs (done) |
| 4 | Untrusted model output inserted into HTML | String-built HTML | XSS via model output | P1 | Every model string passes `esc()`; response schemas validate types/lengths; tests cover escaping (done) |
| 5 | Inline event handlers | `onclick="..."` throughout | Blocks a strict CSP | P2 | Single delegated listener + CSP `script-src 'self'` (done) |
| 6 | Speech does not work in Android WebView | `speechSynthesis` absent in WebView | 🔊 buttons silently fail on phones | P1 | Native TTS plugin with web fallback (done) |
| 7 | Reminders not part of the app | Created manually in iOS Reminders | No reminders for any other user; no settings | P1 | On-device scheduled notifications with fixed ids, settings UI, tap routing (done) |
| 8 | No tests | none | Regressions in streak/date/review logic go unnoticed | P2 | 45 unit tests over domain, contract, client, schedule (done) |
| 9 | Date logic mixed local/UTC risk | inline date helpers | Streak breaks around midnight/DST | P2 | Local-calendar date module with DST-safe arithmetic, tested (done) |
| 10 | State schema implicit | ad-hoc fields | Crashes on old/corrupt data | P2 | `normalizeState` versioned migration, never throws, tested (done) |
| 11 | Fonts from Google CDN | `<link>` to fonts.googleapis.com | Broken typography offline | P3 | Self-hosted via @fontsource (done) |
| 12 | RTL fractions render reversed | `1 / 7` showed as `7 / 1` | Misread scores | P3 | `<bdi dir="ltr">` (done) |
| 13 | No cloud backup/sync yet | local only | Data lost on uninstall / phone change | P1 | Phase 3: Supabase auth (anonymous → linkable) + sync |

## Target architecture

```
Android app (Capacitor 8, Vite, vanilla JS modules)
 ├─ domain/        pure logic: dates, words, review, progress, topics   (unit-tested)
 ├─ shared/        AI contract: task schemas, prompt builders, validators (shared with backend)
 ├─ storage/       Preferences (on device) ── Phase 3: sync to Supabase Postgres
 ├─ notifications/ on-device daily schedule (works offline)
 ├─ platform/      native TTS
 └─ ai/client      POST {task, inputs} → backend, timeout, error codes, schema validation
                        │
                        ▼  HTTPS + user JWT
Supabase Edge Function "ai" (Phase 2)
 ├─ verify JWT, per-user daily quota (Postgres table)
 ├─ validateRequest → buildPrompt → Anthropic Messages API (key in function secrets)
 └─ parseModelJson → validate → return {data}
```

Modular monolith on the client, one small backend function. No microservices, no custom auth.

## Trust boundaries
- **Device → backend:** authenticated (JWT), validated (`validateRequest`), size-limited, rate-limited (Phase 2).
- **Backend → AI provider:** key only in function secrets; timeout; output validated before returning.
- **Model output → UI:** treated as untrusted; escaped; schema-validated; learner text cannot change rules
  (prompt rule 8).
