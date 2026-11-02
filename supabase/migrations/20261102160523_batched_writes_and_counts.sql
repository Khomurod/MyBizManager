-- One round trip per business action.
--
-- mbm_apply(ops) runs a list of row operations in ONE transaction: everything a
-- locked region of the backend wrote is sent together when the lock is
-- released, and either all of it lands or none of it does. The table triggers
-- (the ledger's append-only guard, the audit log's) and every constraint still
-- apply to each operation exactly as they do to a single REST call.
--
-- ops: [{ "op": "insert", "table": t, "rows": [ {...}, ... ] }
--       { "op": "update", "table": t, "seq": n, "values": {...} }
--       { "op": "delete", "table": t, "seqs": [n, ...] }
--       { "op": "upsert_config", "key": k, "value": v }]
-- returns one entry per op: inserts give the new seqs in order.
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

-- Every row count the storage layer asks for, in one round trip.
create or replace function public.mbm_counts() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'system_config', (select count(*) from public.system_config),
    'omad_transactions_v2', (select count(*) from public.omad_transactions_v2),
    'omad_transactions', (select count(*) from public.omad_transactions),
    'cafe_sales', (select count(*) from public.cafe_sales where voided_at is null),
    'cafe_close_days', (select count(*) from public.cafe_close_days),
    'cafe_stock_movements', (select count(*) from public.cafe_stock_movements),
    'tasks', (select count(*) from public.tasks),
    'task_occurrences', (select count(*) from public.task_occurrences),
    'omad_job_queue', (select count(*) from public.omad_job_queue),
    'omad_audit_log', (select count(*) from public.omad_audit_log),
    'omad_transaction_archive', (select count(*) from public.omad_transaction_archive),
    'omad_backups', (select count(*) from public.omad_backups),
    'telegram_debug_log', (select coalesce(jsonb_object_agg(source_sheet, n), '{}'::jsonb)
                           from (select source_sheet, count(*) as n from public.telegram_debug_log
                                 group by source_sheet) s)
  );
$$;

revoke execute on function public.mbm_apply(jsonb) from public, anon, authenticated;
revoke execute on function public.mbm_counts() from public, anon, authenticated;
grant execute on function public.mbm_apply(jsonb) to service_role;
grant execute on function public.mbm_counts() to service_role;
