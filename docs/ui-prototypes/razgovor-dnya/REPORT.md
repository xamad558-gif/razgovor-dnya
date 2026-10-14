# Разговор дня: UI prototypes (first draft)

Open `index.html` (gallery with three live iframes) or any screen directly: `home.html`, `chat.html`, `flashcards.html`.
Each file is self-contained (inline CSS and JS, no build step, event wiring via `addEventListener`, no inline handlers).

## 1. Brief and assumptions
- Product: daily Russian conversation plus flash-card review for Arabic-speaking A2 learners. iPhone first, 390 px primary, Capacitor shell.
- `lang="ar" dir="rtl"`; Russian snippets isolated with `lang="ru"`, `.ru` (LTR) or `<bdi>`.
- Constraints taken from CLAUDE.md and `src/styles.css`: `--blue #185FA5` with white text for highlighted words, badges and buttons; palette tokens, PT Sans / PT Serif / Noto Naskh Arabic kept; dark mode via `prefers-color-scheme`.
- Assumptions: this is a refinement of the existing identity (the tear-off sheet is already the app's concept), not a rebrand. Western digits everywhere (matches the app and the `A2`/time strings). Dates are static (14 Oct 2026, Wednesday); real code must use `domain/dates.js`.
- No PRODUCT.md exists, so the impeccable context launcher asked for `init`; I treated the work as extending the incumbent system and did not write PRODUCT.md (offer: run `/impeccable init` as a follow-up).

## 2. Research (8 references, principles only)
| # | Reference | Pattern seen | Principle borrowed |
|---|---|---|---|
| 1 | Duolingo blog, "core tabs redesign" (blog.duolingo.com/core-tabs-redesign) | Fixed bottom tab bar, flat cards on light grey, one header style, extra containers removed | Fixed 3-tab bar, one title style, whitespace instead of nested boxes |
| 2 | Pratt IxD critique of Duolingo iPhone (ixd.prattsi.org/2020/09/design-critique-duolingo-iphone-app/) | Course path, progress shown without "how many left"; critic wants "4/6" | Always show "3 من 8" and "5 من 9" next to bars |
| 3 | UX Planet, Duolingo after 400 days (uxplanet.org/...c4d4809bdb37) | Distinct correct/incorrect feedback; streak motivates more than currency | Correction card with icon and label (not colour alone); streak as the only reward on Home |
| 4 | Anki manual, studying (docs.ankiweb.net/studying.html) | Deck counts first; question first, "show answer" then rating, each button shows the next interval | Rating enabled only after flip; sub-label under each button states when the card returns |
| 5 | Dribbble collection of streak/calendar shots (dribbble.com/mjknight/collections/6685722-VD; only titles/tags readable) | Seven day markers with filled / outlined / missed states | 7-dot streak row on Home; icon + word statuses in the schedule table |
| 6 | Contra, Dolern AI language app (contra.com/p/NLZWAcYs-...) | Distraction-free practice screen, one focal element, dark theme with a single warm accent | One focal element per screen (date sheet, card); one accent (blue) |
| 7 | Contra, Anki mobile concept (contra.com/p/M7WsUWsM-...; text only, image not readable) | Thumb-friendly review layout | Rating buttons in the bottom thumb zone, 64 px high |
| 8 | screensdesign.com, Duolingo onboarding (screensdesign.com/articles/duolingo-onboarding-design/) | Make the next step obvious; show the new state after an action; weekly schedule as commitment | Single primary button above the fold; progress updates immediately; 7-day schedule table |
Also opened: WordPress.org `thinko` (LMS block theme, dark green and coral, pattern-heavy): not useful for a native-style app, only confirmed the "course card grid" pattern to avoid.
Blocked or failed fetches: Mobbin, Busuu, Memrise (fetch errors, not worked around). Dribbble and Contra pages gave tags/text only, so reference scores below are inferred from the described principles, not from pixels.

## 3. Design system
Tool output (`ui-ux-pro-max --design-system`) suggested a landing-page pattern (hero + testimonials), claymorphism, Baloo 2 / Comic Neue, indigo. Rejected: wrong product type (app, not landing page), kids-toy style, and it conflicts with the mandated blue and the Arabic type. Kept from its UX data: 44 pt targets, 8 px gaps, `Noto Sans Arabic` pairing for UI chrome.
Direction: **"paper wall calendar, quiet app around it"**. The sheet (binder holes, perforation with notches, stack of sheets behind, red numeral) is the only expressive element; everything else is flat paper surfaces, 1 px borders, 14 px radius.

Tokens (`:root`, dark override under `@media (prefers-color-scheme: dark)` guarded by `:not([data-theme="light"])` and again for `[data-theme="dark"]`):
- Colour: `--bg #E9EDF2`, `--paper #FBFBF8`, `--ink #1B2430`, `--muted #5B6878`, `--blue #185FA5` (+ white), `--red #B3261E` (date only), `--ok #1E7A46`, `--warn #9A5B00`. New: `--ring` (blue light, `#7DB7F0` dark: focus, progress, selected borders), `--edge` (3:1 input borders), `--stack`.
- Type: PT Serif (date, Russian titles, card word), PT Sans (all Russian text), Noto Naskh Arabic (Arabic reading text, as in the app), Noto Sans Arabic (Arabic UI chrome: buttons, badges, tabs, table; Naskh is too fine at 12-15 px). Scale 13 / 15 / 16 / 19 / 24 / 30; date 112; card word 48.
- Space 4/8/12/16/24/32, radius 8/14/pill (pill only for chips and badges), one ease-out curve, one authored motion (sheet tear on "موضوع آخر"); card flip answers a tap; `prefers-reduced-motion` swaps the flip for a crossfade.
- Contrast (computed): text pairs 4.8-15:1 in both themes; white on `--blue` 6.5:1; `--ok`/`--warn` only as text/borders on paper (white-on-`--ok` fails in dark, 2.25:1, so never used as a fill).

## 4. Screens
1. `home.html`: date sheet with today's Russian topic, Arabic subtitle, partner line, primary «ابدأ المحادثة», «موضوع آخر» (cycles 3 topics with tear animation), streak with 7 dots and word count, own-topic field with 5 idea chips (chip fills the field; empty submit shows a status message).
2. `chat.html`: sticky header (back, topic, "الدور 3 من 8", 8-segment bar, «إنهاء المحادثة» opening a confirm dialog), partner bubbles with blue `mark` words, listen (speechSynthesis ru-RU) and translation toggles (`aria-pressed`), word cards (word, kind badge, meaning, aspect-pair note), learner bubbles with "صحيح" card or correction card (struck / bold-underlined diff, Arabic rule, listen), typing line, hint chips, composer pinned above the safe area; sending appends a bubble and advances the counter.
3. `flashcards.html`: morning (done) and evening (now) slots with icon + text status, progress "5 من 9", flip card (Russian front with stress mark, Arabic back with kind badge and example), «عرفتها / لم أعرفها» enabled after flip with next-interval sub-labels, finish state, 7-day `<table>` (Mon-Sun, status = icon + word).
Tab bar (home / chat / cards) on Home and Cards; Chat is a pushed screen with back, no tab bar (iOS convention).

## 5. Audit results
Screenshots: `screenshots/{home,chat,flashcards,index}-{390,768,1440}[-dark].png` plus `flashcards-390-flipped.png`. Full-page shots show the fixed tab bar mid-page (screenshot artefact). Fonts in screenshots were injected from local `@fontsource` files because Google Fonts is blocked in this sandbox; the HTML itself links Google Fonts.
- `impeccable detect`: first run flagged the animated typing dots on every page (shared CSS, and decorative liveness): replaced by static text "آنا تكتب…". Second run: one `flat-type-hierarchy` warning on `chat.html`, a false positive from a screen-reader-only `h1` (16 px) being counted; left as is.
- `web-design-guidelines` (manual pass against the fetched rules; there is no runnable script): fixed missing skip link, `theme-color`, `translate="no"` on the brand, textarea `name`, placeholder ellipsis, hover states, `overscroll-behavior` on hints/dialog, `aria-live` on the card button, missing `h1` on Chat. Passes: `:focus-visible` ring, no `transition: all`, reduced motion, `touch-action`, safe-area insets, `<label>` on inputs, no inline handlers, `color-scheme`.
- Dark mode pass: blue as a border/fill on dark paper was 2.4:1, so borders, progress and segments use `--ring`; input borders use `--edge`.
- Bidi fix: the Arabic rule mixing `-а` and `каша ← кашу` rendered scrambled; each Cyrillic token is now its own `<bdi>` and arrows were removed from running Arabic text.
- Not verified: real iPhone Safari, Dynamic Type, VoiceOver, the dialog on iOS. One fix pass done, then stopped.

## 6. Comparison rubric (1-5; references scored from the principles gathered, so evidence is partial)
| Criterion | Mine | Duolingo core tabs | Anki review | Dolern / Dribbble |
|---|---|---|---|---|
| Primary action clarity | 5 (one filled button, above fold) | 4 | 5 (one "show answer") | 4 |
| Visual hierarchy | 4 (sheet dominates, strip and chips quiet) | 4 | 3 | 4 |
| Navigation | 4 (3 tabs + pushed chat) | 5 | 2 | 3 |
| Typography | 4 (3 faces, clear scale) | 4 | 2 | 3 |
| Colour / contrast | 4 (checked both themes) | 4 | 3 | 3 (dark orange on dark unverified) |
| Density / spacing | 4 | 4 | 3 | 4 |
| Mobile ergonomics | 4 (44+ px targets, thumb-zone rating) | 5 | 3 | 4 |
| Accessibility | 4 (no colour-only status, focus ring) | 3 | 2 | 2 |
| RTL correctness | 4 (logical CSS, bdi) | n/a | n/a | n/a |
| Distinctiveness | 4 (calendar sheet) | 3 | 1 | 3 |

Three biggest gaps against the best reference and what to do:
1. Navigation depth: Duolingo-style apps give a persistent path of lessons; here Chat has no tab and history/settings are absent. Next: decide whether Chat gets a tab or remains pushed; add a history list.
2. Feedback richness: reference apps pair correct/incorrect with sound and motion; the correction card here is text only. Next: optional haptic and short chime on rate/correction (Capacitor Haptics), behind a setting.
3. Anki-style rating granularity: only two ratings; interval hints are static text. Next: bind the sub-labels to the real scheduler in `src/domain` and decide whether a third "hard" state is wanted (product decision).

## 7. Implementation notes (next steps)
| Prototype part | Maps to |
|---|---|
| Tokens, `.btn`, `.ghost`, `.chip`, `.kind` | `src/styles.css` (merge `--ring`, `--edge`, `--stack`; add Noto Sans Arabic for chrome) |
| Tab bar | new `renderTabBar()` in `src/main.js` with `data-act="tab"`, `aria-current` |
| Date sheet, topic, partner, own-topic | home render function; `domain/dates.js` for date; `src/ai/` for topic suggestion |
| Bubbles, word cards, correction card | chat render; all model strings through `esc()`; `mark.nw` from the AI contract's highlighted words |
| Composer, hints | existing composer; hints from AI contract |
| Flip card, rating, schedule table | flash-card view; intervals from the review scheduler in `src/domain/` |
| End dialog | `<dialog>` is fine in WKWebView 15.4+, verify on the test device |
Replace `addEventListener` per element with the existing delegated `data-act` listener. Fix in the app now: `.donebadge` uses white text on `--ok`, which is 2.25:1 in dark mode.
