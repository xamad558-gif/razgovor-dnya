# Runbook: deploy the conversation backend

Time: ~15 minutes. Needs: a Supabase account (free tier is enough), Node 22+, and a **free OpenRouter API key**
(default provider, see step 3). GigaChat and Anthropic also work (`AI_PROVIDER=gigachat` / `anthropic`); see
"Alternative providers" below.

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

## 3. Get a free OpenRouter key (~5 min)
1. Sign in at openrouter.ai.
2. Go to **openrouter.ai/keys** → **Create key**. Name it `razgovor-dnya`. Optional: credit limit `0`. Copy the key
   (`sk-or-…`); it is shown once.
3. Supabase Dashboard → project `razgovor-dnya` → **Edge Functions → Secrets**:
   - Add `OPENROUTER_API_KEY`.
   - Set `AI_DAILY_LIMIT` = `20`.
   - **If an `AI_PROVIDER` secret already exists from an earlier GigaChat setup, delete it or set it to
     `openrouter`.**
4. Privacy settings (do this only if the smoke test later shows `provider_data_policy` in the logs):
   1. Keep OpenRouter **prompt logging off** (default) and leave the default privacy settings for now.
   2. Run the smoke test (step 6).
   3. Only if the function logs show `provider_data_policy` (the upstream error text is
      `No endpoints found matching your data policy`), open **openrouter.ai/settings/privacy** and turn on the
      setting that allows free endpoints / model training on inputs.
   4. Leave any "publish prompts" style setting **off** unless a chosen model cannot work without it; then pick a
      different model (edit `OPENROUTER_MODELS`, step 3 table below) rather than enabling it.
5. Never put the key in the app's `.env`, in a `VITE_*` variable, or in chat. It lives only in the function's
   secrets (step 3 below also covers this for a local `.env` file).

## Certificate check (one time, GigaChat only)
Only needed if you use the GigaChat alternative provider. GigaChat's TLS certificate chains to a root not in most
computers' trust stores (НУЦ Минцифры "Russian Trusted Root CA"). The function already trusts it for GigaChat
traffic only (`_shared/russian-trusted-ca.js`); this step is just to confirm the pinned fingerprint still matches
the official certificate before you rely on it. OpenRouter traffic uses the default trust store; this step does not
apply to it.
1. Download "Russian Trusted Root CA" from https://www.gosuslugi.ru/crt (or https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt).
2. Confirm its SHA-256 fingerprint equals:
   `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`
   - macOS/Linux: `openssl x509 -in <file> -noout -fingerprint -sha256`.
   - Windows: `certutil -hashfile "<file>.cer" SHA256` (on a DER `.cer` file, the file hash is the fingerprint).
3. If it differs, stop and do not deploy — the cert may have been reissued; re-pin `_shared/russian-trusted-ca.js`
   from the current official source first.

## 4. Set the function secrets (server side only)
```bash
cp supabase/functions/.env.example supabase/functions/.env   # fill in OPENROUTER_API_KEY (or another provider's key)
npx supabase secrets set --env-file supabase/functions/.env
```
`supabase/functions/.env` is git-ignored. Never commit it. Never put a provider key in the app's `.env`.

| Secret | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | `openrouter` | `openrouter`, `gigachat` or `anthropic`. One secret switches providers, no redeploy. |
| `OPENROUTER_API_KEY` | (required for openrouter) | the key from openrouter.ai/keys (step 3) |
| `OPENROUTER_MODELS` | `google/gemma-4-31b-it:free,thinkingmachines/inkling:free,nvidia/nemotron-3-ultra-550b-a55b:free` | comma list, replaces the default for every task; primary first, OpenRouter falls back down the list on any error |
| `OPENROUTER_MODEL_CHAT` / `_EVALUATE` / `_TOPIC` | — | per-task override (comma list); wins over `OPENROUTER_MODELS` for that task |
| `OPENROUTER_REASONING` | `low` | `none` / `minimal` / `low` / `medium`; an invalid value falls back to `low` and logs once |
| `GIGACHAT_AUTH_KEY` | (required for gigachat) | the Authorization key from developers.sber.ru (see "Alternative providers") |
| `GIGACHAT_SCOPE` | `GIGACHAT_API_PERS` | OAuth scope; individuals use the personal scope |
| `GIGACHAT_MODEL_CHAT` / `_EVALUATE` / `_TOPIC` | `GigaChat-2-Max` / `GigaChat-2-Max` / `GigaChat-2-Pro` | per-task model override |
| `GIGACHAT_MODEL` | — | overrides all three GigaChat tasks at once (per-task vars win) |
| `GIGACHAT_STRUCTURED` | `off` | `on`/`true`/`1` enables schema-constrained output (Beta); keep off unless verified to work |
| `ANTHROPIC_API_KEY` | (required for anthropic) | Anthropic key, from console.anthropic.com → API Keys |
| `AI_MODEL` | `claude-opus-5-5` | Model for all tasks, only used when `AI_PROVIDER=anthropic` |
| `AI_DAILY_LIMIT` | `60` (code default) | AI requests per user per UTC day (one chat message = one request); **`20` recommended with OpenRouter** (the free tier's whole-account cap is 50/day), `30` was recommended for the GigaChat freemium quota |
| `ALLOWED_ORIGINS` | `https://xamad558-gif.github.io,capacitor://localhost,https://localhost,http://localhost:5173,http://localhost:4173` | the published web app, the iPhone app, Android, and dev servers |

## 5. Deploy the function
```bash
npx supabase functions deploy ai
```

## 6. Point the app at it
```bash
cp .env.example .env     # fill VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
npm run android:sync     # rebuild with the new values, then Run ▶ in Android Studio
```

## 7. Smoke test
- Dashboard → Edge Functions → ai → Logs: one boot line
  `{"msg":"ai provider","provider":"openrouter","models":{...},"reasoning":"low",...}`.
- Open the app → Chat → «ابدأ المحادثة». A reply from the partner must appear.
- Dashboard → Table editor → `ai_requests`: one row with `status = ok`, the model slug that actually served the
  reply (OpenRouter can fall back to a later model in the list), token counts, latency. It never holds message text.

## Operating it
- **Daily cap** is 50 requests/day for the **whole** OpenRouter account on the free tier (not per user), reset at
  00:00 UTC (03:00 Moscow). `AI_DAILY_LIMIT=20` leaves room for retries and more than one learner. 10+ lifetime
  credit purchases raise the account cap to 1000/day.
- **Check usage:** openrouter.ai/activity shows OpenRouter's own request count; compare it against `ai_requests`
  rows for the day — OpenRouter's per-model fallback attempts may count separately (see the plan's risk table).
  ```sql
  select date_trunc('day', created_at) d, model, count(*), sum(input_tokens) in_t, sum(output_tokens) out_t
  from ai_requests group by 1, 2 order by 1 desc;
  ```
- **A free model is retired or renamed:** edit the `OPENROUTER_MODELS` secret (or the per-task variant) and
  `supabase secrets set` again; no redeploy.
- **Status values:** `ok`, `quota_exceeded`, `refused` (moderation or content filter), `truncated`,
  `invalid_output`, `provider_billing`, `provider_data_policy` (apply the privacy step above), `provider_quota_day`
  (OpenRouter's account-wide 50/day cap reached), `provider_error_<status>`, `provider_error_network`,
  `provider_not_configured`, `quota_error`. A rise in `invalid_output` or `provider_error_*` means a model/API
  issue; check function logs for the `openrouter error` / `gigachat error` / `anthropic error` line (never contains
  learner or model text, and never `flagged_input`).
- **Key compromised:** delete the key at openrouter.ai/keys and create a new one (or regenerate the GigaChat
  Authorization key, or revoke the Anthropic key), then `supabase secrets set OPENROUTER_API_KEY=…`. Takes effect
  immediately; no redeploy, no app update.
- **Timeout on free endpoints:** try `OPENROUTER_REASONING=none`, or put the fastest model first in
  `OPENROUTER_MODELS`.
- **Provider outage:** the app shows «الخدمة مزدحمة الآن…» and keeps the learner's message for retry. Cards and
  reviews keep working offline.
- **Rollback:** set the `AI_PROVIDER` secret to `gigachat` or `anthropic` (needs that provider's key; immediate, no
  deploy), or redeploy the function from the previous git commit (`fb4c50d`). The migration is additive; to remove
  it, drop the function and the two tables (no other object depends on them).

## Alternative providers

### GigaChat
Set `AI_PROVIDER=gigachat` and `GIGACHAT_AUTH_KEY` instead of the OpenRouter secret above.
1. Go to developers.sber.ru → **Войти** (Сбер ID) → choose **физическое лицо**.
2. Create a project → **GigaChat API** → accept the terms. The Freemium package appears automatically.
3. Project → **Настройки API** → **Получить ключ** → copy the **Authorization key**. It is shown once. It is **not**
   the Client Secret.
4. Supabase Dashboard → your project → **Edge Functions → Secrets** → add `AI_PROVIDER` = `gigachat` and
   `GIGACHAT_AUTH_KEY` = (the key you copied). Optional: `AI_DAILY_LIMIT` = `30`.
5. Do the "Certificate check" above once.

### Anthropic
Set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` instead of the OpenRouter secret above (skip the certificate
check — GigaChat's CA pin never applies to Anthropic or OpenRouter traffic). Everything else in this runbook is the
same. See ADR 0002 for the Anthropic-specific cost estimate and model choice.
