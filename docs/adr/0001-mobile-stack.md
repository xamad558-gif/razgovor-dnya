# ADR 0001: Capacitor for the mobile app, Supabase for backend

**Status:** Accepted (Oct 2026). Amended 10 Oct 2026: **iOS is the primary platform** (the owner's test device is an
iPhone); Android stays supported from the same code.

## Context
The working product is a vanilla HTML/JS app with an RTL Arabic UI, built for claude.ai. The goal is an installable
phone app that keeps the learner's data and sends review and conversation reminders. One developer (student) maintains
it; Android is the first target. The same domain may later feed the ВКР language platform.

## Options
1. **Capacitor** around the existing web code.
2. **React Native / Expo:** rewrite UI in React Native components.
3. **Flutter:** rewrite in Dart.
4. **Native Kotlin.**
5. **PWA only.**

## Decision
Capacitor 8, Android first. Supabase (Postgres, Auth, Edge Functions) as the backend in later phases.

## Rationale
- Reuses the existing, already-polished UI and logic: weeks saved versus a rewrite (options 2–4).
- The app's native needs are small and covered by maintained official/community plugins: scheduled local
  notifications, key-value storage, text-to-speech, app lifecycle.
- Text-heavy RTL UI is a strength of web rendering, and the team's skills are web/JS/Python.
- A PWA (option 5) has weaker scheduled notifications and no TTS guarantee on Android WebView-based shells.
- Supabase gives auth, Postgres with row-level security, and server functions without running servers; it is
  open-source and self-hostable (Docker), which matches the ВКР sustainability plan.

## Trade-offs
- WebView UI is not fully native; mitigated by safe areas, touch-target sizes, offline-first behaviour.
- Store review can reject "thin WebView wrappers"; mitigated because the app has real native features
  (notifications, TTS, offline storage).
- Supabase lock-in is moderate; the AI contract and storage module are the only integration points.

## Reversibility
High for the backend (two modules touch it). Medium for the UI framework: domain and contract modules are
framework-free and would survive a move to React Native or Flutter-with-JS-bridge.
