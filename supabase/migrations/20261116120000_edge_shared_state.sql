-- State the backend shares between its two runtimes: Apps Script and the
-- Supabase Edge Function `api`.
--
-- While both serve requests, anything one of them keeps to itself would let the
-- other act on an old copy. So the settings that used to be Apps Script Script
-- Properties, the script lock and the cache entries that are not mere display
-- summaries live here, where both see the same thing.
--
-- app_properties  every setting that was a Script Property (users, the session
--                 secret, the bot token and chat ids, the webhook secret, the
--                 cache revision counters...), except the four that say where
--                 the database is. Written by the backend only.
-- app_lease       the script lock: one row while an execution holds it.
-- app_cache       CacheService entries both runtimes must agree on (the /yangi
--                 conversation, the rate-limit buckets).
--
-- All three are closed like every other table: RLS on, no policies, so only the
-- secret key reads or writes them.

create table public.app_properties (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table public.app_lease (
  name text primary key,
  owner text not null,
  expires_at timestamptz not null
);

create table public.app_cache (
  key text primary key,
  value text not null,
  expires_at timestamptz not null
);

alter table public.app_properties enable row level security;
alter table public.app_lease enable row level security;
alter table public.app_cache enable row level security;
revoke all on table public.app_properties, public.app_lease, public.app_cache from anon, authenticated;

-- Takes the script lock for `p_owner`, waiting up to `p_wait_ms` (capped below
-- the API's statement timeout; the caller asks again until its own timeout).
-- Re-entrant for the same owner. A lease left behind by an execution that died
-- expires after `p_ttl_ms`.
create or replace function public.mbm_lock(p_owner text, p_ttl_ms integer default 120000, p_wait_ms integer default 5000)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  deadline timestamptz := clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_wait_ms, 0), 0), 6000) / 1000.0);
  ttl interval := make_interval(secs => least(greatest(coalesce(p_ttl_ms, 120000), 1000), 600000) / 1000.0);
  got text;
begin
  if coalesce(p_owner, '') = '' then
    raise exception 'mbm_lock: an owner is required';
  end if;
  loop
    got := null;
    insert into public.app_lease as l (name, owner, expires_at)
    values ('script', p_owner, clock_timestamp() + ttl)
    on conflict (name) do update set owner = excluded.owner, expires_at = excluded.expires_at
      where l.expires_at < clock_timestamp() or l.owner = excluded.owner
    returning l.owner into got;
    if got is not null then
      return jsonb_build_object('acquired', true);
    end if;
    exit when clock_timestamp() >= deadline;
    perform pg_sleep(0.05);
  end loop;
  return jsonb_build_object('acquired', false);
end $$;

create or replace function public.mbm_unlock(p_owner text) returns jsonb
language sql set search_path = '' as $$
  with gone as (delete from public.app_lease where name = 'script' and owner = p_owner returning 1)
  select jsonb_build_object('released', exists (select 1 from gone));
$$;

-- mbm_apply, as in 20261102160523_batched_writes_and_counts.sql, plus three ops:
--   { "op": "upsert_property", "key": k, "value": v }
--   { "op": "delete_property", "key": k }
--   { "op": "unlock", "owner": o }   releases the lease in the same transaction
-- so a business action, the revision counters it bumps and the release of the
-- lock it held land together.
create or replace function public.mbm_apply(ops jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  allowed constant text[] := array[
    'system_config','omad_transactions_v2','omad_transactions','cafe_sales','cafe_close_days',
    'cafe_stock_movements','tasks','task_occurrences','omad_job_queue','omad_audit_log',
    'telegram_debug_log','omad_transaction_archive','omad_backups'];
  op jsonb;
  t text;
  cols text;
  sets text;
  seqs jsonb;
  results jsonb := '[]'::jsonb;
  affected bigint;
  wanted bigint;
begin
  if jsonb_typeof(ops) <> 'array' then
    raise exception 'mbm_apply: ops must be an array';
  end if;

  for op in select value from jsonb_array_elements(ops) loop
    t := op->>'table';

    if op->>'op' = 'upsert_config' then
      insert into public.system_config (key, value, updated_at)
      values (op->>'key', op->>'value', now())
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
      results := results || jsonb_build_array(jsonb_build_object('ok', true));
      continue;
    end if;

    if op->>'op' = 'upsert_property' then
      if coalesce(op->>'key', '') = '' or op->>'value' is null then
        raise exception 'mbm_apply: upsert_property needs a key and a value';
      end if;
      insert into public.app_properties (key, value, updated_at)
      values (op->>'key', op->>'value', now())
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
      results := results || jsonb_build_array(jsonb_build_object('ok', true));
      continue;
    end if;

    if op->>'op' = 'delete_property' then
      delete from public.app_properties where key = op->>'key';
      results := results || jsonb_build_array(jsonb_build_object('ok', true));
      continue;
    end if;

    if op->>'op' = 'unlock' then
      delete from public.app_lease where name = 'script' and owner = op->>'owner';
      results := results || jsonb_build_array(jsonb_build_object('ok', true));
      continue;
    end if;

    if t is null or not (t = any(allowed)) then
      raise exception 'mbm_apply: table % is not allowed', coalesce(t, '(none)');
    end if;

    if op->>'op' = 'insert' then
      select string_agg(quote_ident(k), ',' order by k) into cols
        from jsonb_object_keys(op->'rows'->0) as k;
      execute format(
        'with src as (select * from jsonb_populate_recordset(null::public.%1$I, $1) with ordinality as r),
              ins as (insert into public.%1$I (%2$s) select %2$s from src order by ordinality returning seq)
         select coalesce(jsonb_agg(seq order by seq), ''[]''::jsonb) from ins', t, cols)
        using op->'rows' into seqs;
      if jsonb_array_length(seqs) <> jsonb_array_length(op->'rows') then
        raise exception 'mbm_apply: % rows given, % inserted into %',
          jsonb_array_length(op->'rows'), jsonb_array_length(seqs), t;
      end if;
      results := results || jsonb_build_array(jsonb_build_object('seqs', seqs));

    elsif op->>'op' = 'update' then
      select string_agg(format('%1$I = r.%1$I', k), ', ') into sets
        from jsonb_object_keys(op->'values') as k;
      execute format(
        'update public.%1$I as t set %2$s from jsonb_populate_record(null::public.%1$I, $1) as r where t.seq = $2',
        t, sets)
        using op->'values', (op->>'seq')::bigint;
      get diagnostics affected = row_count;
      if affected <> 1 then
        raise exception 'mbm_apply: no row with seq % in %', op->>'seq', t;
      end if;
      results := results || jsonb_build_array(jsonb_build_object('ok', true));

    elsif op->>'op' = 'delete' then
      wanted := jsonb_array_length(op->'seqs');
      execute format('delete from public.%I where seq = any($1)', t)
        using array(select (jsonb_array_elements_text(op->'seqs'))::bigint);
      get diagnostics affected = row_count;
      if affected <> wanted then
        raise exception 'mbm_apply: % of % rows deleted from %', affected, wanted, t;
      end if;
      results := results || jsonb_build_array(jsonb_build_object('ok', true));

    else
      raise exception 'mbm_apply: unknown op %', coalesce(op->>'op', '(none)');
    end if;
  end loop;

  return results;
end $$;

revoke execute on function public.mbm_lock(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.mbm_unlock(text) from public, anon, authenticated;
revoke execute on function public.mbm_apply(jsonb) from public, anon, authenticated;
grant execute on function public.mbm_lock(text, integer, integer) to service_role;
grant execute on function public.mbm_unlock(text) to service_role;
grant execute on function public.mbm_apply(jsonb) to service_role;
