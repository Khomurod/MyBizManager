-- The timed calls, made by the database itself (pg_cron + pg_net).
--
-- Two jobs call the Edge function `api` with its cron secret in the
-- x-mbm-cron header:
--
--   mbm-telegram-jobs  every 5 minutes  ?job=telegram-jobs  the task scheduler
--                      and the Telegram queue -- run there only once
--                      EDGE_NATIVE_ACTIONS names "jobs"; until then the
--                      function answers "skipped" and Apps Script's own
--                      trigger runs them (processPendingTelegramJobs)
--   mbm-db-backup      22:00 UTC daily  ?job=db-backup      the copy into
--                      Google Drive, which the function passes on to Apps
--                      Script (03:00 in Tashkent)
--
-- Both read where to call and the secret from app_properties at run time
-- (EDGE_FUNCTION_URL, EDGE_CRON_SECRET), so the same migration serves the test
-- project and the live one, and until both rows exist the jobs do nothing.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create or replace function public.mbm_call_edge(p_job text) returns bigint
language plpgsql set search_path = '' as $$
declare
  target text;
  secret text;
begin
  select value into target from public.app_properties where key = 'EDGE_FUNCTION_URL';
  select value into secret from public.app_properties where key = 'EDGE_CRON_SECRET';
  if coalesce(target, '') = '' or length(coalesce(secret, '')) < 16 then
    return null;
  end if;
  return net.http_post(
    url := target || case when strpos(target, '?') > 0 then '&' else '?' end || 'job=' || p_job,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-mbm-cron', secret),
    timeout_milliseconds := 120000
  );
end $$;

revoke execute on function public.mbm_call_edge(text) from public, anon, authenticated;

select cron.schedule('mbm-telegram-jobs', '*/5 * * * *', $$select public.mbm_call_edge('telegram-jobs')$$);
select cron.schedule('mbm-db-backup', '0 22 * * *', $$select public.mbm_call_edge('db-backup')$$);
