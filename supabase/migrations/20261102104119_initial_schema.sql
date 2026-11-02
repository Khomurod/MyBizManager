-- MyBizManager: storage for what used to live in the "Budgeting app" Google Sheet.
-- One table per sheet, same columns, typed. Only the Apps Script backend talks to
-- this database (with the secret key); anon/authenticated get nothing.

-- ---------------------------------------------------------------- config
create table public.system_config (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
comment on table public.system_config is 'Former System_Config sheet: key -> JSON string, exactly as getConfig/setConfig handle it.';

-- ---------------------------------------------------------------- ledger (append-only)
create table public.omad_transactions_v2 (
  id              text primary key,
  seq             bigint generated always as identity unique,
  request_id      text not null default '',
  created_at      timestamptz not null,
  updated_at      timestamptz,
  created_by      text not null default '',
  source          text not null check (source in ('Web','Telegram','Migration')),
  period          text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  tenant          text not null,
  type            text not null check (type in ('Income','Expense')),
  amount          numeric not null check (amount >= 0),
  currency        text not null check (currency in ('UZS','USD')),
  rate_buy        numeric not null default 0,
  rate_sell       numeric not null default 0,
  rate_used       numeric not null default 0,
  rate_type       text not null default 'sell' check (rate_type in ('buy','sell','none')),
  amount_uzs      numeric not null,
  method          text not null check (method in ('Naqd','Bank')),
  comment         text not null default '',
  status          text not null default 'Active' check (status in ('Active','Corrected','Cancelled','Void')),
  related_id      text not null default '',
  telegram_msg_id text not null default '',
  schema_version  integer not null default 2,
  entry_group_id  text not null default '',
  entry_kind      text not null default '' check (entry_kind in ('','tenant_paid_expense'))
);
comment on table public.omad_transactions_v2 is 'Append-only Omad ledger (former Omad_Transactions_V2 sheet). Rows are never deleted; only status/updated_at/telegram_msg_id may change.';
create index omad_tx_v2_request_id_idx on public.omad_transactions_v2 (request_id) where request_id <> '';
create unique index omad_tx_v2_active_request_id_uq on public.omad_transactions_v2 (request_id) where request_id <> '' and status = 'Active';
create index omad_tx_v2_group_idx on public.omad_transactions_v2 (entry_group_id);
create index omad_tx_v2_period_idx on public.omad_transactions_v2 (period);
create index omad_tx_v2_status_idx on public.omad_transactions_v2 (status);

create or replace function public.omad_ledger_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'omad_transactions_v2 is append-only: rows are never deleted';
  end if;
  if (new.id, new.seq, new.request_id, new.created_at, new.created_by, new.source, new.period,
      new.tenant, new.type, new.amount, new.currency, new.rate_buy, new.rate_sell, new.rate_used,
      new.rate_type, new.amount_uzs, new.method, new.comment, new.related_id, new.schema_version,
      new.entry_kind)
     is distinct from
     (old.id, old.seq, old.request_id, old.created_at, old.created_by, old.source, old.period,
      old.tenant, old.type, old.amount, old.currency, old.rate_buy, old.rate_sell, old.rate_used,
      old.rate_type, old.amount_uzs, old.method, old.comment, old.related_id, old.schema_version,
      old.entry_kind) then
    raise exception 'omad_transactions_v2 is append-only: only status, updated_at, telegram_msg_id may change';
  end if;
  if new.entry_group_id is distinct from old.entry_group_id and old.entry_group_id <> '' then
    raise exception 'omad_transactions_v2: a stored Entry_Group_ID is immutable';
  end if;
  if new.status is distinct from old.status and not (
       old.status = 'Active' and new.status in ('Corrected','Cancelled','Void')) then
    raise exception 'omad_transactions_v2: illegal status change % -> %', old.status, new.status;
  end if;
  return new;
end $$;

create trigger omad_ledger_guard_row
  before update or delete on public.omad_transactions_v2
  for each row execute function public.omad_ledger_guard();

create or replace function public.forbid_truncate() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% may not be truncated', tg_table_name;
end $$;

create trigger omad_ledger_no_truncate
  before truncate on public.omad_transactions_v2
  for each statement execute function public.forbid_truncate();

-- ---------------------------------------------------------------- legacy ledger (archive)
create table public.omad_transactions (
  id              text primary key,
  seq             bigint generated always as identity unique,
  tenant          text not null default '',
  month           text not null default '',
  type            text not null default '',
  amount          numeric,
  currency        text not null default '',
  method          text not null default '',
  date            text not null default '',
  comment         text not null default '',
  telegram_msg_id text not null default '',
  request_id      text not null default '',
  entry_group_id  text not null default '',
  entry_kind      text not null default ''
);
comment on table public.omad_transactions is 'Legacy 13-column ledger (former Omad_Transactions sheet), kept as an archive.';

-- ---------------------------------------------------------------- café
create table public.cafe_sales (
  seq        bigint generated always as identity primary key,
  id         text unique,
  sold_at    timestamptz not null,
  seller     text not null default '',
  total      numeric not null default 0,
  profit     numeric not null default 0,
  receipt    jsonb not null,
  request_id text generated always as (case when jsonb_typeof(receipt) = 'object' then receipt->>'requestId' end) stored,
  voided_at  timestamptz,
  voided_by  text
);
comment on table public.cafe_sales is 'Former Cafe_Sales sheet. A void sets voided_at instead of deleting the receipt.';
create unique index cafe_sales_request_id_uq on public.cafe_sales (request_id) where request_id is not null;
create index cafe_sales_sold_at_idx on public.cafe_sales (sold_at);

create table public.cafe_close_days (
  seq           bigint generated always as identity primary key,
  closed_at     timestamptz not null,
  seller        text not null default '',
  total_revenue numeric not null default 0,
  total_profit  numeric not null default 0,
  details       jsonb not null default '[]'::jsonb
);
comment on table public.cafe_close_days is 'Former Cafe_Kun_Yakuni sheet.';
create index cafe_close_days_closed_at_idx on public.cafe_close_days (closed_at);

create table public.cafe_stock_movements (
  seq          bigint generated always as identity primary key,
  moved_at     timestamptz not null,
  direction    text not null check (direction in ('in','out')),
  reason       text not null check (reason in ('purchase','spoilage','waste','internal','correction','recount')),
  inventory_id text not null,
  name         text not null default '',
  qty          numeric not null,
  unit         text not null default '',
  cost         numeric not null default 0,
  remaining    numeric not null default 0,
  note         text not null default '',
  actor        text not null default '',
  request_id   text not null unique
);
comment on table public.cafe_stock_movements is 'Former Cafe_Stock_Movements sheet: every stock change that is not a sale.';

-- ---------------------------------------------------------------- tasks
create table public.tasks (
  id             text primary key,
  seq            bigint generated always as identity unique,
  type           text not null check (type in ('once','routine','goal')),
  title          text not null,
  description    text not null default '',
  responsible    text not null default '',
  priority       text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  photo_required boolean not null default false,
  recurrence     jsonb not null default '{}'::jsonb,
  reminder_times jsonb not null default '[]'::jsonb,
  remind_daily   boolean not null default false,
  due_time       text not null default '' check (due_time = '' or due_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  deadline_key   text not null default '' check (deadline_key = '' or deadline_key ~ '^\d{4}-\d{2}-\d{2}$'),
  deadline_time  text not null default '' check (deadline_time = '' or deadline_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  start_key      text not null default '' check (start_key = '' or start_key ~ '^\d{4}-\d{2}-\d{2}$'),
  end_key        text not null default '' check (end_key = '' or end_key ~ '^\d{4}-\d{2}-\d{2}$'),
  status         text not null default 'active' check (status in ('active','paused','completed','cancelled')),
  steps          jsonb not null default '[]'::jsonb,
  created_at     timestamptz,
  updated_at     timestamptz,
  created_by     text not null default '',
  meta           jsonb not null default '{}'::jsonb
);
comment on table public.tasks is 'Former Tasks sheet. Date keys/times are Asia/Tashkent wall-clock text, not instants.';

create table public.task_occurrences (
  id                     text primary key,
  seq                    bigint generated always as identity unique,
  task_id                text not null,
  task_type              text not null default '',
  title                  text not null default '',
  date_key               text not null default '' check (date_key = '' or date_key ~ '^\d{4}-\d{2}-\d{2}$'),
  step_index             integer,
  due_at                 bigint,
  responsible            text not null default '',
  priority               text not null default 'normal',
  photo_required         boolean not null default false,
  reminder_times         jsonb not null default '[]'::jsonb,
  remind_daily           boolean not null default false,
  status                 text not null default 'Open' check (status in ('Open','WaitingProof','Completed','Cancelled','Skipped')),
  reminders_sent         jsonb not null default '{}'::jsonb,
  notified_at            timestamptz,
  telegram_msg_id        text not null default '',
  completed_by_id        text not null default '',
  completed_by_name      text not null default '',
  completed_at           timestamptz,
  on_time                boolean,
  late_ms                bigint,
  proof_file_id          text not null default '',
  proof_msg_id           text not null default '',
  proof_awaiting_user_id text not null default '',
  created_at             timestamptz,
  updated_at             timestamptz,
  meta                   jsonb not null default '{}'::jsonb
);
comment on table public.task_occurrences is 'Former Task_Occurrences sheet. Overdue is derived on read and never stored.';
create index task_occ_task_idx on public.task_occurrences (task_id);
create index task_occ_status_idx on public.task_occurrences (status);
create unique index task_occ_routine_day_uq on public.task_occurrences (task_id, date_key)
  where task_type = 'routine' and date_key <> '';

-- ---------------------------------------------------------------- job queue
create table public.omad_job_queue (
  job_id          text primary key,
  seq             bigint generated always as identity unique,
  related_id      text not null default '',
  type            text not null,
  payload_json    text not null default '{}',
  status          text not null default 'Pending' check (status in ('Pending','Processing','Completed','Failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz,
  last_error      text not null default '',
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);
comment on table public.omad_job_queue is 'Former Omad_Job_Queue sheet. payload_json stays text: dedup compares exact JSON of the enqueuer''s keys.';
create index omad_job_queue_due_idx on public.omad_job_queue (status, next_attempt_at);

-- ---------------------------------------------------------------- audit, logs, archive, backups
create table public.omad_audit_log (
  seq       bigint generated always as identity primary key,
  logged_at timestamptz not null default now(),
  event     text not null,
  details   text not null default ''
);
comment on table public.omad_audit_log is 'Former Omad_Audit_Log sheet. Append-only.';
create index omad_audit_log_logged_at_idx on public.omad_audit_log (logged_at);

create or replace function public.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create trigger omad_audit_log_append_only
  before update or delete on public.omad_audit_log
  for each row execute function public.forbid_change();
create trigger omad_audit_log_no_truncate
  before truncate on public.omad_audit_log
  for each statement execute function public.forbid_truncate();

create table public.telegram_debug_log (
  seq          bigint generated always as identity primary key,
  logged_at    timestamptz not null default now(),
  event        text not null,
  details      text not null default '',
  source_sheet text not null default 'Telegram_Debug_Log'
);
comment on table public.telegram_debug_log is 'Former Telegram_Debug_Log sheet (and its 2026-08-12 backup, marked by source_sheet). Secrets redacted on write; may be re-redacted in place.';
create index telegram_debug_log_logged_at_idx on public.telegram_debug_log (logged_at);

create table public.omad_transaction_archive (
  seq              bigint generated always as identity primary key,
  archived_at      timestamptz not null default now(),
  reason           text not null default '',
  transaction_id   text not null default '',
  transaction_json text not null default ''
);
comment on table public.omad_transaction_archive is 'Former Omad_Transaction_Archive sheet.';

create table public.omad_backups (
  seq           bigint generated always as identity primary key,
  backed_up_at  timestamptz not null default now(),
  reason        text not null default '',
  snapshot_json text not null default ''
);
comment on table public.omad_backups is 'Former Omad_Backups sheet: full JSON snapshots taken before Omad writes.';

-- ---------------------------------------------------------------- access
-- Row level security on everything and no policies: the browser keys
-- (anon / authenticated) can read and write nothing. Only the backend's
-- secret key (service_role, which bypasses RLS) can reach the data.
do $$
declare t text;
begin
  foreach t in array array[
    'system_config','omad_transactions_v2','omad_transactions','cafe_sales','cafe_close_days',
    'cafe_stock_movements','tasks','task_occurrences','omad_job_queue','omad_audit_log',
    'telegram_debug_log','omad_transaction_archive','omad_backups'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

revoke execute on function public.omad_ledger_guard() from public, anon, authenticated;
revoke execute on function public.forbid_truncate() from public, anon, authenticated;
revoke execute on function public.forbid_change() from public, anon, authenticated;
