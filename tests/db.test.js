import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';

// Runs the real migration on Postgres (PGlite = Postgres compiled to WASM)
// with a minimal stand-in for Supabase's auth schema and API roles.
const SUPABASE_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';

let db;
const asRole = async (role, sql, params) => {
  await db.query(`set role ${role}`);
  try { return await db.query(sql, params); } finally { await db.query('reset role'); }
};
const consume = (user, limit) => asRole('service_role', 'select public.consume_ai_quota($1, $2) as n', [user, limit]).then((r) => r.rows[0].n);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const f of readdirSync('supabase/migrations').sort()) await db.exec(readFileSync('supabase/migrations/' + f, 'utf8'));
  await db.query('insert into auth.users (id) values ($1), ($2)', [U1, U2]);
}, 60000);

describe('ai quota migration', () => {
  it('counts up to the limit, then returns null without incrementing', async () => {
    expect(await consume(U1, 3)).toBe(1);
    expect(await consume(U1, 3)).toBe(2);
    expect(await consume(U1, 3)).toBe(3);
    expect(await consume(U1, 3)).toBeNull();
    expect(await consume(U1, 3)).toBeNull();
    const r = await db.query('select requests from public.ai_usage where user_id = $1', [U1]);
    expect(r.rows[0].requests).toBe(3);
  });
  it('keeps users independent', async () => {
    expect(await consume(U2, 3)).toBe(1);
  });
  it('rejects bad arguments', async () => {
    await expect(consume(U1, 0)).rejects.toThrow(/p_limit/);
    await expect(consume(null, 5)).rejects.toThrow(/p_user_id/);
  });
  it('app roles cannot call the quota function or touch the tables', async () => {
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(role, 'select public.consume_ai_quota($1, 1000)', [U1])).rejects.toThrow(/permission denied/);
      await expect(asRole(role, 'select * from public.ai_usage')).rejects.toThrow(/permission denied/);
      await expect(asRole(role, "insert into public.ai_requests (request_id, task, status) values (gen_random_uuid(), 'chat', 'ok')")).rejects.toThrow(/permission denied/);
    }
  });
  it('enforces task values and non-negative counters', async () => {
    await expect(db.query("insert into public.ai_requests (request_id, task, status) values (gen_random_uuid(), 'hack', 'ok')")).rejects.toThrow(/check/);
    await expect(db.query("insert into public.ai_requests (request_id, task, status, input_tokens) values (gen_random_uuid(), 'chat', 'ok', -1)")).rejects.toThrow(/check/);
  });
  it('deleting a user removes their quota rows and keeps anonymised request logs', async () => {
    await db.query("insert into public.ai_requests (request_id, user_id, task, status) values (gen_random_uuid(), $1, 'chat', 'ok')", [U2]);
    await db.query('delete from auth.users where id = $1', [U2]);
    expect((await db.query('select count(*)::int as n from public.ai_usage where user_id = $1', [U2])).rows[0].n).toBe(0);
    const logs = await db.query("select user_id from public.ai_requests where task = 'chat' and status = 'ok'");
    expect(logs.rows.every((r) => r.user_id === null)).toBe(true);
  });
});
