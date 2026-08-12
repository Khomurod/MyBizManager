# MyBizManager — current architecture and data structures

Documented as of the Telegram credential-hardening change. This is the
"before" picture that the remaining migration stages build on.

> **Start with [APP_BRIEF.md](APP_BRIEF.md).** This file is the detailed design
> reference — data shapes and rationale — and parts of it are out of date. The
> App Brief lists what.
>
> **This file describes the design, not what is deployed.** For the live
> deployment, which sheet is active, the Telegram setup and the work still
> outstanding, see **[LIVE_STATE.md](LIVE_STATE.md)**.
>
> **Correction (2026-08-12): the V2 append-only ledger *is* live.** The cutover
> was performed and `Omad_Transactions_V2` is the active sheet; the legacy
> `Omad_Transactions` is kept intact for rollback. Every "after cutover" passage
> below therefore describes the **current** state, not a future one.

## Components

| File | Role |
|---|---|
| `login.html` | Role selection **and the access key**: verifies it against `verify_access`, then stores `omad_role` / `omad_token` / `omad_access_key` |
| `omad_admin.html` | Omad-D rent admin markup: dashboard, entry, history, settings |
| `assets/omad/*.js` | The Omad admin application, split by responsibility |
| `cafe_admin.html` | Café inventory, recipes, categories, settings |
| `cafe_pos.html` | Café point of sale, close-day |
| `mini.html` + `assets/mini/*.js` | The Telegram Mini App, served at `/mini` |
| `apps-script/*.gs` | Apps Script backend **source of truth** — what CI uploads to the live project |
| `script.gs` | **Generated** single-file bundle of `apps-script/*.gs`; a review aid and manual-deployment fallback, no longer the production path |

The frontend is static HTML served from GitHub Pages; it talks to a single
Apps Script `/exec` web app over `fetch`.

### Backend modules

Apps Script files share one global scope, so the modules are concatenated in
filename order. `npm run build` regenerates `script.gs`; `npm run build:check`
(run in CI) fails if the bundle is stale.

The modules are also what gets **deployed**: on a green merge to `main`, CI
uploads `apps-script/*.gs` into the live project with clasp and moves the
existing deployment on to a new version, so the editor mirrors this directory
file for file. See [DEPLOYMENT.md](DEPLOYMENT.md).

| Module | Contents |
|---|---|
| `01_shared_utils.gs` | JSON/HTML/date helpers, `setConfig`/`getConfig` |
| `01a_periods.gs` | Canonical `YYYY-MM` periods, Uzbek labels, period resolution |
| `02_validation.gs` | Rate limiting, length limits, every input validator |
| `03_settings.gs` | Script Properties, secrets, the Telegram settings actions |
| `04_audit_history.gs` | Backups, transaction archive, audit and debug logs |
| `05_exchange_rates.gs` | Rate normalisation, `toUZS_`, balances |
| `05a_calculations.gs` | Every monetary rule, mirrored by `assets/omad/02b-calc.js` |
| `06_tenants.gs` | Tenant records |
| `07_planned_expenses.gs` | Template expenses |
| `08_omad_transactions.gs` | The ledger: read/normalise/append/rewrite, entry groups |
| `08a_tenant_paid.gs` | The tenant-paid-on-our-behalf pair: create, replace, report |
| `09_telegram_service.gs` | Telegram API calls and the `/yangi` conversation |
| `10_retry_queue.gs` | `Omad_Job_Queue` worker |
| `11_report_jobs.gs` | Server-composed business reports |
| `12_cafe.gs` | Café inventory, sales, voids, close-day |
| `13_migration.gs` | Period migration: preview, apply, verify, cutover, rollback |
| `14_ledger.gs` | Append-only ledger: create / correct / cancel / read / audit |
| `15_system_status.gs` | Backups, queue, migration state, audit tail, safe diagnostics |
| `15a_maintenance.gs` | Operator repairs: historical dates, debug-log secrets, webhook secret rotation |
| `16_tasks_recurrence.gs` | Task module: Asia/Tashkent time + recurrence engine (pure) |
| `17_tasks_store.gs` | Task module: `Tasks`/`Task_Occurrences` sheets, occurrences, views |
| `18_tasks_service.gs` | Task module: isolated Telegram namespace (`t_done:`, photo proof) |
| `19_tasks_scheduler.gs` | Task module: reminder scheduler, queue jobs, edit reconciliation, web API |
| `19a_tasks_wizard.gs` | Task module: the `📋 Vazifa` branch of `/yangi` — state machine, keyboards, task creation |
| `21_miniapp_auth.gs` | Telegram Mini App: `initData` signature verification and the authorization gate |
| `22_miniapp_api.gs` | Telegram Mini App: server-computed summaries and the write actions |
| `23_health.gs` | Mini App configuration through the Bot API, and the system health check |
| `20_api.gs` | `doPost` / `doGet` routing only |

The task-management feature (`/tasks`) is documented separately in
**[TASKS.md](TASKS.md)**. It is an isolated module: dedicated `Tasks` and
`Task_Occurrences` sheets, its own `t_done:` Telegram namespace claimed before
the `/yangi` handler, and its own frontend. It reuses the Telegram bot, the
`Omad_Job_Queue` and the Telegram settings.

The isolation is **one-way**:

> Tasks never touch financial data. The private `/yangi` conversation may
> **create** tasks, through the same four authorization gates that protect the
> accounting flow, and reading only the `Tasks` sheet.

Nothing in the task module reads or writes an Omad transaction, tenant, rate or
backup. The `📋 Vazifa` branch of `/yangi` (`19a_tasks_wizard.gs`) goes the
other way — it files a task from the private bot. Its callbacks use the
`bot_vz` prefix so they stay behind the private-chat check and the
authorization gate, and the module is never handed `configSheet`, so accounting
config is structurally out of reach.

### Frontend modules

`omad_admin.html` is markup only. The application loads as ordinary classic
scripts, in order, sharing one global scope:

`00-config.js` (URL + access guard) → `01-state.js` → `01b-periods.js` → `02-format.js` → `02b-calc.js` → `02c-money-input.js` →
`03-exchange-rates.js` → `04-tenants.js` → `05-planned-expenses.js` →
`06-api.js` → `07-dashboard.js` → `08-entry.js` → `09-history.js` →
`10-settings.js` → `10b-system.js` → `11-telegram-settings.js` → `12-app.js`.

`tests/static-analysis.test.js` parses every linked script and fails if any
page defines the same function twice, so a shadowed definition cannot come
back.

## Google Sheets storage

### `System_Config` — key/value sheet

Column A = key, column B = a JSON string.

| Key | Shape |
|---|---|
| `Omad_Tenants` | `[{ name, defaultRent, rent, currency, active, startPeriod, endPeriod, rentChanges: [{fromPeriod, amount}], exceptions: [{period, amount}], noRentPeriods: string[], disabledMonths: string[] }]` |
| `Omad_Rates` | `{ "<YYYY-MM>": { buy: number, sell: number } }` — legacy `"<MonthName>"` keys still read |
| `Omad_Rates_V1_Backup` | the pre-migration rate map, restored by rollback |
| `Omad_Migration_Fallback_Year` | the year applied to rows whose year cannot be derived |
| `Omad_Active_Transactions_Sheet` | which sheet reads and writes go to — the cutover switch |
| `Omad_Migration_Status` | `{ state, appliedAt, cutoverAt, rolledBackAt, fallbackYear, ... }` |
| `Omad_Template_Expenses` | `[{ id, name, amount, currency, startPeriod, month, frequency, intervalMonths, selectedMonths, ending: {type, untilPeriod, occurrences}, active, description }]` |
| `Cafe_Inventory` | café inventory array |
| `Cafe_Recipes` | café recipe array |
| `Cafe_Categories` | `string[]` |
| `Cafe_Settings` | `{ dailyTarget: number }` |

### `Omad_Transactions` — row-per-transaction

| Col | Header | Notes |
|---|---|---|
| 1 | `ID` | `"<epochMillis>_<cartIndex>"` |
| 2 | `Tenant` | tenant name, or `"Umumiy Naqd Puldan"` / `"Umumiy Bankdan"` for expenses |
| 3 | `Month` | canonical period `"2026-02"` after migration; a legacy month name (`"Fevral"`) before it |
| 4 | `Type` | `Income` \| `Expense` |
| 5 | `Amount` | original amount |
| 6 | `Currency` | `UZS` \| `USD` |
| 7 | `Method` | `Naqd` \| `Bank` |
| 8 | `Date` | `dd/MM/yyyy` display string |
| 9 | `Comment` | free text |
| 10 | `Telegram_Msg_ID` | group message id, for later edit/delete |
| 11 | `Request_ID` | idempotency key; empty on legacy rows |
| 12 | `Entry_Group_ID` | the business action this row belongs to (see below) |

### Entry groups

One business action can be several accounting rows: two currencies on one
payment, or the income/expense pair of a tenant-paid expense. Every row keeps
its own transaction id; the rows that belong together share one immutable
**`Entry_Group_ID`**.

The group id is **stored, never inferred**. Timestamps collide, and the
`<epochMillis>_<n>` id prefix cannot express a group whose rows were written
under different id bases — which is exactly what a two-sided entry needs. The
client generates the id once per business action and keeps it in
`sessionStorage`, so a retry lands in the same group instead of opening a
second one; an edit reuses the group it is editing.

| Where | Value |
|---|---|
| Web entry | `grp_web_<millis>_<random>`, generated once per submission |
| Telegram `/yangi` | `grp_<uuid>`, one per conversation |
| Ledger `create_transaction` | the supplied `groupId`, or a fresh `grp_<uuid>` |
| Rows written before the column | `grp_legacy_<idBase>` |

The last row is the only inference, and it exists solely so rows that predate
the column have a stable identity. It is deterministic, so reads resolve it in
memory and `backfill_entry_group_ids` writes exactly the same value into the
sheet — running it twice changes nothing. A row that already carries a group id
is never re-grouped.

Reporting, editing, cancellation and history all resolve rows through the group
id. Queued report jobs carry both `groupId` and the old `baseId`, so a job
sitting on `Omad_Job_Queue` across a deploy still finds its rows.

### Entry kinds

`Entry_Kind` (legacy column 13, ledger column 24) says *what* a group is:

| Value | Meaning |
|---|---|
| `""` | an ordinary entry — one or more lines of a single income or expense |
| `tenant_paid_expense` | the linked income/expense pair described below |

It is stored rather than deduced, because reporting and history both have to
know without reconstructing the intent from the rows. A correction inherits it,
so an entry cannot change kind by being edited.

## Tenant-paid-on-our-behalf expenses

A tenant sometimes settles one of our bills directly — the electrician — and
the amount comes off what they owe us. That is two accounting facts and always
was: the tenant paid us, and the bill was paid. Entering them as two separate
transactions worked, but nothing recorded that they were the same event, so
either half could be edited or deleted alone, the group received two unrelated
reports, and history showed two rows the reader had to pair up mentally.

`tenant_paid_expense` is one operation:

| | Row |
|---|---|
| income | `Tenant` = the tenant, `Type` = `Income` |
| expense | `Tenant` = `Umumiy Naqd Puldan` / `Umumiy Bankdan` (matching the method), `Type` = `Expense` |

Both carry the same amount, currency, method, period, `Entry_Group_ID` and
`Entry_Kind`, and are written in **one** `setValues` call — one spreadsheet
operation, so either both rows exist or neither does. Partial creation is not
a state the code can reach.

The expense is booked against the same method the credit was recorded under, so
**cash and bank do not move**: the tenant's balance changes, ours does not.
Income and expense are each still reported in the period totals rather than
netted away, because both facts are true.

| Property | How |
|---|---|
| one operation | one action, one request |
| idempotent | the client mints the group id once and keeps it in `sessionStorage`; a repeat resolves to the pair the first call created |
| one report | `isTenantPaidGroup_` selects `buildTenantPaidReportMessage_`, which states the zero cash impact explicitly — it looks like an error otherwise |
| one history card | rows are grouped by `Entry_Group_ID`, and a group whose rows are all `tenant_paid_expense` renders once |
| edited as a pair | `replaceGroupId` replaces the whole group under the same id, keeping the group's Telegram message so the report is edited rather than duplicated |
| cancelled as a pair | cancellation already resolves by group; the confirmation names both halves |

On the ledger the same operation cancels the old rows and appends replacements
rather than rewriting, and both halves freeze the same converted value, so the
pair nets to exactly zero however the rate moves afterwards.

The tenant must be a real tenant: an expense bucket has no balance to credit,
and choosing one would silently produce an entry that cancels itself out and
means nothing. The purpose is required, because it is what makes the expense
half readable a year later.

### Other sheets

| Sheet | Purpose |
|---|---|
| `Omad_Backups` | `[Timestamp, Reason, Snapshot_JSON]` — full snapshot before each Omad write |
| `Omad_Transaction_Archive` | `[Timestamp, Reason, Transaction_ID, Transaction_JSON]` |
| `Omad_Audit_Log` | `[Timestamp, Event, Details]` — append-only audit trail |
| `Telegram_Debug_Log` | `[Timestamp, Event, Details]` — secrets redacted on write |
| `Cafe_Sales` | `[Sana, Sotuvchi, Jami_Tushum, Sof_Foyda, Chek_Tafsilotlari, ID]` |
| `Cafe_Kun_Yakuni` | `[Sana, Sotuvchi, Jami_Tushum, Sof_Foyda, Tafsilotlar_JSON]` |
| `Omad_Transactions_V2` | **append-only ledger** (schema V2) — written by the migration, read after cutover |
| `Omad_Job_Queue` | retry queue — `[Job_ID, Related_ID, Type, Payload_JSON, Status, Attempts, Next_Attempt_At, Last_Error, Created_At, Completed_At]` |

## Apps Script Script Properties

Secrets and configuration that must never reach the browser.

| Property | Secret | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **yes** | BotFather token |
| `OMAD_ADMIN_KEY` | **yes** | Required for every settings mutation |
| `TELEGRAM_AUTHORIZED_USER_ID` | no | The only user allowed to run `/yangi` |
| `TELEGRAM_GROUP_CHAT_ID` | no | Reporting group |
| `TELEGRAM_WEBHOOK_URL` | no | Last configured webhook URL (without the secret) |
| `TELEGRAM_WEBHOOK_SECRET` | **yes** | Random value embedded in the webhook URL; every inbound update must present it |
| `TELEGRAM_WEBHOOK_STATUS` | no | JSON status snapshot |
| `TELEGRAM_LAST_SUCCESS` | no | `{ action, at }` |
| `TELEGRAM_LAST_ERROR` | no | `{ action, message, at }` — redacted |

## API actions (`doPost`)

| Action | Admin key | Notes |
|---|---|---|
| `save_omad` / `migrate_omad` | **yes** | **Rewrites the whole transaction list** (see limitations). Optional `telegramReport: {operation, groupId, baseId, messageId}` queues a server-composed report |
| `tenant_paid_expense` | **yes** | One tenant-paid expense: two linked rows, one group, one report. `replaceGroupId` edits an existing pair |
| `get_telegram_settings` | **yes** | Never includes the token, but does carry the authorized user id and both chat ids |
| `save_telegram_settings` | **yes** | Validates before accepting |
| `test_telegram_connection` | **yes** | `getMe` |
| `send_telegram_test_message` | **yes** | Posts to the reporting group |
| `configure_telegram_webhook` | **yes** | `setWebhook` + `getWebhookInfo` |
| `get_job_queue_status` | **yes** | Pending/processing/completed/failed counts only |
| `process_jobs` | **yes** | Manually drains the retry queue |
| `get_system_status` | **yes** | Counts, timestamps and event names only — never secrets, amounts or message contents |
| `create_backup` | **yes** | Writes an `Omad_Backups` snapshot on demand |
| `retry_failed_jobs` | **yes** | Puts failed jobs back in the queue |
| `save_inventory`, `save_recipe`, `save_categories`, `save_cafe_settings` | **yes** | Café admin |
| `save_sale`, `void_sale`, `close_day` | **yes** | Café POS |
| `verify_access` | **yes** | Checks a key at login and returns nothing else |
| `get_omad_data` / `get_cafe_data` | **yes** | The authenticated replacements for the `doGet` reads |
| `mini_home` / `mini_omad` / `mini_cafe` / `mini_tasks` | initData | Mini App reads — server-computed summaries |
| `mini_save_transaction` / `mini_tenant_paid` / `mini_task_action` | initData | Mini App writes, through the shared implementations |
| `audit_transaction_dates` | **yes** | Classifies every Date cell against the date its id proves. Writes nothing |
| `fix_transaction_dates` | **yes** | Corrects only provably transposed dates. `dryRun` reports without writing |
| `backfill_entry_group_ids` | **yes** | Writes the deterministic group id onto rows that predate the column |
| `purge_telegram_debug_secrets` | **yes** | Copies `Telegram_Debug_Log`, then re-redacts every row in place |
| `rotate_telegram_webhook_secret` | **yes** | New verification secret, `setWebhook`, verify, or roll back |

`doGet` is **inert**: it reads nothing and answers every request, whatever
action it names, with the same sentence. The anonymous `get_omad` / `get_cafe`
GET routes were removed — see below.

## Who may call what

The `/exec` URL is hardcoded in three pages served from a public site, so
everyone who has seen the frontend knows it. Until the Mini App change, that was
enough to read the whole financial ledger, the tenant list, every café sale and
its margin — and to write all of it.

There are now exactly **three** ways to be authorized, and every action belongs
to one of them:

| Gate | Proves | Used by |
|---|---|---|
| **Access key** (`OMAD_ADMIN_KEY`) | you signed in | the three web apps, and every admin/maintenance action |
| **Telegram `initData`** | Telegram signed this, and you are the authorized user | the Mini App |
| **Webhook secret** + authorized user id | Telegram delivered this update | the bot |

### The access key

The same key that was already typed into Sozlamalar. It is entered once on
`login.html`, verified there against `verify_access`, kept in `localStorage`,
and attached by `callBackend` to every request. The username and password on
that page choose which app opens; they are in the page source and have never
been a security boundary. The key is.

Reads go over an **authenticated POST** (`get_omad_data`, `get_cafe_data`)
rather than a GET, because a GET puts its parameters in the URL — which is
where a key must never be. Both are compared **after** a rate limit, so the
endpoint cannot be used to guess the key.

The GET surface is **inert**. `doGet` reads nothing and answers every request,
whatever action it names, with the same sentence. `get_omad` / `get_cafe` used
to answer there anonymously — that was the exposure, since the /exec URL is
hardcoded in pages served from a public site — and they are gone.

### The rollout grace, and why it no longer exists

The frontend and the backend deploy on different pipelines and do not land
together. When the backend started demanding a key and the deployed browser had
not learned to send one, every save failed. `LEGACY_CLIENT_GRACE` bridged that
gap: while it was on, the actions the pre-key frontend called accepted a request
carrying no key at all.

It was always meant to be temporary, and it is gone — the flag, the second
access check (`checkAccessKeyDuringRollout_`) and the anonymous GET routes with
it. Every business action now takes the same key, and `api-security.test.js`
asserts that neither the flag nor the bypass function exists any more, so there
is no undocumented way back.

`anonymous-access.test.js` is the inventory, written from the outside: it asks
what a stranger holding the /exec URL can read and write, and pins the answers
at nothing. The health check no longer reports a flag — it *probes* `doGet` for
both retired routes on every run, because a flag describes what the source
intended and a probe describes what the deployed router does.

### The café is server-priced

`apps-script/12_cafe.gs`. The POS sends **which items and how many**. Everything
that decides money or stock is computed here, from what is stored:

| | |
|---|---|
| price | the product's `sellPrice`, or the recipe's |
| cost | the product's unit cost, or the recipe's ingredients |
| stock movement | the product's serving size, or the recipe's ingredient quantities |
| totals and profit | summed from the priced lines |
| close-day revenue/profit | totalled from the sales actually recorded |

`resolveCafeSaleLines_` refuses an item the catalogue does not contain rather
than selling it at whatever the caller suggested, and `cafeStockShortfall_`
refuses a sale the stock cannot cover.

Inventory is written in exactly one place, `writeCafeInventory_`, which bumps
`Cafe_Inventory_Rev`. The admin screen quotes the revision it was showing on
every save, and a mismatch is refused: the till depletes stock on the server
now, so an admin page opened in the morning and saved in the evening would
otherwise put the whole day's sales back. A counted stock level at close-day is
deliberately *not* version-checked, because a physical count is a measurement
rather than an edit of a stale copy. Reading the stock, deciding it is
sufficient and writing it back is a read-modify-write, so the whole of
`saveCafeSale_` runs under the script lock — two tills selling the last item at
the same moment would otherwise both succeed.

The sale carries a `requestId`. A retry, a double tap or a redelivered request
resolves to the sale the first attempt created; the response says `duplicate:
true` and the stock moves once. A void restores stock from the receipt that was
stored, never from an inventory the browser supplies, and voiding twice is a
no-op rather than a second refund of stock.

Close-day accepts `countedInventory`, because a physical count is the one thing
only a person can supply. It ignores any revenue or profit the till reports.

### Telegram Mini App

`apps-script/21_miniapp_auth.gs`. Telegram signs `initData` with a key derived
from the bot token, so a caller without the bot token cannot produce a valid
one — and the bot token never leaves Script Properties.

```
secret_key = HMAC_SHA256(bot_token, key = "WebAppData")
expected   = hex(HMAC_SHA256(data_check_string, key = secret_key))
```

`data_check_string` is every field except `hash`, decoded, sorted by key, joined
with `\n`. The comparison is constant-time.

It never trusts a user id in the URL or the payload, a username, `initDataUnsafe`,
or anything in the browser. There is **no second user database**: the verified
numeric id is compared against `TELEGRAM_AUTHORIZED_USER_ID`, the same property
that decides who may run `/yangi`.

| Check | Refusal |
|---|---|
| no `initData` | `missing_init_data` |
| no `hash` | `missing_hash` |
| signature does not match | `bad_signature` |
| `auth_date` more than 24h old | `stale` |
| `auth_date` in the future | `auth_date_in_future` |
| signed, but a different user | `not_authorized` |

The 24-hour window is a session length rather than a request lifetime: Telegram
refreshes `initData` when the Mini App is opened but not while it stays open, so
a shorter window would break a Mini App left in the background mid-edit.

**The admin key is neither sent to the Mini App nor accepted from it.** A phone
screen is the wrong place for the key that also unlocks the settings and the
maintenance actions.

`mini_*` actions are routed before everything else, so one can never fall
through into a handler with a different gate. They reuse the existing business
logic rather than reimplementing it — figures from `05a_calculations.gs`, tenant
debt from `06_tenants.gs`, tasks through `runTaskAction_` (the same code the
`/tasks` board runs, split out from behind the admin-key check), and the
tenant-paid pair from `08a_tenant_paid.gs`.

## The Telegram Mini App

A separate, phone-first frontend at **`/mini`** — not the admin pages shrunk.
Three tabs and nothing else:

| Tab | What it is |
|---|---|
| 💰 Omad | the month's figures, balances, tenant debt, recent activity, and three entries: income, expense, tenant-paid |
| ☕ Kafe | monitoring only — today, the month, the daily target, stock value, recent sales and closings |
| ✅ Vazifalar | the existing task engine: today / overdue / upcoming / waiting / done, complete, skip, reopen, pause, create, edit |

The full web app remains the administration interface. Rates, tenant
schedules, planned expenses, migration and the maintenance actions are
deliberately not here.

### One read per request

Every Mini App screen used to pay for the others. `mini_home` built the Omad
summary, the café summary and the whole task view, and the client then called
`mini_omad` anyway because the tenant list and the recent entries were missing
from it — two round trips and **four separate full reads of the ledger** to
paint one tab, plus a café read and a task-view build for tabs nobody had
opened. The task counts it computed were never rendered by any screen.

`miniOmadContext_` reads the ledger, the tenant list and the rate table once,
and the three builders take that context. `mini_home` answers Omad completely
from it. Café and Tasks are fetched when their tab is first opened.

### It computes nothing

Every figure arrives already calculated. `mini_home` returns the Omad summary,
the café summary and the task counts in **one** round trip, so the first screen
paints on one request; each tab's detail is fetched when that tab is first
opened. The café state alone is a third of a megabyte — sending it to a phone
to be totalled there would be slow *and* a second implementation of arithmetic
that already exists in `05a_calculations.gs`.

Writes go through the same functions the web app and the bot use, so a Mini App
entry is indistinguishable from any other: same row shape, same
`Entry_Group_ID`, same idempotency, same queued group report.

### Design

Telegram supplies the palette as CSS variables and changes them when the user
switches theme, so every colour is one of those with a fallback for the page
being opened outside Telegram; nothing is hardcoded light or dark. The tab bar
sits above `env(safe-area-inset-bottom)`, controls are at least 44px, amounts
group as they are typed, and forms are bottom sheets that Telegram's own back
button closes. No framework: seven small classic scripts, which is what makes
it start instantly on a phone connection.

### Configuration

**Sozlamalar → Tizim → Mini Appni Sozlash** does the whole BotFather setup
through the Bot API: `setChatMenuButton` installs the Mini App on the bot's
menu, `getChatMenuButton` reads it back — because `setChatMenuButton` answers
`ok: true` for a URL Telegram will later refuse to open — and the authorized
user and the webhook are checked in the same pass. There is no manual step.

## System health

**Sozlamalar → Tizim → Tizim Salomatligi** (`get_health`, admin key) is one
pass over everything that can stop working quietly. Green / warning / error
with a sentence each, and never a secret, a chat id or a deployment URL.

| Check | Notices |
|---|---|
| Deployment | **the webhook pointing at a different deployment than the one answering** — the failure this project has actually had, repeatedly |
| Telegram bot | the token is missing or the bot will not answer |
| Mini App | the menu button is unset, or points somewhere else |
| Authorized user | unset, or not numeric |
| Webhook | disconnected, erroring, or badly backed up |
| Tasks group | unset, or an `@username` that will silently match nothing |
| Trigger | `processPendingTelegramJobs` is missing — no reminder or report would ever be sent |
| Queue | failed jobs, or a growing backlog |
| Sheets | one of the five required sheets is absent |
| Ledger | which transaction sheet is live, and whether V2 is on |
| Log protection | anything in the recent debug log that still looks like a credential |
| Omad / Café / Tasks | each is reachable, with its row count |

A failing bot does not take the report down with it: each check catches its own
errors, so one broken thing still leaves the other fourteen answers readable.

## Telegram reporting

There is **no generic Telegram proxy**. `telegram_send`, `telegram_edit` and
`telegram_delete` were removed — they let any unauthenticated caller post
arbitrary text into the reporting group.

Instead the browser submits a business operation and the server composes the
message from data it already stored:

| Browser action | Server behaviour |
|---|---|
| `save_omad` + `telegramReport.operation = "transaction_upsert"` | Builds the group report from the stored transaction group (`buildOmadGroupReportMessage_`), sends or edits it, and writes the message id back onto the rows |
| `save_omad` + `telegramReport.operation = "transaction_delete"` | Deletes the previously sent group message |
| `close_day` | Builds the café close-day report (`buildCafeCloseDayMessage_`) from the stored close-day payload |
| Telegram `/yangi` | Saves the transaction, then queues its own report |

Every one of those becomes a **job on `Omad_Job_Queue`**, so a Telegram outage
degrades to "the report is late", never "the money is wrong". Jobs are claimed
under the script lock (status `Processing`), retried with exponential backoff
starting at ~30s, and give up after 5 attempts.

`processPendingTelegramJobs` is the entry point for the single time-driven
trigger, and it does the whole cycle: it runs the task scheduler first — so a
reminder coming due now is enqueued and sent in the same tick — and then drains
the queue. The scan is wrapped in a `try`, because this queue also carries the
accounting reports and a fault on the task side must never stop a financial
report going out. `processTaskSchedules` remains as a manual entry point;
running both is safe by construction (see [TASKS.md](TASKS.md)).

Job types: `omad_transaction_report`, `omad_transaction_delete_report`,
`cafe_close_day_report`, and the task module's `task_notify`, `task_reminder`,
`task_update_message` and `task_proof_prompt` (see [TASKS.md](TASKS.md)).

A job that exhausts its attempts gets one last call to
`onJobPermanentlyFailed_`, so a job type that left state behind can clean it up
— `task_proof_prompt` uses this to release an occurrence that would otherwise
wait for ever for a photo prompt that was never delivered.

### Fast saving

A save returns as soon as the financial record is safely stored. At most
**one** queued job rides along inline (`JOB_QUEUE_INLINE_BATCH = 1`), so
response time does not grow with the size of the backlog; the trigger picks up
everything else. Passing `deferReports: true` on a request skips the inline
drain entirely.

Failing to *queue* a report never undoes a save the caller is about to be told
succeeded — the enqueue is wrapped, and the failure is logged rather than
raised.

### Idempotency

Every write carries a request id.

| Source | Where the id comes from |
|---|---|
| Telegram `/yangi` | the conversation's `sessionId` |
| Web entry | generated once per submission, mirrored into `sessionStorage` |

The web id survives a mid-save refresh, so the resubmission carries the
original id and the server recognises it. It is cleared only once the
submission succeeds. A second click while a save is in flight is ignored.

### Webhook verification

Apps Script cannot read request headers, so Telegram's
`X-Telegram-Bot-Api-Secret-Token` is not observable. The strongest available
mechanism is a high-entropy secret embedded in the webhook URL
(`?wh=<secret>`), stored in `TELEGRAM_WEBHOOK_SECRET` and additionally passed
to `setWebhook` as `secret_token`. Updates that do not present it are dropped
before any state changes. If no secret is stored yet (a deployment from before
this change), updates are accepted until the operator presses **🔄 Webhook**
once.

### Idempotency

Each `/yangi` conversation gets a `sessionId`; it is written to the
transaction's `Request_ID`. The insert looks the request id up first, so a
redelivered Telegram update, a retried webhook or a repeated callback all
resolve to the same single transaction.

## Periods

The canonical period is **`YYYY-MM`** (`2026-01`). Friendly Uzbek labels
(`Yanvar 2026`) are produced from it for display and never stored.
`apps-script/01a_periods.gs` and `assets/omad/01b-periods.js` implement the
same rules on both sides.

### Resolving a legacy row's period

Month-only values carry no year. Rather than assigning one year to everything,
`resolveTransactionPeriod_` works through, in order:

| # | Situation | Result | Confident |
|---|---|---|---|
| 1 | `Month` is already `2026-01` | used as-is | ✅ |
| 2 | month name **and** a valid date that agree | year from the date | ✅ |
| 3 | December row dated in early January (or January dated in late December) | the labelled month of the adjacent year | ✅ |
| 4 | any other month/date disagreement | flagged as a **conflict** | ❌ |
| 5 | a valid date and no month name | period from the date | ✅ |
| 6 | month name, no usable date | the **explicitly configured** fallback year | ❌ |
| 7 | neither | unresolved — listed for the operator | ❌ |

Two-digit years, impossible days (`31/04`), and `29/02` in a non-leap year are
rejected rather than guessed at.

Reads attach `period`, `periodSource` and `periodLabel` to every transaction,
so the app shows correct years **before** the sheet is migrated.

## Migration and cutover

`apps-script/13_migration.gs`, all admin-key protected:

| Action | Effect |
|---|---|
| `preview_omad_migration` | Writes nothing. Returns the per-year summary, the unresolved rows (with sheet row numbers), duplicate ids, per-period totals and the cash/bank/total balances |
| `apply_omad_migration` | Backs up, then writes `Omad_Transactions_V2`. **The original sheet is never touched**, which is what makes rollback cheap. Rebuilt from scratch each run, so an interrupted apply is recovered by running it again |
| `verify_omad_migration` | Row counts, unique ids, canonical periods, per-period totals and cash/bank/total balances |
| `cutover_omad_migration` | Refuses unless verification passes, then points `Omad_Active_Transactions_Sheet` at V2 |
| `rollback_omad_migration` | Points reads back at the original and restores the pre-migration rate map. **Never deletes migrated data** |

## Append-only ledger (`Omad_Transactions_V2`, schema version 2)

Financial records are never rewritten in place and never deleted.

| Col | Header | Notes |
|---|---|---|
| 1 | `ID` | `"<epochMillis>_<n>"` |
| 2 | `Request_ID` | idempotency key |
| 3 | `Created_At` | ISO timestamp |
| 4 | `Updated_At` | set when the status changes |
| 5 | `Created_By` | who or what wrote it |
| 6 | `Source` | `Web` \| `Telegram` \| `Migration` |
| 7 | `Period` | canonical `YYYY-MM` |
| 8 | `Tenant` | tenant name, or the expense source |
| 9 | `Type` | `Income` \| `Expense` |
| 10 | `Amount` | original amount |
| 11 | `Currency` | `UZS` \| `USD` |
| 12 | `Rate_Buy` | buy rate available at write time |
| 13 | `Rate_Sell` | sell rate available at write time |
| 14 | `Rate_Used` | the rate actually applied |
| 15 | `Rate_Type` | `buy` \| `sell` \| `none` |
| 16 | `Amount_UZS` | converted value, **frozen** at write time |
| 17 | `Method` | `Naqd` \| `Bank` |
| 18 | `Comment` | free text |
| 19 | `Status` | `Active` \| `Corrected` \| `Cancelled` |
| 20 | `Related_ID` | the transaction this one corrects |
| 21 | `Telegram_Msg_ID` | group message id |
| 22 | `Schema_Version` | `2` |
| 23 | `Entry_Group_ID` | the business action this row belongs to |

`Entry_Group_ID` was added while `Omad_Transactions_V2` had never existed in
any spreadsheet, so there is no earlier shape of this schema in the wild and
the version stays at 2. `ledgerSheet_` upgrades a 22-column header in place
anyway, and reads fall back to the deterministic derivation, so a sheet created
by an older build keeps working.

### Operations

| Action | Effect |
|---|---|
| `create_transaction` | Appends one `Active` row. Idempotent on `Request_ID` |
| `correct_transaction` | Appends the replacement, then marks the original `Corrected`. The original's values are untouched |
| `cancel_transaction` | Marks the row `Cancelled`. Nothing is removed |
| `list_transactions` | `Active` rows only, optionally filtered by period / tenant / type |
| `get_transaction` | One row, whatever its status |
| `get_transaction_history` | The whole correction chain, oldest first |

All writes take the script lock. Correcting an already-corrected or cancelled
record is refused rather than silently applied. Cancelling twice is the same
outcome as cancelling once.

#### Why a correction writes the replacement first

Marking the original `Corrected` first — which is what this used to do — meant
a failure between the two writes left the original hidden with no replacement:
money that silently disappeared from every figure the business acts on, in the
one operation the append-only design exists to make safe.

Writing the replacement first cannot lose money. For as long as the second
write takes it could double-count it, so a failure marks the replacement
**`Void`** and reports the correction as failed. The reachable outcomes are
therefore:

| | Result |
|---|---|
| both writes land | corrected, one `Active` row |
| the status write fails | replacement `Void`, original still `Active` — nothing changed |
| the rollback *also* fails | two `Active` rows and an audit row naming both ids |

Never a hidden original. `Void` rows are excluded from every read exactly as
`Cancelled` ones are, and are skipped when a retry looks its request id up — so
resubmitting a failed correction succeeds rather than replaying the discarded
attempt.

### Backward-compatible reads

`readOmadTransactions_` returns the same shape either way: before cutover it
reads the legacy sheet and resolves periods in memory, after cutover it reads
`Active` ledger rows. Ledger rows also expose `month` (mirroring `period`) so
existing readers keep working.

The whole-list `save_omad` rewrite is **refused for transactions** once the
ledger is live — it is exactly what the append-only design exists to prevent.
Tenants, rates and planned expenses still save through it.

The frontend picks its path from `get_migration_status`, so a half-finished
migration cannot break entry.

## Tenant rent schedules

A tenant's rent is **effective-dated**, not a single number.

| Field | Meaning |
|---|---|
| `defaultRent` | what the agreement says |
| `startPeriod` | when it begins (`""` = it always has) |
| `endPeriod` | when it ends (`""` = open-ended) |
| `rentChanges` | `[{ fromPeriod, amount }]` — a new default from a period onwards |
| `exceptions` | `[{ period, amount }]` — one month at a different amount |
| `noRentPeriods` | `["2026-12"]` — one month with no rent at all |
| `active` | an inactive tenant is owed nothing, and can be reactivated |

Resolution order, highest first:

1. outside `startPeriod`/`endPeriod`, or inactive → **0**
2. a legacy `disabledMonths` entry → **0**
3. a `noRentPeriods` entry → **0**
4. an `exceptions` entry → that amount
5. the latest `rentChanges` entry that has taken effect
6. `defaultRent`

`tenantRentSource_` returns which of those applied, and the schedule editor
shows it next to every month, so nothing is implicit.

`rent` is kept in step with `defaultRent` so older readers keep working, and
legacy `{ name, rent, currency, disabledMonths }` records need no migration —
`disabledMonths` still repeats yearly, which is precisely why schedules
replace it.

**Tenants are never deleted**, because their payment history has to keep
resolving. Deactivating, or giving the agreement an end period, is what
"removing" means.

`apps-script/06_tenants.gs` and `assets/omad/04-tenants.js` are mirrors, tested
against the same expectations.

## Planned expenses

A planned expense is a **plan**. It says money is expected to leave in given
periods; it is never money that moved.

| Frequency | Meaning |
|---|---|
| `once` | one period only |
| `monthly` | every month |
| `every_2_months` … `every_12_months` | fixed interval from the start period |
| `selected_months` | chosen months of the year, every year |
| `custom_interval` | every `intervalMonths` months |

| Ending rule | Meaning |
|---|---|
| `never` | runs indefinitely |
| `until_period` | stops after that period |
| `after_occurrences` | stops after exactly N occurrences |

Intervals count from `startPeriod`, so an expense starting in November falls
due in February, May, August… — it keeps its own rhythm rather than snapping to
the calendar quarter. `plannedExpenseOccurrence_` returns the 1-based
occurrence number, which is what the "after N occurrences" rule counts and what
the UI shows.

Legacy `{ id, month, name, amount, currency }` records are read as one-time
expenses in that month, and `month` is kept in step with `startPeriod`, so
nothing needs migrating.

### Never double-counted

`calculateProjection_` sums only what is **scheduled**; `calculateActuals_`
sums only what actually **left**. `comparePlanToActual_` reports both side by
side plus `outstandingExpense` (what is still expected, floored at zero) —
deliberately not a total, because a planned expense that has been paid appears
in both and adding them would count it twice.

## Exchange rates

`normalizeRateEntry_` accepts a bare number (legacy) or `{buy, sell}`.
`toUZS_(amount, currency, period, rates, rateType)` converts USD using the
period's rate; `rateType` defaults to `"sell"`.

Rates are keyed by canonical period, with the legacy month-name key still
honoured on read.

### The rate rule

Every UZS figure the business acts on — income, expenses, cash, bank, total
balance, tenant payments, tenant debt, Telegram balance reports — uses the
**sell** rate. **Projections use the sell rate too.**

Mixing buy for expected income with sell for actual income made debt figures
wrong by the spread: a tenant who paid exactly their rent still showed a
balance. The buy rate is recorded on every transaction for history and is not
used in any calculation. The header shows both, for information.

### Historical values

A ledger row carries `Rate_Buy`, `Rate_Sell`, `Rate_Used` and `Amount_UZS`
frozen at write time, and every consumer reads `Amount_UZS`. Changing a
current or future rate therefore **cannot** move a historical figure; it only
affects transactions written afterwards.

Legacy rows have no frozen value and are still converted live — which is
exactly the drift the ledger removes.

### One implementation

`apps-script/05a_calculations.gs` and `assets/omad/02b-calc.js` are mirrors:
`transactionUZS`, `calculateActuals`, `calculateTenantPaid`,
`tenantExpectedRentUZS`, `calculateTenantBalance`, `calculateProjection`. Both
are tested against the same expectations, so a figure on screen is the figure
the server reports.

Income, expense and net are scoped to the selected period. **Cash, bank and
total are always all-time** — money in the safe does not reset when you change
the reporting month. Cancelled and corrected records are excluded everywhere.

Projections are a plan, not money that moved: a planned expense is never
counted as paid, and projection and actual figures are never summed together.

## Historical repairs

Three operator-run repairs live in `15a_maintenance.gs`. None of them runs on
its own, all of them take the admin key, all of them back up before writing,
and all of them are safe to run twice.

### Transposed dates

Older rows show day and month swapped, because the app wrote `05/08/2026` as
text and the spreadsheet read it back through a MM/DD locale. Writes have since
been fixed and the `Month`/period column — not this one — drives every figure,
so the damage is cosmetic.

It is repairable **without guessing** because the transaction id is
`<epochMillis>_<n>` and the app has only ever written *today's* date: the id
records the instant the row was created, so the correct date is that instant in
the script timezone. A row is corrected only when swapping the stored day and
month reproduces the id's date exactly.

| Case | Action |
|---|---|
| stored date == the id's date | left alone |
| swapping day and month gives the id's date | corrected |
| any other disagreement | reported, never touched |
| id has no usable epoch prefix | reported, never touched |

`audit_transaction_dates` classifies and writes nothing;
`fix_transaction_dates` corrects only the second row of that table, after a
full backup, writing a real date value rather than text.

### Debug-log secrets

Request bodies are no longer logged, so the webhook secret cannot reach
`Telegram_Debug_Log` any more. Rows written *before* that change can still
contain it. `purge_telegram_debug_secrets` copies the sheet to
`Telegram_Debug_Log_Backup_<stamp>` and then re-redacts every `Details` cell
through `redactSecrets_` plus a blunt "32+ hex characters" rule — the webhook
secret is two UUIDs with the dashes removed, so a bare occurrence with no
`wh=` or `secret_token` context around it is caught too. Losing a long hex
identifier from a debug log costs nothing; keeping a secret costs everything.

### Webhook secret rotation

`rotate_telegram_webhook_secret` mints a new secret, points Telegram at it and
verifies with `getWebhookInfo`. The **previous secret stays accepted for the
length of the rotation** (`TELEGRAM_WEBHOOK_SECRET_PREVIOUS`), which removes
the race: between storing the new value and Telegram learning it, an update
signed with either verifies. It is cleared the moment the new webhook is
confirmed.

If `setWebhook` fails or Telegram will not confirm, the old secret is restored
*and the webhook is re-pointed at it*, so a failed rotation leaves the bot
exactly as it was rather than deaf. The secret is never returned to the browser
and never written to a log.

## Known limitations (not addressed by this change)

These are tracked as the remaining migration stages:

1. ~~Whole-database rewrites.~~ Replaced by the append-only ledger once the
   migration is cut over. Before cutover the legacy path is still used, by
   design.
2. ~~Month-only periods.~~ Replaced by canonical `YYYY-MM` periods. The
   migration tooling is delivered and tested; the live sheet migration has not
   been run (it needs access to the spreadsheet).
3. **No stored exchange rate per transaction** *for legacy rows only*. Ledger
   rows freeze the rates at write time and every consumer reads the frozen
   value.
4. **Idempotency** is delivered for Telegram `/yangi` and for web submits
   against the ledger. The legacy pre-cutover path is still not idempotent.
5. ~~No retry queue.~~ Delivered — `Omad_Job_Queue`.
6. ~~Projection uses `buy`, actuals use `sell`.~~ Everything uses `sell`; the
   rule is stated once and tested on both sides.
7. ~~Duplicate functions in `cafe_pos.html`.~~ Removed in stage 2. The
   surviving implementations are the ones that were already winning at
   runtime: they cost consumption against `state.openingInventory` rather than
   the running balance, so a mid-day restock does not skew the cost of goods
   sold. `tests/cafe-regression.e2e.js` pins that behaviour.
8. ~~Horizontal overflow on `omad_admin.html` at 375px~~ — fixed in stage 7.
   The original diagnosis, for the record: (`scrollWidth` 489px vs
   a 375px viewport, Sozlamalar tab). Traced to the pre-existing exchange-rate
   row in the *Oylik Kurslar* card:

   ```html
   <div class="flex gap-2 mb-2">
     <input ... id="settingRateBuyInput"  class="flex-1 p-2 border rounded text-sm">
     <input ... id="settingRateSellInput" class="flex-1 p-2 border rounded text-sm">
     <button ... class="bg-blue-600 text-white px-3 rounded ...">OK</button>
   </div>
   ```

   `flex-1` items default to `min-width: auto`, so the inputs refuse to shrink
   below their intrinsic width and push the button off-screen. The fix is to add
   `min-w-0` to both inputs. Left alone here because it is unrelated to the
   Telegram change; scheduled for the settings redesign (stage 7).

## Sozlamalar

Five sections, one open at a time, navigated by a horizontally scrollable
button row:

| Section | Contents |
|---|---|
| 💱 Kurslar | Year + month selectors, buy/sell inputs, validation, yearly overview marking months with no rate, confirmation before changing an existing rate |
| 🏢 Ijarachilar | Tenant list with per-month switches, add/edit form |
| 🧾 Rejali Chiqim | Planned expenses (projection only) |
| 📨 Telegram | Status, credentials, connection/test/webhook actions |
| 🗄️ Tizim | Backup status and manual backup, migration status and the staged migration controls, pending and failed jobs with retry, audit history, schema version, last successful server operation |

The admin key is typed once in the Telegram section and reused by the System
and Data actions. It is never stored.

`buildSystemStatus_` returns counts, timestamps and event names only — never a
snapshot payload, a transaction amount or a message body.

The migration controls dim once the cutover succeeds, leaving the rollback
available.

### Mobile

`tests/omad-settings.e2e.js` asserts that no control in any section sticks out
past its own card at **320 / 375 / 414 / 768 / 1280 px**, that every control is
visible and enabled at 320px, that numeric fields keep `inputmode`, and that
secret fields stay `type="password"`.

The known 375px overflow is gone: the exchange-rate row used two `flex-1`
inputs plus a button, and `flex-1` items default to `min-width: auto`, so the
inputs refused to shrink and pushed the button off-screen. It is now a
two-column grid with `min-w-0` and a full-width button beneath.

## Monetary input

Amount fields format as you type: `15000` → `15 000`, `12500000` →
`12 500 000`. Values are stored as clean numbers with no spaces.

They stay `type="text"` with `inputmode="decimal"`. A `type="number"` field
rejects the grouping spaces outright, and `inputmode` is what actually raises
the numeric keypad on a phone — so this is the combination that gives both
formatting and a usable mobile keyboard.

`cleanMoneyString` handles the comma ambiguity — a comma groups thousands in
`12,500,000` and separates decimals in `1234,56` — with the rule that **the
last separator is the decimal point only when it is followed by one or two
digits**, or nothing at all (a decimal being typed). Everything else groups.

The caret is restored by digit position rather than by raw offset, so inserting
a separator does not shove the cursor left on every third digit.

Fields are listed once in `MONEY_FIELD_IDS`; adding a new amount field means
adding its id there.

## Testing

```
npm run build            # regenerate script.gs from apps-script/
npm run build:check      # fail if the bundle is stale
npm run lint             # syntax, duplicates, secrets, bundle freshness
npm test                 # unit, calculation, migration, ledger & security
npm run test:e2e         # Chromium browser flows
npm run scan:secrets     # working tree
npm run scan:secrets:history  # every committed blob
```

CI runs all of these on every branch and pull request. On `main`, and only
there, a green run is followed by an automatic deployment to the live Apps
Script project — see `docs/DEPLOYMENT.md`.

See `docs/MIGRATION_RUNBOOK.md` for the live migration procedure.

`tests/gas-harness.js` loads `script.gs` into a Node VM with
`SpreadsheetApp`, `PropertiesService`, `CacheService`, `LockService`,
`UrlFetchApp`, `Utilities`, `Session`, `ContentService` and `HtmlService`
mocked, so backend logic is unit-testable outside Apps Script.
