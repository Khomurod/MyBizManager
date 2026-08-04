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
| `06_tenants.gs` | Tenant records |
| `07_planned_expenses.gs` | Template expenses |
| `08_omad_transactions.gs` | The ledger: read/normalise/append/rewrite |
| `09_telegram_service.gs` | Telegram API calls and the `/yangi` conversation |
| `10_retry_queue.gs` | `Omad_Job_Queue` worker |
| `11_report_jobs.gs` | Server-composed business reports |
| `12_cafe.gs` | Café inventory, sales, voids, close-day |
| `13_migration.gs` | Period migration: preview, apply, verify, cutover, rollback |
| `20_api.gs` | `doPost` / `doGet` routing only |

### Frontend modules

`omad_admin.html` is markup only. The application loads as ordinary classic
scripts, in order, sharing one global scope:

`00-config.js` (URL + access guard) → `01-state.js` → `01b-periods.js` → `02-format.js` →
`03-exchange-rates.js` → `04-tenants.js` → `05-planned-expenses.js` →
`06-api.js` → `07-dashboard.js` → `08-entry.js` → `09-history.js` →
`10-settings.js` → `11-telegram-settings.js` → `12-app.js`.

`tests/static-analysis.test.js` parses every linked script and fails if any
page defines the same function twice, so a shadowed definition cannot come
back.

## Google Sheets storage

### `System_Config` — key/value sheet

Column A = key, column B = a JSON string.

| Key | Shape |
|---|---|
| `Omad_Tenants` | `[{ name, rent, currency: "USD"\|"UZS", disabledMonths: string[] }]` |
| `Omad_Rates` | `{ "<YYYY-MM>": { buy: number, sell: number } }` — legacy `"<MonthName>"` keys still read |
| `Omad_Rates_V1_Backup` | the pre-migration rate map, restored by rollback |
| `Omad_Migration_Fallback_Year` | the year applied to rows whose year cannot be derived |
| `Omad_Active_Transactions_Sheet` | which sheet reads and writes go to — the cutover switch |
| `Omad_Migration_Status` | `{ state, appliedAt, cutoverAt, rolledBackAt, fallbackYear, ... }` |
| `Omad_Template_Expenses` | `[{ id, month, name, amount, currency }]` |
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
| `Omad_Transactions_V2` | migrated ledger, canonical periods — written by the migration, read after cutover |
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

## Exchange rates

`normalizeRateEntry_` accepts a bare number (legacy) or `{buy, sell}`.
`toUZS_(amount, currency, period, rates, rateType)` converts USD using the
period's rate; `rateType` defaults to `"sell"`.

Rates are keyed by canonical period, with the legacy month-name key still
honoured on read. They are still looked up **at read time**, so changing a rate
still moves historical values — addressed by stage 6.

## Known limitations (not addressed by this change)

These are tracked as the remaining migration stages:

1. **Whole-database rewrites.** `save_omad` sends and rewrites the entire
   transaction list on every add/edit/delete.
2. ~~Month-only periods.~~ Replaced by canonical `YYYY-MM` periods. The
   migration tooling is delivered and tested; the live sheet migration has not
   been run (it needs access to the spreadsheet).
3. **No stored exchange rate per transaction.** Historical values drift.
4. **No idempotency for *web* submits.** Telegram `/yangi` is idempotent via
   `Request_ID`; the web entry form is not yet (stage 5).
5. ~~No retry queue.~~ Delivered — `Omad_Job_Queue`.
6. **Projection uses the `buy` rate, actuals use `sell`.** The rule is
   implicit rather than explicit and tested.
7. ~~Duplicate functions in `cafe_pos.html`.~~ Removed in stage 2. The
   surviving implementations are the ones that were already winning at
   runtime: they cost consumption against `state.openingInventory` rather than
   the running balance, so a mid-day restock does not skew the cost of goods
   sold. `tests/cafe-regression.e2e.js` pins that behaviour.
8. **Horizontal overflow on `omad_admin.html` at 375px** (`scrollWidth` 489px vs
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

## Testing

```
npm test                                # unit, calculation & security tests
npm run test:e2e                        # Chromium browser flows
node scripts/scan-secrets.js            # working tree
node scripts/scan-secrets.js --history  # every committed blob
```

`tests/gas-harness.js` loads `script.gs` into a Node VM with
`SpreadsheetApp`, `PropertiesService`, `CacheService`, `LockService`,
`UrlFetchApp`, `Utilities`, `Session`, `ContentService` and `HtmlService`
mocked, so backend logic is unit-testable outside Apps Script.
