# MyBizManager — current architecture and data structures

Documented as of the Telegram credential-hardening change. This is the
"before" picture that the remaining migration stages build on.

## Components

| File | Role |
|---|---|
| `login.html` | Role selection, writes `omad_role` / `omad_token` to `localStorage` |
| `omad_admin.html` | Omad-D rent admin markup: dashboard, entry, history, settings |
| `assets/omad/*.js` | The Omad admin application, split by responsibility |
| `cafe_admin.html` | Café inventory, recipes, categories, settings |
| `cafe_pos.html` | Café point of sale, close-day |
| `apps-script/*.gs` | Apps Script backend **source of truth**, split by responsibility |
| `script.gs` | **Generated** single-file bundle of `apps-script/*.gs` — what you paste into Apps Script |

The frontend is static HTML served from GitHub Pages; it talks to a single
Apps Script `/exec` web app over `fetch`.

### Backend modules

Apps Script files share one global scope, so the modules are concatenated in
filename order. `npm run build` regenerates `script.gs`; `npm run build:check`
(run in CI) fails if the bundle is stale.

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
| `08_omad_transactions.gs` | The ledger: read/normalise/append/rewrite |
| `09_telegram_service.gs` | Telegram API calls and the `/yangi` conversation |
| `10_retry_queue.gs` | `Omad_Job_Queue` worker |
| `11_report_jobs.gs` | Server-composed business reports |
| `12_cafe.gs` | Café inventory, sales, voids, close-day |
| `13_migration.gs` | Period migration: preview, apply, verify, cutover, rollback |
| `14_ledger.gs` | Append-only ledger: create / correct / cancel / read / audit |
| `15_system_status.gs` | Backups, queue, migration state, audit tail, safe diagnostics |
| `20_api.gs` | `doPost` / `doGet` routing only |

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
| `save_omad` / `migrate_omad` | no | **Rewrites the whole transaction list** (see limitations). Optional `telegramReport: {operation, baseId, messageId}` queues a server-composed report |
| `get_telegram_settings` | no | Never includes the token |
| `save_telegram_settings` | **yes** | Validates before accepting |
| `test_telegram_connection` | **yes** | `getMe` |
| `send_telegram_test_message` | **yes** | Posts to the reporting group |
| `configure_telegram_webhook` | **yes** | `setWebhook` + `getWebhookInfo` |
| `get_job_queue_status` | no | Pending/processing/completed/failed counts only |
| `process_jobs` | **yes** | Manually drains the retry queue |
| `get_system_status` | no | Counts, timestamps and event names only — never secrets, amounts or message contents |
| `create_backup` | **yes** | Writes an `Omad_Backups` snapshot on demand |
| `retry_failed_jobs` | **yes** | Puts failed jobs back in the queue |
| `save_inventory`, `save_recipe`, `save_categories`, `save_cafe_settings` | no | Café admin |
| `save_sale`, `void_sale`, `close_day` | no | Café POS |

`doGet` supports `action=get_omad` and `action=get_cafe`.

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
starting at ~30s, and give up after 5 attempts. `processPendingTelegramJobs`
is the entry point for a time-driven trigger.

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

### Operations

| Action | Effect |
|---|---|
| `create_transaction` | Appends one `Active` row. Idempotent on `Request_ID` |
| `correct_transaction` | Marks the original `Corrected` and appends a replacement whose `Related_ID` points back at it. The original's values are untouched |
| `cancel_transaction` | Marks the row `Cancelled`. Nothing is removed |
| `list_transactions` | `Active` rows only, optionally filtered by period / tenant / type |
| `get_transaction` | One row, whatever its status |
| `get_transaction_history` | The whole correction chain, oldest first |

All writes take the script lock. Correcting an already-corrected or cancelled
record is refused rather than silently applied. Cancelling twice is the same
outcome as cancelling once.

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

See `docs/MIGRATION_RUNBOOK.md` for the live migration procedure.

`tests/gas-harness.js` loads `script.gs` into a Node VM with
`SpreadsheetApp`, `PropertiesService`, `CacheService`, `LockService`,
`UrlFetchApp`, `Utilities`, `Session`, `ContentService` and `HtmlService`
mocked, so backend logic is unit-testable outside Apps Script.
