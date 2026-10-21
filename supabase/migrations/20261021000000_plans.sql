-- Account-free shared plans.
--
-- The tables are closed to the browser (RLS on, no policies, no privileges for anon or authenticated).
-- Five SECURITY DEFINER functions are the only door in. Each one takes the plan's secret, which is
-- stored only as a sha256 hash, so holding the link is the whole authorization.
--
-- Errors use custom SQLSTATEs that PostgREST turns into HTTP statuses:
--   PT401 invalid key, PT400 invalid argument, PT413 too large, PT429 per-plan cap reached.

create table public.plans (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  secret_hash text not null unique,
  title       text not null,
  subtitle    text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table public.answers (
  plan_id    uuid not null references public.plans (id) on delete cascade,
  qid        text not null,
  v          jsonb not null,
  by_name    text,
  updated_at timestamptz not null default now(),
  primary key (plan_id, qid)
);

create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  plan_id    uuid not null references public.plans (id) on delete cascade,
  scope      text not null,
  author     text not null,
  body       text not null,
  created_at timestamptz not null default now()
);
create index comments_plan_created_idx on public.comments (plan_id, created_at);

create table public.plan_docs (
  plan_id    uuid primary key references public.plans (id) on delete cascade,
  doc        jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.plans enable row level security;
alter table public.answers enable row level security;
alter table public.comments enable row level security;
alter table public.plan_docs enable row level security;
revoke all on public.plans, public.answers, public.comments, public.plan_docs from anon, authenticated;

-- Internal helper: the plan a secret belongs to, or null. Not callable from the browser.
create function public._plan_id(p_secret text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.plans
  where secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex')
$$;
revoke all on function public._plan_id(text) from public, anon, authenticated;

-- Everything the page shows, in one round trip. Null means the key is unknown.
create function public.plan_get(p_secret text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_plan public.plans%rowtype;
begin
  select * into v_plan from public.plans where id = public._plan_id(p_secret);
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'meta', jsonb_build_object('title', v_plan.title, 'subtitle', v_plan.subtitle) || v_plan.meta,
    'answers', coalesce((
      select jsonb_object_agg(a.qid, jsonb_build_object('v', a.v, 'by', a.by_name, 'at', a.updated_at))
      from public.answers a where a.plan_id = v_plan.id
    ), '{}'::jsonb),
    'comments', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'scope', c.scope, 'author', c.author, 'body', c.body, 'at', c.created_at)
                       order by c.created_at, c.id)
      from public.comments c where c.plan_id = v_plan.id
    ), '[]'::jsonb),
    'plan', (select d.doc from public.plan_docs d where d.plan_id = v_plan.id),
    'now', now()
  );
end
$$;

-- Sets one answer. An empty value ('', [], json null, sql null) clears it.
create function public.answer_set(p_secret text, p_qid text, p_v jsonb, p_by text default null)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_plan uuid := public._plan_id(p_secret);
  v_now  timestamptz := now();
begin
  if v_plan is null then
    raise exception 'invalid_key' using errcode = 'PT401';
  end if;
  if p_qid is null or p_qid !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  if p_by is not null and char_length(p_by) > 40 then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  if p_v is not null and octet_length(p_v::text) > 4096 then
    raise exception 'too_large' using errcode = 'PT413';
  end if;

  if p_v is null or p_v = 'null'::jsonb or p_v = '""'::jsonb or p_v = '[]'::jsonb then
    delete from public.answers where plan_id = v_plan and qid = p_qid;
    return v_now;
  end if;

  if not exists (select 1 from public.answers where plan_id = v_plan and qid = p_qid)
     and (select count(*) from public.answers where plan_id = v_plan) >= 300 then
    raise exception 'limit' using errcode = 'PT429';
  end if;

  insert into public.answers (plan_id, qid, v, by_name, updated_at)
  values (v_plan, p_qid, p_v, nullif(btrim(p_by), ''), v_now)
  on conflict (plan_id, qid)
  do update set v = excluded.v, by_name = excluded.by_name, updated_at = excluded.updated_at;
  return v_now;
end
$$;

create function public.comment_add(p_secret text, p_scope text, p_author text, p_body text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_plan   uuid := public._plan_id(p_secret);
  v_author text := btrim(coalesce(p_author, ''));
  v_body   text := btrim(coalesce(p_body, ''));
  v_row    public.comments%rowtype;
begin
  if v_plan is null then
    raise exception 'invalid_key' using errcode = 'PT401';
  end if;
  if p_scope is null or p_scope !~ '^(general|q:[a-z0-9][a-z0-9_-]{0,63}|day:[0-9]{1,2})$' then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  if char_length(v_author) not between 1 and 40 or char_length(v_body) not between 1 and 2000 then
    raise exception 'invalid_argument' using errcode = 'PT400';
  end if;
  if (select count(*) from public.comments where plan_id = v_plan) >= 2000 then
    raise exception 'limit' using errcode = 'PT429';
  end if;

  insert into public.comments (plan_id, scope, author, body)
  values (v_plan, p_scope, v_author, v_body)
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'scope', v_row.scope, 'author', v_row.author, 'body', v_row.body, 'at', v_row.created_at);
end
$$;

create function public.comment_delete(p_secret text, p_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_plan uuid := public._plan_id(p_secret);
  v_n    integer;
begin
  if v_plan is null then
    raise exception 'invalid_key' using errcode = 'PT401';
  end if;
  delete from public.comments where id = p_id and plan_id = v_plan;
  get diagnostics v_n = row_count;
  return v_n > 0;
end
$$;

-- Keep-alive for the free tier: no secret, no data.
create function public.plan_ping() returns text
language sql stable as $$ select 'ok'::text $$;

revoke all on function public.plan_get(text) from public, anon, authenticated;
revoke all on function public.answer_set(text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.comment_add(text, text, text, text) from public, anon, authenticated;
revoke all on function public.comment_delete(text, uuid) from public, anon, authenticated;
revoke all on function public.plan_ping() from public, anon, authenticated;

grant execute on function public.plan_get(text) to anon, authenticated;
grant execute on function public.answer_set(text, text, jsonb, text) to anon, authenticated;
grant execute on function public.comment_add(text, text, text, text) to anon, authenticated;
grant execute on function public.comment_delete(text, uuid) to anon, authenticated;
grant execute on function public.plan_ping() to anon, authenticated;
