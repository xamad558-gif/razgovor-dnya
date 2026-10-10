-- Per-user daily AI quota and request log for the "ai" Edge Function.
-- Clients get NO direct access: RLS is on with no policies, and the quota
-- function is executable by service_role only (the Edge Function).

create table public.ai_usage (
  user_id  uuid    not null references auth.users (id) on delete cascade,
  day      date    not null,
  requests integer not null default 0 check (requests >= 0),
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;

create table public.ai_requests (
  id            bigint generated always as identity primary key,
  request_id    uuid        not null,
  user_id       uuid        references auth.users (id) on delete set null,
  task          text        not null check (task in ('chat', 'evaluate', 'topic')),
  model         text,
  status        text        not null,
  input_tokens  integer     check (input_tokens  is null or input_tokens  >= 0),
  output_tokens integer     check (output_tokens is null or output_tokens >= 0),
  latency_ms    integer     check (latency_ms    is null or latency_ms    >= 0),
  created_at    timestamptz not null default now()
);
create index ai_requests_user_created_idx on public.ai_requests (user_id, created_at desc);
alter table public.ai_requests enable row level security;

revoke all on public.ai_usage, public.ai_requests from anon, authenticated;

-- Atomically count one request for p_user_id today (UTC). Returns the new
-- count, or NULL when the limit was already reached (row left unchanged).
create or replace function public.consume_ai_quota(p_user_id uuid, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22004';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'p_limit must be >= 1' using errcode = '22023';
  end if;

  insert into public.ai_usage as u (user_id, day, requests)
  values (p_user_id, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day)
    do update set requests = u.requests + 1
    where u.requests < p_limit
  returning u.requests into v_count;

  return v_count;
end;
$$;

revoke all on function public.consume_ai_quota(uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_ai_quota(uuid, integer) to service_role;
