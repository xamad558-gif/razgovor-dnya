# Разговор дня: project instructions

Daily Russian conversation + flash-card review app for Arabic-speaking learners. Capacitor 8 (**iOS first**: the test device is an iPhone; Android also supported),
Vite, vanilla ES modules. UI language Arabic (RTL); target language Russian.

## Workflow: plan with Opus 5.5, implement with Sonnet 5
| Stage | Agent | Model | Output |
|---|---|---|---|
| 1. Plan | `cto` | `claude-opus-5-5` | `docs/plans/YYYY-MM-DD-<slug>.md` from `docs/plans/TEMPLATE.md` |
| 2. Implement | `implementer` | `claude-sonnet-5` | code + tests + "Implementation report" in the plan |
| 3. Review | `cto` | `claude-opus-5-5` | "Review" in the plan: APPROVED or fixes → back to step 2 |

- Any non-trivial task starts with the `cto` agent. The implementer works only from an approved plan.
- The models are pinned in each agent's frontmatter (`.claude/agents/*.md`); do not override them per call.
- Trivial edits (typo, copy text, one-line fix) can skip the plan.
- Project skills in `.claude/skills/`: `webapp-to-capacitor`, `capacitor-best-practices`, `capacitor-app-development`,
  `supabase`, `claude-api`. Read the relevant one before working in its area.
- UI design skills in `.claude/skills/`: `ui-ux-pro-max`, `design-taste-frontend`, `frontend-design`, `impeccable`,
  `web-design-guidelines`. The `ui-designer` agent uses them to research reference designs and produce first-draft
  HTML prototypes in `docs/ui-prototypes/<slug>/` (with screenshots and a comparison report) before UI work starts.
- This workflow is about **building** the app. The model the app itself uses for conversations is a separate
  runtime setting (`AI_MODEL` secret, ADR 0002).

## Layout
- `src/domain/`: pure logic, no DOM or Capacitor imports. Every change here needs a test in `tests/`.
- `supabase/functions/_shared/ai-contract.js`: tasks, prompts, JSON schemas, validators, model settings. Single source
  of truth for app and backend (`src/shared/ai-contract.js` re-exports it). Prompts live here, never in UI code.
- `supabase/functions/_shared/handler.js`: runtime-agnostic HTTP handler (tested in Node). `ai/index.ts` only wires Deno deps.
- `supabase/migrations/`: SQL. Every change gets a test in `tests/db.test.js` (runs on PGlite).
- `src/auth/session.js`: anonymous Supabase session, stored in Preferences.
- `src/storage/`, `src/notifications/`, `src/platform/`, `src/ai/`: the only modules that touch native plugins or network.
- `src/main.js`: rendering and event wiring only.
- `docs/`: assessment, ADRs, requirements traceability. Update the traceability table when a requirement changes state.

## Rules
- Never put an AI provider key in the app or in any `VITE_*` variable. The key lives only in backend secrets.
- Escape every string from the model or the learner with `esc()` before inserting HTML.
- No inline event handlers (CSP forbids inline script); use `data-act` + the delegated listener.
- Dates are local calendar days (`domain/dates.js`). Never compute days with millisecond arithmetic.
- State changes go through `normalizeState`-compatible shapes. Bump `STATE_VERSION` and migrate for format changes.
- Highlighted vocabulary, badges and buttons use the blue token `--blue` (#185FA5) with white text (readable in dark mode).
- Pin dependencies to exact versions at least 14 days old (`.npmrc` save-exact; Deno pins in `supabase/functions/ai/deno.json`).
- Model id is `claude-opus-5-5` unless the owner decides otherwise (ADR 0002). Read the `claude-api` skill before touching model calls.

## Commands
- `npm test`: unit tests (vitest)
- `npm run build`: production web build into `dist/`
- `npm run ios:sync` / `npm run ios:open`: build + copy into `ios/`, open Xcode (macOS only, see `docs/ios.md`)
- `npm run android:sync`: build + copy into the Android project
- `npm run android:open`: open in Android Studio (build/run the APK there)
- `npx supabase functions deploy ai`, see `docs/deploy-backend.md`
