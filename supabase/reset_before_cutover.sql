-- Empties every MyBizManager table so a failed Sheets -> Supabase import can be
-- run again. Paste into the Supabase SQL editor; it runs as one transaction.
--
-- It REFUSES once a cutover has happened (System_Config holds
-- Omad_Storage_Cutover_At): from that moment the database is the only place
-- new entries exist, and emptying it would destroy them.
do $$
begin
  if exists (select 1 from public.system_config where key = 'Omad_Storage_Cutover_At') then
    raise exception 'Cutover has happened: the database is live and will not be emptied.';
  end if;

  alter table public.omad_transactions_v2 disable trigger omad_ledger_no_truncate;
  alter table public.omad_audit_log disable trigger omad_audit_log_no_truncate;

  truncate public.system_config, public.omad_transactions_v2, public.omad_transactions,
    public.cafe_sales, public.cafe_close_days, public.cafe_stock_movements,
    public.tasks, public.task_occurrences, public.omad_job_queue, public.omad_audit_log,
    public.telegram_debug_log, public.omad_transaction_archive, public.omad_backups
    restart identity;

  alter table public.omad_transactions_v2 enable trigger omad_ledger_no_truncate;
  alter table public.omad_audit_log enable trigger omad_audit_log_no_truncate;
end $$;
