-- pg_net in the `extensions` schema, where Supabase keeps extensions (its
-- linter flags one in `public`: extension_in_public).
--
-- 20261116130000_edge_cron.sql now creates it there. A project that applied
-- the first version of that file -- the test project -- has it in `public`;
-- this moves it. Elsewhere it does nothing. pg_net's own functions live in
-- the `net` schema either way, so mbm_call_edge and the cron jobs are
-- unchanged; requests still queued when it is recreated are dropped.

do $$
begin
  if exists (
    select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_net' and n.nspname = 'public'
  ) then
    drop extension pg_net;
    create extension pg_net with schema extensions;
  end if;
end $$;
