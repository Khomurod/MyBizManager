# Architecture and data structures

The detailed design reference: sheet schemas, data shapes, API surface and the
rationale behind the mechanisms.

> **Start with [APP_BRIEF.md](APP_BRIEF.md)** — it is the orientation document
> and states the business rules this page implements. Read this file when you
> need the exact shape of a row, a config value or an API action.
>
> Deployment identity, hosting and the live deployment id are in
> [DEPLOYMENT.md](DEPLOYMENT.md). The task module has its own reference,
> [TASKS.md](TASKS.md).

The V2 append-only ledger is **live**: `Omad_Transactions_V2` is the active
sheet and the legacy `Omad_Transactions` is kept intact for rollback.

## Components

| File | Role |
|---|---|
| `login.html` | Username and password only. Posts `login`, and stores the signed session it gets back as `omad_session` / `omad_role` / `omad_user` / `omad_session_expires` |
| `assets/session.js` | Loaded first by every web page: the session, the transport, the four kinds of request failure, and the per-screen snapshot |
| `assets/css/app.css` | The committed Tailwind build (`npm run build:css`), replacing the Play CDN's in-browser compile |
| `omad_admin.html` | Omad-D rent admin markup: dashboard, entry, history, settings |
| `assets/omad/*.js` | The Omad admin application, split by responsibility |
| `cafe_admin.html` | Café inventory, recipes, categories, settings |
| `cafe_pos.html` | Café point of sale, close-day |
| `mini.html` + `assets/mini/*.js` | The Telegram Mini App, served at `/mini` |
| `apps-script/*.gs` | Apps Script backend **source of truth** — what CI uploads to the live project |
| `script.gs` | **Generated** single-file bundle of `apps-script/*.gs`; a review aid and manual-deployment fallback, no longer the production path |

The frontend is static HTML served from Cloudflare Pages; it talks to a single
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
| `01_shared_utils.gs` | JSON/HTML/date helpers, `getConfig`/`setConfig`, per-request config memo |
| `01a_periods.gs` | Canonical `YYYY-MM` periods, Uzbek labels, legacy period resolution |
| `01c_cache.gs` | Revision counters and read-only summary cache |
| `01d_read_model.gs` | Materialised Omad summary: build, verify, rebuild |
| `02_validation.gs` | Rate limiting, length limits, input validators |
| `02a_auth.gs` | Users, password hashes, signed sessions, roles, login throttling |
| `03_settings.gs` | Script Properties, secrets, `checkAdminKey_`, Telegram settings actions |
| `04_audit_history.gs` | Backups, transaction archive, audit and debug logs |
| `05_exchange_rates.gs` | Rate normalisation, `toUZS_`, balances |
| `05a_calculations.gs` | Every monetary rule, mirrored by `assets/omad/02b-calc.js` |
| `06_tenants.gs` | Tenants and effective-dated rent |
| `07_planned_expenses.gs` | Planned expenses and recurrence |
| `08_omad_transactions.gs` | Legacy sheet read/normalise/append/rewrite; shared Omad read compatibility |
| `08a_tenant_paid.gs` | Tenant-paid-on-our-behalf pair: create, replace, report |
| `09_telegram_service.gs` | Telegram API calls and the `/yangi` conversation |
| `10_retry_queue.gs` | `Omad_Job_Queue` worker |
| `11_report_jobs.gs` | Server-composed business reports |
| `12_cafe.gs` | Café catalogue, pricing, sales, voids, close-day |
| `12a_cafe_catalogue.gs` | Recipe costing, catalogue revision, health warnings, stock movements |
| `12b_cafe_write_performance.gs` | Narrow durable café sale retry lookup; stock/idempotency rules stay in `12_cafe.gs` |
| `13_migration.gs` | Legacy→V2 migration: preview, apply, verify, cutover, rollback |
| `14_ledger.gs` | Append-only ledger: create / correct / cancel / read / audit |
| `14a_ledger_write_performance.gs` | Narrow ledger request lookup / ID allocation and atomic multi-line entry creation |
| `15_system_status.gs` | Safe diagnostics for Sozlamalar → Tizim |
| `15a_maintenance.gs` | Operator repairs: dates, debug-log secrets, webhook rotation |
| `16_tasks_recurrence.gs` | Task module: pure Asia/Tashkent time + recurrence engine |
| `17_tasks_store.gs` | Task module: `Tasks` / `Task_Occurrences`, occurrences, views |
| `18_tasks_service.gs` | Task module: Telegram namespace (`t_done:`, photo proof, cards) |
| `19_tasks_scheduler.gs` | Task module: scheduler, queue jobs, edit reconciliation, web API |
| `19a_tasks_wizard.gs` | Task module: `📋 Vazifa` branch of `/yangi` |
| `20_api.gs` | `doPost` / `doGet` routing and server-side auth gates |
| `20a_write_performance_api.gs` | Batch-ledger API extension and one-report-per-group integration |
| `21_miniapp_auth.gs` | Telegram Mini App `initData` verification and authorization |
| `22_miniapp_api.gs` | Mini App summaries and write actions |
| `23_health.gs` | Mini App Bot API configuration and system health check |

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
| `Omad_Read_Model` | derived, revision-keyed dashboard summary; safe to rebuild from the live ledger |
| `Cafe_Inventory` | café inventory array |
| `Cafe_Inventory_Rev` | optimistic-concurrency revision for inventory/admin saves |
| `Cafe_Recipes` | café recipe array |
| `Cafe_Categories` | `string[]` |
| `Cafe_Catalogue_Rev` | catalogue revision, independent from inventory sales |
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
| 13 | `Entry_Kind` | `""` or `tenant_paid_expense` (see below) |

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
| `Cafe_Stock_Movements` | `[Sana, Yo'nalish, Sabab, Mahsulot_ID, Nomi, Miqdor, Birlik, Tannarx, Qoldiq, Izoh, Kim, Request_ID]` — every stock change that is not a sale |
| `Omad_Transactions_V2` | **append-only ledger** (schema V2) — written by the migration, read after cutover |
| `Omad_Job_Queue` | retry queue — `[Job_ID, Related_ID, Type, Payload_JSON, Status, Attempts, Next_Attempt_At, Last_Error, Created_At, Completed_At]` |

## Apps Script Script Properties

Secrets and configuration that must never reach the browser.

| Property | Secret | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **yes** | BotFather token |
| `OMAD_ADMIN_KEY` | **yes** | Internal break-glass credential: accepted as `omad_admin` on any web action, and the bootstrap password until the owner's account exists. No normal user needs it |
| `OMAD_USERS` | **yes** | `{ username: { role, salt, hash, pwv, updatedAt } }`. Passwords are 200 chained HMAC-SHA256 rounds over a per-user salt |
| `OMAD_SESSION_SECRET` | **yes** | HMAC key the session tokens are signed with. Generated on first use; never entered by hand |
| `OMAD_REV_OMAD` / `OMAD_REV_CAFE` / `OMAD_REV_TASKS` | no | Cache revision counters. Bumped by every write; part of every summary cache key |
| `TELEGRAM_AUTHORIZED_USER_ID` | no | The only user allowed to run `/yangi` |
| `TELEGRAM_GROUP_CHAT_ID` | no | Reporting group |
| `TELEGRAM_TASKS_GROUP_CHAT_ID` | no | Task cards, reminders and proof prompts group |
| `TELEGRAM_WEBHOOK_URL` | no | Last configured webhook URL (without the secret) |
| `TELEGRAM_WEBHOOK_SECRET` | **yes** | Random value embedded in the webhook URL; every inbound update must present it |
| `TELEGRAM_WEBHOOK_SECRET_PREVIOUS` | **yes, transient** | Accepted only during a webhook-secret rotation, then cleared |
| `TELEGRAM_WEBHOOK_STATUS` | no | JSON status snapshot |
| `TELEGRAM_LAST_SUCCESS` | no | `{ action, at }` |
| `TELEGRAM_LAST_ERROR` | no | `{ action, message, at }` — redacted |

## API actions (`doPost`)

Routing order in `20_api.gs` is load-bearing, because a name matched earlier is
gated differently: `mini_*` first, then tasks, then reads, then the rest; a café
action is matched last. Check it before adding an action name.

**Normal web calls use signed role-bearing sessions.** The middle column below only
records whether the internal `OMAD_ADMIN_KEY` break-glass credential can stand in
for an `omad_admin` session; it does not mean the browser normally sends that key.
Café actions additionally accept the café roles described in the permissions section.

| Action | Break-glass admin key accepted? | Notes |
|---|---|---|
| `login` | no | The only unauthenticated web action; validates username/password and returns a signed session |
| `verify_access` / `change_password` | **yes** | Validate the current signed web identity; password changes revoke older tokens through `pwv` |
| `list_users` / `set_user_password` | **yes** | `omad_admin` account management |
| `save_omad` / `migrate_omad` | **yes** | Whole-list save. Its **transaction half is refused while V2 is live** (`saveOmadSettingsOnly_` runs instead); tenants, rates and planned expenses still save through it. Optional `telegramReport: {operation, groupId, baseId, messageId}` queues a server-composed report |
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
| `save_inventory`, `save_recipe`, `save_categories`, `save_cafe_settings` | **yes** | Café admin. The last three quote `expectedCatalogueRev`; `save_recipe` recomputes every cost from the inventory and answers with the catalogue as it stored it |
| `adjust_cafe_stock` | **yes** | One stock movement outside a sale — `{inventoryId, direction, reason, qty, note, cost?, requestId}` — applied under the script lock and written to `Cafe_Stock_Movements` |
| `save_sale`, `void_sale`, `close_day` | **yes** | Café POS |
| `get_omad_data` / `get_cafe_data` | **yes** | The authenticated replacements for the `doGet` reads. `get_omad_data` takes `scope: "dashboard"`, which answers with the read model's figures and a short recent list instead of the ledger (and with the whole list before cutover, because the legacy save submits it back) |
| `get_omad_history` | **yes** | One page of history as whole business actions — `{period?, offset, limit}` — newest first, every row of each group on the page |
| `verify_omad_read_model` / `rebuild_omad_read_model` | **yes** | Compare the stored summary against a fresh full-ledger build, and store a fresh one |
| `get_health` | **yes** | The sixteen-check system health report |
| `configure_mini_app` | **yes** | Installs and verifies the bot's Mini App menu button |
| `get_migration_status` | **yes** | Which sheet is live; the frontend picks its entry path from this |
| `preview_` / `apply_` / `verify_` / `cutover_` / `rollback_omad_migration` | **yes** | The migration sequence, above |
| `create_transaction_batch` / `create_transaction` / `correct_transaction` / `cancel_transaction` / `list_transactions` / `get_transaction` / `get_transaction_history` | **yes** | Append-only V2 ledger actions. New multi-line web entries use the batch action; edits deliberately keep the single-row correction/cancel path |
| `get_tasks` (**POST only**) / `save_task` / `cancel_task` / `pause_routine` / `resume_routine` / `skip_occurrence` / `complete_occurrence` / `reopen_occurrence` | **yes** | The task board — reads included; see [TASKS.md](TASKS.md) |
| `mini_home` / `mini_omad` / `mini_cafe` / `mini_tasks` | initData | Mini App reads — server-computed summaries |
| `mini_save_transaction` / `mini_tenant_paid` / `mini_task_action` | initData | Mini App writes, through the shared implementations |
| `mini_flush_reports` | initData | Drains queued jobs so the group card arrives without waiting for the trigger |
| `audit_transaction_dates` | **yes** | Classifies every Date cell against the date its id proves. Writes nothing |
| `fix_transaction_dates` | **yes** | Corrects only provably transposed dates. `dryRun` reports without writing |
| `backfill_entry_group_ids` | **yes** | Writes the deterministic group id onto rows that predate the column |
| `purge_telegram_debug_secrets` | **yes** | Copies `Telegram_Debug_Log`, then re-redacts every row in place |
| `audit_telegram_secret_exposure` | **yes** | Reports whether anything credential-shaped remains in the debug log. Writes nothing |
| `rotate_telegram_webhook_secret` | **yes** | New verification secret, `setWebhook`, verify, or roll back |

**Any action name starting with `mini_` is Mini-App-gated** — never name a new
admin action `mini_…`.

`doGet` is **inert**: it reads nothing and answers every request, whatever
action it names, with the same sentence. The anonymous `get_omad` / `get_cafe`
GET routes were removed — see below.

## Who may call what

The `/exec` URL is hardcoded in **five** places served from a public site
(`assets/omad/00-config.js`, `assets/mini/00-config.js`, `login.html`,
`cafe_admin.html`, `cafe_pos.html`), so everyone who has seen the frontend
knows it. Before the access key existed, that was enough to read the whole
financial ledger, the tenant list, every café sale and its margin — and to
write all of it. All five must always carry the same value.

There are exactly **three** ways to be authorized, and every action belongs to
one of them:

| Gate | Proves | Used by |
|---|---|---|
| **Session token** | you signed in as this person, in this role | the three web apps and the task board |
| **Telegram `initData`** | Telegram signed this, and you are the authorized user | the Mini App |
| **Webhook secret** + authorized user id | Telegram delivered this update | the bot |

### Sessions and roles

`login` takes a username and a password, checks them against the salted hashes
in `OMAD_USERS`, and returns

```
v1.<username>.<role>.<expirySeconds>.<passwordVersion>.<nonce>.<hmacSha256Hex>
```

signed with `OMAD_SESSION_SECRET`. The browser stores it and `callApi` attaches
it to every request. Verifying one is a hash, not a sheet read, so nothing about
the session depends on the cache or on the project staying warm.

The claims are readable by whoever holds the token — they describe that person —
and the signature is what makes them true. Editing the role and re-sending it
fails the signature check. The stored record is consulted too, so a changed
password (`pwv`), a changed role or a deleted account takes effect on the next
request rather than in thirty days.

Every gated action names the roles that may perform it, from the `AUTH_ROLES_*`
lists in `20_api.gs`:

| Role | May do |
|---|---|
| `omad_admin` | everything |
| `cafe_admin` | read the café; save inventory, recipes, categories, café settings; move stock (`adjust_cafe_stock`) |
| `cafe_seller` | read the café; `save_sale`, `void_sale`, `close_day` |

`OMAD_ADMIN_KEY` is still accepted, as `omad_admin`, so maintenance and
migration work against a project with no user store. It is compared **after**
its own strict rate limit, so the endpoint cannot be used to guess it.

Reads go over an **authenticated POST** (`get_omad_data`, `get_cafe_data`)
rather than a GET, because a GET puts its parameters in the URL — which is
where a credential must never be.

`get_cafe_data` takes a `scope`:

| `scope` | Answers |
|---|---|
| `"pos"` | catalogue + today's receipts for the named cashier |
| `"admin"` | catalogue + per-period totals + recent close-day records |
| absent | the full historical payload, unchanged, for anything that has not been taught about scopes |

### Refusals

A refusal is a shape, not a sentence, because the client has to act on it:

| Field | Meaning | Client does |
|---|---|---|
| `authExpired: true` | the session is over or forged | clear it and return to login |
| `code: "forbidden"` | wrong role | show the message; the session is fine |
| `code: "throttled"` | rate limited | keep the screen, show Retry |
| anything else | an ordinary refusal | show the message |

`code: "stale_client"` is the one refusal the *browser* produces without asking:
a write attempted while the screen is showing a snapshot the server has not
confirmed this session. See [APP_BRIEF.md §11](APP_BRIEF.md#11-decisions-that-must-be-preserved).

**Only `authExpired` signs anybody out.** Treating a throttle as an expiry is
what emptied the café till mid-shift.

The GET surface is **inert**. `doGet` reads nothing and answers every request,
whatever action it names, with the same sentence. `get_omad` / `get_cafe` used
to answer there anonymously — that was the exposure, since the /exec URL is
hardcoded in pages served from a public site — and they are gone.

### The removed bypass must not come back

`LEGACY_CLIENT_GRACE` was a temporary rollout flag that let the actions the
pre-key frontend called accept a request carrying no key at all. It is gone,
along with the second access check (`checkAccessKeyDuringRollout_`) and the
anonymous GET routes. **Do not reintroduce any of them**, and do not add a new
flag that makes a business action optional-key: `tests/api-security.test.js`
asserts that neither the flag nor the bypass function exists.

If the key ever has to be rolled out again, the order matters and is the
opposite of the obvious one: get the frontend live and proven first — signed
in, reading, writing and reversing — and only then close the hole. Closing it
first takes the whole application down, because the frontend and the backend
deploy on different pipelines and do not land together.

`tests/anonymous-access.test.js` is the inventory, written from the outside: it
asks what a stranger holding the /exec URL can read and write, and pins the
answers at nothing. The health check *probes* `doGet` for both retired routes
on every run, because a flag describes what the source intended and a probe
describes what the deployed router does.

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

**Attribution comes from the signature, never from the payload.** A Mini App
task mutation has `completedById`, `completedBy`, `completedByName`,
`completedSource`, `createdBy` and `proofAwaitingUserId` **stripped** from the
request and rewritten from the verified `initData`. Stripped rather than
overwritten, so an attribution field added to the task engine later cannot
become spoofable merely by being forwarded. The `/tasks` board is deliberately
different: it is admin-key gated and picks a completer from a list on purpose.

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

### One read per request, and it computes nothing

Every figure arrives already calculated, and no screen pays for the others.
`miniOmadContext_` reads the ledger, the tenant list and the rate table **once**
and the three builders take that context, so `mini_home` answers the Omad tab
completely on one request; Café and Tasks are fetched when their tab is first
opened.

Sending the raw state to the phone instead is not an option to reach for: the
café state alone is a third of a megabyte, and totalling it in the browser
would be a second implementation of arithmetic that already exists in
`05a_calculations.gs`.

`tests/read-efficiency.test.js` counts sheet passes directly rather than timing
anything, so a regression here fails the build instead of just feeling slow.

Writes go through the same functions the web app and the bot use, so a Mini App
entry is indistinguishable from any other: same row shape, same
`Entry_Group_ID`, same idempotency, same queued group report. The write returns
as soon as the row is stored; the group card is queued and the client calls
`mini_flush_reports` **without awaiting it**, so the card appears in seconds
rather than at the next trigger tick. Losing that call costs a delay, never a
report — the job stays queued and the trigger sends it.

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

Sixteen checks, in `buildHealthReport_`:

| Check | Notices |
|---|---|
| Backend | it answered at all |
| Anonymous read | either retired GET route answering again |
| Deployment | **the webhook pointing at a different deployment than the one answering** — the failure this project has actually had, repeatedly |
| Telegram bot | the token is missing or the bot will not answer |
| Mini App | the menu button is unset, or points somewhere else |
| Authorized user | unset, or not numeric |
| Webhook | disconnected, erroring, or badly backed up |
| Tasks group | unset, or an `@username` that will silently match nothing |
| Trigger | `processPendingTelegramJobs` is missing — no reminder or report would ever be sent. It currently reports the list as *unreadable*: `ScriptApp.getProjectTriggers()` throws because the live manifest's OAuth scopes omit `script.scriptapp`. The trigger itself works |
| Queue | failed jobs, or a growing backlog |
| Sheets | one of the five required sheets is absent |
| Ledger | which transaction sheet is live, and whether V2 is on |
| Log protection | anything in the recent debug log that still looks like a credential |
| Omad / Café / Tasks | each is reachable, with its row count |

A failing bot does not take the report down with it: each check catches its own
errors, so one broken thing still leaves the other fifteen answers readable.

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
| `create_transaction_batch` / `create_transaction` / `correct_transaction` / `cancel_transaction` | Queues one server-composed report for the affected business group after the ledger change succeeds |
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

A save returns when the financial record is safely stored, not when Telegram or
a dashboard refresh finishes. Web accounting writes force `deferReports: true`,
so no Telegram network call rides on the response path; the durable queue is
drained by the existing time trigger. The browser releases the entry form and
refreshes the confirmed dashboard in the background. Rapid saves coalesce those
refreshes, and a background refresh never rehydrates a stale snapshot that would
block an immediate second save.

Other callers may still drain at most **one** queued job inline
(`JOB_QUEUE_INLINE_BATCH = 1`). The Mini App separately starts
`mini_flush_reports` without awaiting it so its card usually arrives before the
next trigger tick. Failing to *queue* a report never undoes a save the caller is
about to be told succeeded — the enqueue is wrapped and logged.

### Idempotency

Every write carries a request id.

| Source | Where the id comes from |
|---|---|
| Telegram `/yangi` | the conversation's `sessionId` |
| Web entry | generated once per submission, mirrored into `sessionStorage` |

The web id survives a mid-save refresh, so the resubmission carries the
original id and the server recognises it. It is cleared only once the
submission succeeds. A second click while a save is in flight is ignored.

For a new multi-line web entry, that stable base id is bound to the original
line count and each stored line carries the count-qualified form described in
the ledger section. This makes an uncertain retry with a changed cart a
conflict, not a mutation of the first request.

On the `/yangi` side the `sessionId` is written to the transaction's
`Request_ID`, and the insert looks that id up first, so a redelivered Telegram
update, a retried webhook or a repeated callback all resolve to the same single
transaction. Café sales carry their own `requestId` on the same principle.

### Webhook verification

Apps Script cannot read request headers, so Telegram's
`X-Telegram-Bot-Api-Secret-Token` is not observable. The strongest available
mechanism is a high-entropy secret embedded in the webhook URL
(`?wh=<secret>`), stored in `TELEGRAM_WEBHOOK_SECRET` and additionally passed
to `setWebhook` as `secret_token`. Updates that do not present it are dropped
before any state changes. If no secret is stored yet, updates are accepted
until the operator presses **🔄 Webhook** once.

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

The migration ran and cut over on 2026-08-12. These actions stay live because
rollback has to stay one button, which also means the sequence can be needed
again.

> ### ⛔ `apply_omad_migration` destroys the live ledger if V2 is active
>
> It **rebuilds `Omad_Transactions_V2` from scratch** — `clearSheetRows_` on the
> target, then repopulate **exclusively from the legacy `Omad_Transactions`** —
> and there is **no backend guard** refusing to run while V2 is the active
> sheet. Every row written since the cutover exists only in V2 and is not on
> the legacy sheet, so running apply today would delete all of it.
>
> **Never run apply while the migration state is `cutover`.** The whole
> sequence below is a *re-run after a rollback*, never something to start from
> the live ledger.

If it is ever needed again, in this order:

1. **Roll back first.** `rollback_omad_migration` points reads and writes back
   at `Omad_Transactions` and restores the pre-migration rate map. It deletes
   nothing, so the V2 rows are still there to be recovered in step 2.
2. **Reconcile the V2-only rows.** Every transaction created after the last
   cutover lives only in `Omad_Transactions_V2`. Copy those rows into
   `Omad_Transactions` by hand now — apply reads the legacy sheet and nothing
   else, so anything left behind is gone at step 4.
3. **Back up three ways** — `create_backup` (in-sheet JSON snapshot, verify the
   row appears), Drive **File → Make a copy**, and an off-Drive `.xlsx` export.
   They fail in different ways.
4. **Preview.** Writes nothing. Duplicate ids must be empty; unresolved rows
   are better fixed in the sheet than covered by a fallback year, because then
   the year comes from the record itself.
5. **Apply.** Rebuilds the target from scratch, so an apply interrupted *within
   this same procedure* is recovered by running it again. It **never touches
   the legacy sheet**, which is what makes everything up to cutover cheap to
   undo.
6. **Verify.** Field-by-field, including each frozen `Amount_UZS` against the
   rate recorded on that same row. **Never cut over on matching totals alone**
   — an earlier version compared ten fields, none of them `Entry_Group_ID`,
   `Entry_Kind` or `Comment`, and would have let every tenant-paid pair arrive
   as two unrelated rows.
7. **Cut over.** Refuses unless verification passed.

**Never delete `Omad_Transactions`** — it costs nothing to keep and it is the
last line of defence.

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
| 24 | `Entry_Kind` | `""` or `tenant_paid_expense`; what kind of business action the group represents |

The grouping columns were added without changing the ledger's semantic schema
version, which remains 2. `ledgerSheet_` rewrites an older/truncated header in
place without touching row values; reads derive a missing `Entry_Group_ID`
deterministically and normalize a missing `Entry_Kind` to ordinary (`""`).

### Operations

| Action | Effect |
|---|---|
| `create_transaction_batch` | New multi-line business action: validates every line first, writes missing rows together under one lock, and is idempotent on a request id bound to the original line count |
| `create_transaction` | Appends one `Active` row. Idempotent on `Request_ID` |
| `correct_transaction` | Appends the replacement, then marks the original `Corrected`. The original's values are untouched |
| `cancel_transaction` | Marks the row `Cancelled`. Nothing is removed |
| `list_transactions` | `Active` rows only, optionally filtered by period / tenant / type |
| `get_transaction` | One row, whatever its status |
| `get_transaction_history` | The whole correction chain, oldest first |

All writes take the script lock. Correcting an already-corrected or cancelled
record is refused rather than silently applied. Cancelling twice is the same
outcome as cancelling once.

A batch stores per-line request ids as `<requestBase>__n<count>_<index>`. The
count is part of the durable idempotency contract: reusing one request base with
a larger or smaller cart is refused. During a frontend/backend rollout, counted
line ids let a later batch safely complete only missing lines. Older uncounted
`<requestBase>_<index>` rows are accepted as a duplicate only when the full
requested set already exists; an ambiguous partial legacy set fails closed. If
the browser has fallen back to an **older backend** that treats those ids as
opaque strings, it persists the exact fallback submission in `sessionStorage`
and refuses a changed cart/business payload until that uncertain retry is
resolved; otherwise an old server could not distinguish a modified request.
The batch also freezes one buy/sell rate pair for the whole business action; a
partial resume inherits the first stored line's pair, and inconsistent existing
snapshots are refused rather than mixed.

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

## Known limitations

Current limitations and intentional exceptions are listed in
[APP_BRIEF.md §12](APP_BRIEF.md#12-known-limitations-and-intentional-exceptions).
Two that bear on the data shapes above:

- **Legacy rows carry no frozen exchange rate** and are converted live. Ledger
  rows freeze the rates at write time and every consumer reads the frozen value.
- **The legacy pre-cutover write path is not idempotent.** It is dormant while
  V2 is live and exists for rollback.

One behaviour worth not "fixing" by accident: café cost of goods sold is costed
against `state.openingInventory` rather than the running balance, so a mid-day
restock does not skew it. `tests/cafe-regression.e2e.js` pins that.

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

When adding a control, remember that `flex-1` items default to
`min-width: auto`: a flex row of inputs plus a button refuses to shrink and
pushes the button off-screen on a narrow phone. Use a grid with `min-w-0`, as
the exchange-rate row now does.

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
Script project — see [DEPLOYMENT.md](DEPLOYMENT.md).

`tests/gas-harness.js` loads `script.gs` into a Node VM with
`SpreadsheetApp`, `PropertiesService`, `CacheService`, `LockService`,
`UrlFetchApp`, `Utilities`, `Session`, `ContentService` and `HtmlService`
mocked, so backend logic is unit-testable outside Apps Script.
