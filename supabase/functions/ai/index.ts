// Supabase Edge Function "ai": the only place that holds the Anthropic key.
// Deploy:  supabase functions deploy ai
// Secrets: supabase secrets set ANTHROPIC_API_KEY=... [AI_MODEL=...] [AI_DAILY_LIMIT=...] [ALLOWED_ORIGINS=...]
import Anthropic from '@anthropic-ai/sdk';
import { createSupabaseContext } from '@supabase/server';
import { createClient } from '@supabase/supabase-js';
import { createHandler, DEFAULT_ALLOWED_ORIGINS } from '../_shared/handler.js';
import { DEFAULT_MODEL } from '../_shared/ai-contract.js';

const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
const anthropic = new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 });

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

const handle = createHandler({
  allowedOrigins: (Deno.env.get('ALLOWED_ORIGINS') ?? DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean),
  model: Deno.env.get('AI_MODEL') || DEFAULT_MODEL,
  dailyLimit: Number(Deno.env.get('AI_DAILY_LIMIT') ?? 60),
  requestId: () => crypto.randomUUID(),

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

  async callModel(body: Record<string, unknown>) {
    if (!apiKey) throw Object.assign(new Error('ANTHROPIC_API_KEY not set'), { status: 500 });
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
  },

  async log(entry: Record<string, unknown>) {
    const { error } = await admin.from('ai_requests').insert(entry);
    if (error) console.error(JSON.stringify({ level: 'error', msg: 'ai_requests insert failed', request_id: entry.request_id, code: error.code }));
    console.log(JSON.stringify({ level: 'info', ...entry }));
  },
});

Deno.serve(handle);
