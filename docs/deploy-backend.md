# Runbook: deploy the conversation backend

Time: ~20 minutes. Needs: a Supabase account (free tier is enough), Node 22+, and either a **free GigaChat
Authorization key** (default provider, see step 2b) or an Anthropic API key (`AI_PROVIDER=anthropic`).

## 1. Create the Supabase project
1. supabase.com → New project. Region: Frankfurt (eu-central-1) or the closest to Moscow.
2. **Authentication → Sign In / Providers → Anonymous sign-ins: ON.** The app signs every install in anonymously.
3. **Authentication → Attack Protection:** keep the default rate limit for anonymous sign-ins. Turn on CAPTCHA before a
   public release (prevents scripted mass sign-ups that would each get a daily AI quota).
4. **Project Settings → API Keys:** copy the **Project URL** and the **publishable key** (`sb_publishable_…`).

## 2. Link and push the database migration
```bash
npx supabase login
npx supabase link --project-ref YOUR-PROJECT-REF
npx supabase db push          # creates ai_usage, ai_requests, consume_ai_quota()
npx supabase db advisors      # must report no security warnings for these objects
```

## 2b. Get a GigaChat key (free, ~10 min)
1. Go to developers.sber.ru → **Войти** (Сбер ID) → choose **физическое лицо**.
2. Create a project → **GigaChat API** → accept the terms. The Freemium package appears automatically.
3. Project → **Настройки API** → **Получить ключ** → copy the **Authorization key**. It is shown once. It is **not**
   the Client Secret.
4. Supabase Dashboard → your project → **Edge Functions → Secrets** → add `AI_PROVIDER` = `gigachat` and
   `GIGACHAT_AUTH_KEY` = (the key you copied). Optional: `AI_DAILY_LIMIT` = `30`.
5. Never put the key in the app's `.env`, in a `VITE_*` variable, or in chat messages. It lives only in the function's
   secrets (step 3 below also covers this for a local `.env` file).

## Certificate check (one time)
GigaChat's TLS certificate chains to a root not in most computers' trust stores (НУЦ Минцифры "Russian Trusted Root
CA"). The function already trusts it for GigaChat traffic only (`_shared/russian-trusted-ca.js`); this step is just
to confirm the pinned fingerprint still matches the official certificate before you rely on it.
1. Download "Russian Trusted Root CA" from https://www.gosuslugi.ru/crt (or https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt).
2. Confirm its SHA-256 fingerprint equals:
   `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`
   - macOS/Linux: `openssl x509 -in <file> -noout -fingerprint -sha256`.
   - Windows: `certutil -hashfile "<file>.cer" SHA256` (on a DER `.cer` file, the file hash is the fingerprint).
3. If it differs, stop and do not deploy — the cert may have been reissued; re-pin `_shared/russian-trusted-ca.js`
   from the current official source first.

## 3. Set the function secrets (server side only)
```bash
cp supabase/functions/.env.example supabase/functions/.env   # fill in GIGACHAT_AUTH_KEY (or ANTHROPIC_API_KEY)
npx supabase secrets set --env-file supabase/functions/.env
```
`supabase/functions/.env` is git-ignored. Never commit it. Never put a provider key in the app's `.env`.

| Secret | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | `gigachat` | `gigachat` or `anthropic`. One secret switches providers, no redeploy. |
| `GIGACHAT_AUTH_KEY` | (required for gigachat) | the Authorization key from developers.sber.ru (step 2b) |
| `GIGACHAT_SCOPE` | `GIGACHAT_API_PERS` | OAuth scope; individuals use the personal scope |
| `GIGACHAT_MODEL_CHAT` / `_EVALUATE` / `_TOPIC` | `GigaChat-2-Max` / `GigaChat-2-Max` / `GigaChat-2-Pro` | per-task model override |
| `GIGACHAT_MODEL` | — | overrides all three tasks at once (per-task vars win) |
| `GIGACHAT_STRUCTURED` | `off` | `on`/`true`/`1` enables schema-constrained output (Beta); keep off unless verified to work |
| `ANTHROPIC_API_KEY` | (required for anthropic) | Anthropic key, from console.anthropic.com → API Keys |
| `AI_MODEL` | `claude-opus-5-5` | Model for all tasks, only used when `AI_PROVIDER=anthropic` |
| `AI_DAILY_LIMIT` | `30` | AI requests per user per UTC day (one chat message = one request); `60` default in the Anthropic ADR, `30` recommended for the GigaChat freemium quota |
| `ALLOWED_ORIGINS` | `https://xamad558-gif.github.io,capacitor://localhost,https://localhost,http://localhost:5173,http://localhost:4173` | the published web app, the iPhone app, Android, and dev servers |

## 4. Deploy the function
```bash
npx supabase functions deploy ai
```

## 5. Point the app at it
```bash
cp .env.example .env     # fill VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
npm run android:sync     # rebuild with the new values, then Run ▶ in Android Studio
```

## 6. Smoke test
- Dashboard → Edge Functions → ai → Logs: one boot line `{"msg":"ai provider","provider":"gigachat","ca_client":true,...}`.
  `ca_client:false` means the CA client could not be built (TLS to GigaChat will fail closed — see "Operating it").
- Open the app → Chat → «ابدأ المحادثة». A reply from the partner must appear.
- Dashboard → Table editor → `ai_requests`: one row with `status = ok`, a model string (GigaChat includes its
  version, e.g. `GigaChat-2-Max:2.0.28.2`), token counts, latency. It never holds message text.

## Operating it
- **Cost / quota per user** is bounded by `AI_DAILY_LIMIT`. Watch `ai_requests` token totals weekly:
  ```sql
  select date_trunc('day', created_at) d, model, count(*), sum(input_tokens) in_t, sum(output_tokens) out_t
  from ai_requests group by 1, 2 order by 1 desc;
  ```
- **Status values:** `ok`, `ok_repaired` (GigaChat replied invalid JSON once, then valid), `quota_exceeded`,
  `refused` (including GigaChat `blacklist` topic refusals), `truncated`, `invalid_output`, `provider_billing`
  (tokens exhausted — see below), `provider_error_<status>`, `provider_error_oauth_<status>`,
  `provider_error_network`, `provider_not_configured`, `quota_error`. A rise in `invalid_output` or
  `provider_error_*` means a model/API issue; check function logs for the `gigachat error` / `anthropic error` line
  (never contains learner or model text).
- **Key compromised:** regenerate the Authorization key in the Sber project (or revoke the Anthropic key in its
  console and create a new one), then `supabase secrets set GIGACHAT_AUTH_KEY=…` (or `ANTHROPIC_API_KEY=…`). Takes
  effect immediately; no redeploy, no app update.
- **Tokens exhausted (`provider_billing`, GigaChat 402):** switch to a different bucket with
  `GIGACHAT_MODEL_CHAT=GigaChat-3-Ultra` (or `GigaChat-2-Pro`), or wait for the freemium package to renew, or buy a
  package. No redeploy needed.
- **Busy (429, "too many concurrent streams"):** the freemium tier allows one concurrent request; the function
  retries once automatically, then returns "busy". Expected under rapid double-taps, not under normal single-learner
  use.
- **Provider outage:** the app shows «الخدمة مزدحمة الآن…» and keeps the learner's message for retry. Cards and
  reviews keep working offline.
- **Rollback:** set the `AI_PROVIDER=anthropic` secret (immediate, no deploy; needs a funded `ANTHROPIC_API_KEY`), or
  redeploy the function from the previous git commit. The migration is additive; to remove it, drop the function and
  the two tables (no other object depends on them).

## Alternative provider: Anthropic
Set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` instead of the GigaChat secrets above (skip step 2b and the
certificate check). Everything else in this runbook is the same. See ADR 0002 for the Anthropic-specific cost
estimate and model choice.
