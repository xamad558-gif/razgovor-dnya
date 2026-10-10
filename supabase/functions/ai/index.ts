// Supabase Edge Function "ai": the only place that holds provider secrets.
// Provider switch (ADR 0003): AI_PROVIDER = gigachat (default) | anthropic. One secret flips providers,
// no redeploy needed.
// Deploy:  supabase functions deploy ai
// Secrets:
//   AI_PROVIDER              gigachat (default) | anthropic
//   GIGACHAT_AUTH_KEY        required when AI_PROVIDER=gigachat (developers.sber.ru Authorization key)
//   GIGACHAT_SCOPE           optional, default GIGACHAT_API_PERS
//   GIGACHAT_MODEL[_CHAT|_EVALUATE|_TOPIC]   optional model overrides
//   GIGACHAT_STRUCTURED      optional: on|true|1 enables response_format (Beta)
//   ANTHROPIC_API_KEY        required when AI_PROVIDER=anthropic
//   AI_MODEL                 Anthropic model id (AI_PROVIDER=anthropic only)
//   AI_DAILY_LIMIT           AI requests per user per UTC day
//   ALLOWED_ORIGINS          comma-separated allowed CORS origins
import Anthropic from '@anthropic-ai/sdk';
import { createSupabaseContext } from '@supabase/server';
import { createClient } from '@supabase/supabase-js';
import { createHandler, DEFAULT_ALLOWED_ORIGINS } from '../_shared/handler.js';
import { createProviderFromEnv } from '../_shared/providers.js';
import { RUSSIAN_TRUSTED_CA_PEMS } from '../_shared/russian-trusted-ca.js';

// Server-only admin client (bypasses RLS) for quota and logging.
// Prefer the new secret keys; fall back to the legacy service_role key.
function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    const k = keys.default ?? Object.values(keys)[0];
    if (typeof k === 'string' && k) return k;
  } catch { /* fall through */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}
const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// GigaChat's TLS chain ends at a root (НУЦ Минцифры "Russian Trusted Root CA") not in Deno's default
// (Mozilla) store. Trust it ONLY for GigaChat traffic; every other fetch keeps the default trust.
// TLS verification is never disabled: if the client cannot be built, fall back to plain fetch, which
// still verifies against the default store and fails closed with "UnknownIssuer".
let caClient: Deno.HttpClient | null = null;
try {
  caClient = Deno.createHttpClient({ caCerts: RUSSIAN_TRUSTED_CA_PEMS });
} catch (e) {
  console.error(JSON.stringify({
    level: 'error', msg: 'gigachat ca client unavailable',
    error: String((e as Error)?.message ?? e).slice(0, 300),
  }));
}
const gigachatFetch = (url: string, init: RequestInit) =>
  (caClient ? fetch(url, { ...init, client: caClient } as RequestInit) : fetch(url, init));

// Anthropic SDK is constructed lazily, only when the anthropic provider is actually selected and used.
let anthropic: Anthropic | null = null;
async function anthropicCreate(body: Record<string, unknown>) {
  if (!anthropic) {
    anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY'), timeout: 45_000, maxRetries: 1 });
  }
  try {
    // deno-lint-ignore no-explicit-any
    return await anthropic.beta.messages.create(body as any);
  } catch (e) {
    // Provider error details (type + message, truncated) for diagnosis. API validation messages describe
    // request parameters, not conversation text; the learner's text is never logged.
    // deno-lint-ignore no-explicit-any
    const err = e as any;
    console.error(JSON.stringify({
      level: 'error', msg: 'anthropic error', status: err?.status ?? null,
      type: err?.error?.error?.type ?? err?.name ?? null,
      message: String(err?.error?.error?.message ?? err?.message ?? '').slice(0, 500),
      request_id: err?.request_id ?? err?.headers?.['request-id'] ?? null,
    }));
    throw e;
  }
}

const provider = createProviderFromEnv((k: string) => Deno.env.get(k), {
  gigachatFetch,
  anthropicCreate,
  log: (e: Record<string, unknown>) => console.error(JSON.stringify({ level: 'error', ...e })),
});

const structuredRaw = (Deno.env.get('GIGACHAT_STRUCTURED') ?? '').trim().toLowerCase();
console.log(JSON.stringify({
  level: 'info', msg: 'ai provider', provider: provider.name,
  models: { chat: provider.modelFor('chat'), evaluate: provider.modelFor('evaluate'), topic: provider.modelFor('topic') },
  structured: structuredRaw === 'on' || structuredRaw === 'true' || structuredRaw === '1',
  ca_client: !!caClient,
}));

const handle = createHandler({
  allowedOrigins: (Deno.env.get('ALLOWED_ORIGINS') ?? DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean),
  dailyLimit: Number(Deno.env.get('AI_DAILY_LIMIT') ?? 60),
  requestId: () => crypto.randomUUID(),
  provider,

  async authenticate(req: Request) {
    const { data: ctx, error } = await createSupabaseContext(req, { auth: 'user' });
    if (error || !ctx?.userClaims?.id) return null;
    return ctx.userClaims.id;
  },

  async consumeQuota(userId: string, limit: number) {
    const { data, error } = await admin.rpc('consume_ai_quota', { p_user_id: userId, p_limit: limit });
    if (error) throw error;
    return data as number | null;
  },

  async log(entry: Record<string, unknown>) {
    const { error } = await admin.from('ai_requests').insert(entry);
    if (error) console.error(JSON.stringify({ level: 'error', msg: 'ai_requests insert failed', request_id: entry.request_id, code: error.code }));
    console.log(JSON.stringify({ level: 'info', ...entry }));
  },
});

Deno.serve(handle);
