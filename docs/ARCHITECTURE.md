# MyBizManager — current architecture and data structures

Documented as of the Telegram credential-hardening change. This is the
"before" picture that the remaining migration stages build on.

## Components

| File | Role |
|---|---|
| `login.html` | Role selection, writes `omad_role` / `omad_token` to `localStorage` |
| `omad_admin.html` | Omad-D rent admin: dashboard, entry, history, settings |
| `cafe_admin.html` | Café inventory, recipes, categories, settings |
| `cafe_pos.html` | Café point of sale, close-day |
| `script.gs` | Apps Script backend — the only server. Google Sheets is the database. |

The frontend is static HTML served from GitHub Pages; it talks to a single
Apps Script `/exec` web app over `fetch`.

## Google Sheets storage

### `System_Config` — key/value sheet

Column A = key, column B = a JSON string.

| Key | Shape |
|---|---|
| `Omad_Tenants` | `[{ name, rent, currency: "USD"\|"UZS", disabledMonths: string[] }]` |
| `Omad_Rates` | `{ "<MonthName>": { buy: number, sell: number } }` |
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
| 3 | `Month` | **month name only** (`"Fevral"`) — no year |
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

## Exchange rates

`normalizeRateEntry_` accepts a bare number (legacy) or `{buy, sell}`.
`toUZS_(amount, currency, month, rates, rateType)` converts USD using the
month's rate; `rateType` defaults to `"sell"`.

Rates are looked up **at read time**, keyed by month name. Changing a rate
therefore retroactively changes the UZS value of historical transactions —
this is a known defect, addressed by the historical-rate stage below.

## Known limitations (not addressed by this change)

These are tracked as the remaining migration stages:

1. **Whole-database rewrites.** `save_omad` sends and rewrites the entire
   transaction list on every add/edit/delete.
2. **Month-only periods.** `Month` has no year, so two Januaries collide.
3. **No stored exchange rate per transaction.** Historical values drift.
4. **No idempotency for *web* submits.** Telegram `/yangi` is idempotent via
   `Request_ID`; the web entry form is not yet (stage 5).
5. ~~No retry queue.~~ Delivered — `Omad_Job_Queue`.
6. **Projection uses the `buy` rate, actuals use `sell`.** The rule is
   implicit rather than explicit and tested.
7. **Duplicate functions in `cafe_pos.html`**: `recomputeCloseDay` (×3),
   `renderCloseDayList` (×2), `submitCloseDay` (×2). Later definitions win at
   runtime. Guarded by a test so the set cannot grow. Removed in stage 2.
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
