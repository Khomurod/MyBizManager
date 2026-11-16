-- The script lock (app_lease), safe under contention and against a holder
-- that outlived it. Replaces two functions of 20261116120000_edge_shared_state.sql.
--
-- mbm_lock: the first version tried the insert in a loop inside one
-- transaction. While another owner held an unexpired lease, `on conflict do
-- update ... where` still locked that row until the function returned, so the
-- holder's own release (mbm_apply's unlock op, mbm_unlock) waited behind the
-- waiter's sleep -- up to a whole wait slice for every contended write. Now it
-- looks first (a plain read locks nothing) and tries only when the lease is
-- free, expired or already its own; a try that loses the race returns at once
-- and the caller asks again. Its answer also says whether the settings are
-- still in the database (`ready`: the __PROPERTIES_READY row), read after the
-- lease is taken: the Edge function read its switches up to 15 s earlier and
-- may have waited behind a move back, after which it must write nothing.
-- One answer, so the check costs no extra call.
--
-- mbm_apply: one more op, sent with every batch written under the lease:
--   { "op": "fence", "owner": o }
-- The batch is refused as a whole unless o still holds an unexpired lease, and
-- the lease row stays share-locked until the batch commits. So an execution
-- that outlived its lease (90 s) cannot write after another one has taken
-- over; it gets an error and nothing of it is stored.

create or replace function public.mbm_lock(p_owner text, p_ttl_ms integer default 120000, p_wait_ms integer default 5000)
returns jsonb
language plpgsql set search_path = '' as $$
declare
  deadline timestamptz := clock_timestamp() + make_interval(secs => least(greatest(coalesce(p_wait_ms, 0), 0), 6000) / 1000.0);
  ttl interval := make_interval(secs => least(greatest(coalesce(p_ttl_ms, 120000), 1000), 600000) / 1000.0);
  holder text;
  until_at timestamptz;
  got text;
begin
  if coalesce(p_owner, '') = '' then
    raise exception 'mbm_lock: an owner is required';
  end if;
  loop
    holder := null;
    until_at := null;
    select l.owner, l.expires_at into holder, until_at from public.app_lease l where l.name = 'script';
    if holder is null or holder = p_owner or until_at < clock_timestamp() then
      got := null;
      insert into public.app_lease as l (name, owner, expires_at)
      values ('script', p_owner, clock_timestamp() + ttl)
      on conflict (name) do update set owner = excluded.owner, expires_at = excluded.expires_at
        where l.expires_at < clock_timestamp() or l.owner = excluded.owner
      returning l.owner into got;
      -- Taken, or lost to somebody quicker. Either way answer now: a lost try
      -- holds the row until this call ends, and must not sleep holding it.
      return jsonb_build_object('acquired', got is not null,
        'ready', exists (select 1 from public.app_properties where key = '__PROPERTIES_READY'));
    end if;
    exit when clock_timestamp() >= deadline;
    perform pg_sleep(0.05);
  end loop;
  return jsonb_build_object('acquired', false);
end $$;

-- mbm_apply, as in 20261116120000_edge_shared_state.sql, plus the fence op.
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

    if op->>'op' = 'fence' then
      -- Held, unexpired, and kept so until this transaction ends: a lease
      -- that is lost refuses the whole batch, never part of it.
      perform 1 from public.app_lease
        where name = 'script' and owner = op->>'owner' and expires_at > clock_timestamp()
        for share;
      if not found then
        raise exception 'mbm_apply: lease lost, nothing written';
      end if;
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
revoke execute on function public.mbm_apply(jsonb) from public, anon, authenticated;
grant execute on function public.mbm_lock(text, integer, integer) to service_role;
grant execute on function public.mbm_apply(jsonb) to service_role;
