# Runbook: deploy the conversation backend

Time: ~20 minutes. Needs: a Supabase account (free tier is enough), an Anthropic API key, Node 22+.

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

## 3. Set the function secrets (server side only)
```bash
cp supabase/functions/.env.example supabase/functions/.env   # fill in ANTHROPIC_API_KEY
npx supabase secrets set --env-file supabase/functions/.env
```
`supabase/functions/.env` is git-ignored. Never commit it. Never put the Anthropic key in the app's `.env`.

| Secret | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Anthropic key, from console.anthropic.com → API Keys |
| `AI_MODEL` | `claude-opus-5-5` | Model for all tasks. Change only after comparing quality (see ADR 0002) |
| `AI_DAILY_LIMIT` | `60` | AI requests per user per UTC day (one chat message = one request) |
| `ALLOWED_ORIGINS` | `capacitor://localhost,https://localhost,http://localhost:5173,http://localhost:4173` | `capacitor://localhost` is the iPhone app, `https://localhost` Android; the rest are dev servers |

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
- Open the app → Chat → «ابدأ المحادثة». A reply from the partner must appear.
- Dashboard → Table editor → `ai_requests`: one row with `status = ok`, token counts, latency. It never holds message text.
- Dashboard → Edge Functions → ai → Logs: one JSON line per request.

## Operating it
- **Cost per user** is bounded by `AI_DAILY_LIMIT`. Watch `ai_requests` token totals weekly:
  ```sql
  select date_trunc('day', created_at) d, model, count(*), sum(input_tokens) in_t, sum(output_tokens) out_t
  from ai_requests group by 1, 2 order by 1 desc;
  ```
- **Status values:** `ok`, `quota_exceeded`, `refused`, `truncated`, `invalid_output`, `provider_error_<status>`,
  `quota_error`. A rise in `invalid_output` or `provider_error_*` means a model/API issue; check function logs.
- **Key compromised:** revoke it in the Anthropic console, create a new one, `supabase secrets set ANTHROPIC_API_KEY=…`.
  Takes effect immediately; no redeploy, no app update.
- **Provider outage:** the app shows «الخدمة مزدحمة الآن…» and keeps the learner's message for retry. Cards and
  reviews keep working offline.
- **Rollback:** `supabase functions deploy ai` from the previous git commit. The migration is additive; to remove it,
  drop the function and the two tables (no other object depends on them).
