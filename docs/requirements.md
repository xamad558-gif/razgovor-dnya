# Requirements traceability

States: IMPLEMENTED_VERIFIED · IMPLEMENTED_NEEDS_FIX · PARTIAL · MISSING · BLOCKED_EXTERNAL · NOT_APPLICABLE

| ID | Requirement | Source | Implementation | Evidence | Status |
|---|---|---|---|---|---|
| R1 | A different conversation topic every day (weather, food, politics, religion, philosophy, sport, poetry, literature…) | Learner request | `domain/topics.js` 31 topics, coprime rotation | test "cycles through every topic once per cycle" | IMPLEMENTED_VERIFIED |
| R2 | Simple language with new words explained (meaning, verbs with aspect + conjugation) | Learner request | Prompt rules + JSON schema in `_shared/ai-contract.js`; word cards | contract + handler + GigaChat provider tests; Deno boot test | IMPLEMENTED_NEEDS_FIX → needs live run with GigaChat key + quality eval |
| R3 | Learner can suggest the topic | Learner request | `topic` task + UI | contract + handler + GigaChat provider tests | IMPLEMENTED_NEEDS_FIX → needs live run with GigaChat key + quality eval |
| R4 | Corrections with Arabic explanation; listen to own correct sentence or the corrected one | Learner request | correction schema; 🔊 buttons | contract + handler + GigaChat provider tests | IMPLEMENTED_NEEDS_FIX → needs live run with GigaChat key + quality eval |
| R5 | Conversations saved and re-readable | Learner request | `archiveChat`, history panel | tests (dedup, cap 60) | IMPLEMENTED_VERIFIED |
| R6 | Vocabulary flash cards | Learner request | `domain/review.js`, flip card UI | tests + headless run of a full session | IMPLEMENTED_VERIFIED |
| R7 | Cards in random order, no fixed order | Learner request | Fisher–Yates per session, random side | test "order varies between sessions" | IMPLEMENTED_VERIFIED |
| R8 | Morning and evening review schedule | Learner request | slots, 7-day table, `markReviewDone` | tests + headless run (slot persisted after reload) | IMPLEMENTED_VERIFIED |
| R9 | Reminders for reviews and conversation | Learner request | `notifications/reminders.js`, settings UI | schedule tests; not yet run on a phone | IMPLEMENTED_NEEDS_FIX → verify on device |
| R10 | Data saved for the user | Learner request | on-device Preferences | headless reload test (web fallback) | PARTIAL (no cloud backup yet) |
| R11 | Works as a mobile app, **iPhone first** | Learner request | Capacitor iOS + Android projects, privacy manifest, iOS origin allowed | **iOS Simulator build passed on GitHub macOS runner** (workflow `ios`, run 38058486920); origin test | PARTIAL: compiles; installing on a device still needs a Mac or signing route (docs/ios.md) |
| R13 | Usable on the iPhone without a Mac | Owner | installable web app (manifest, icons, iOS meta, generated service worker), GitHub Pages workflow | headless iPhone-sized test: installed metadata, SW controls page, full offline reload + card review, no errors | IMPLEMENTED_VERIFIED: live at https://xamad558-gif.github.io/razgovor-dnya/ (manifest + service worker served) |
| R12 | Listen to Russian on the phone | Learner request | native TTS plugin (AVSpeechSynthesizer on iOS) | API verified in typings; not run on device | PARTIAL |
| S1 | No AI provider key in the app | CTO | backend-only key, `.env.example` | test asserts no key in headers; `GIGACHAT_AUTH_KEY` only in function secrets | IMPLEMENTED_VERIFIED |
| S2 | Untrusted model output cannot inject HTML | CTO | `esc()`, schema validation, CSP | tests | IMPLEMENTED_VERIFIED |
| S3 | Endpoint cannot be used as a general LLM proxy | CTO | typed tasks, server-side prompts, 32 KB body cap, JWT required | handler tests; live 401 on forged JWT | IMPLEMENTED_VERIFIED (deploy pending) |
| S4 | Per-user rate limit / cost cap | CTO | `consume_ai_quota` (service_role only), `AI_DAILY_LIMIT` | SQL tests on Postgres (PGlite), handler tests | IMPLEMENTED_VERIFIED (deploy pending) |
| S7 | AI usage observable without storing text | CTO | `ai_requests` log, JSON function logs | handler test asserts no text in log; provider error logs tested for no text/key | IMPLEMENTED_VERIFIED |
| S8 | Dependencies pinned, no fresh releases | CTO | exact versions ≥14 days old (vitest 10 days, dev-only); GigaChat uses plain `fetch`, no new dependency | Deno min-age policy passes | IMPLEMENTED_VERIFIED |
| S5 | Cloud backup and multi-device sync | CTO | anonymous user exists; sync not built | — | MISSING (Phase 3) |
| S6 | Account deletion / data export (store policy) | CTO | local reset exists | — | PARTIAL (Phase 3 for cloud data) |
| A1 | Conversation provider switchable: GigaChat default, Anthropic kept | Owner (ADR 0003) | `AI_PROVIDER` secret; `_shared/providers.js` (`createProviderFromEnv`, `createGigaChatProvider`, `createAnthropicProvider`) | provider unit tests (`tests/gigachat.test.js`) + handler tests (`tests/backend.test.js`) | IMPLEMENTED_NEEDS_FIX → live run with owner's key |
| S9 | Extra TLS trust (Russian Trusted Root CA) only on GigaChat requests; verification never disabled | CTO (ADR 0003) | `_shared/russian-trusted-ca.js`; `Deno.createHttpClient` scoped to the GigaChat fetch wrapper only (`ai/index.ts`) | CA fingerprint + chain pin test; code review: no `unsafelyIgnoreCertificateErrors`, no `DENO_TLS_CA_STORE` change | IMPLEMENTED_NEEDS_FIX → live TLS handshake from Supabase |
