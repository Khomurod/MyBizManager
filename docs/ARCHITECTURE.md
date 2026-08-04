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

### Other sheets

| Sheet | Purpose |
|---|---|
| `Omad_Backups` | `[Timestamp, Reason, Snapshot_JSON]` — full snapshot before each Omad write |
| `Omad_Transaction_Archive` | `[Timestamp, Reason, Transaction_ID, Transaction_JSON]` |
| `Omad_Audit_Log` | `[Timestamp, Event, Details]` — append-only audit trail |
| `Telegram_Debug_Log` | `[Timestamp, Event, Details]` — secrets redacted on write |
| `Cafe_Sales` | `[Sana, Sotuvchi, Jami_Tushum, Sof_Foyda, Chek_Tafsilotlari, ID]` |
| `Cafe_Kun_Yakuni` | `[Sana, Sotuvchi, Jami_Tushum, Sof_Foyda, Tafsilotlar_JSON]` |

## Apps Script Script Properties

Secrets and configuration that must never reach the browser.

| Property | Secret | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **yes** | BotFather token |
| `OMAD_ADMIN_KEY` | **yes** | Required for every settings mutation |
| `TELEGRAM_AUTHORIZED_USER_ID` | no | The only user allowed to run `/yangi` |
| `TELEGRAM_GROUP_CHAT_ID` | no | Reporting group |
| `TELEGRAM_WEBHOOK_URL` | no | Last configured webhook URL |
| `TELEGRAM_WEBHOOK_STATUS` | no | JSON status snapshot |
| `TELEGRAM_LAST_SUCCESS` | no | `{ action, at }` |
| `TELEGRAM_LAST_ERROR` | no | `{ action, message, at }` — redacted |

## API actions (`doPost`)

| Action | Admin key | Notes |
|---|---|---|
| `save_omad` / `migrate_omad` | no | **Rewrites the whole transaction list** (see limitations) |
| `get_telegram_settings` | no | Never includes the token |
| `save_telegram_settings` | **yes** | Validates before accepting |
| `test_telegram_connection` | **yes** | `getMe` |
| `send_telegram_test_message` | **yes** | Posts to the reporting group |
| `configure_telegram_webhook` | **yes** | `setWebhook` + `getWebhookInfo` |
| `telegram_send` / `telegram_edit` / `telegram_delete` | no | Server-side proxy so the browser holds no token |
| `save_inventory`, `save_recipe`, `save_categories`, `save_cafe_settings` | no | Café admin |
| `save_sale`, `void_sale`, `close_day` | no | Café POS |

`doGet` supports `action=get_omad` and `action=get_cafe`.

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
4. **No idempotency.** A retried submit creates duplicates.
5. **No retry queue.** A Telegram failure is surfaced to the user inline.
6. **Projection uses the `buy` rate, actuals use `sell`.** The rule is
   implicit rather than explicit and tested.
7. **Duplicate functions in `cafe_pos.html`**: `recomputeCloseDay` (×3),
   `renderCloseDayList` (×2), `submitCloseDay` (×2). Later definitions win at
   runtime. Guarded by a test so the set cannot grow.
8. **Slight horizontal overflow on `omad_admin.html` at 375px.** Observed in CI
   (where the Tailwind CDN is reachable) on the Sozlamalar tab. It predates the
   Telegram panel and has not been diagnosed — the browser test asserts that
   controls are visible, enabled and within the viewport instead of asserting
   document-level overflow. Worth fixing during the settings redesign (stage 7).

## Testing

```
npm test                                # 46 tests
node scripts/scan-secrets.js            # working tree
node scripts/scan-secrets.js --history  # every committed blob
```

`tests/gas-harness.js` loads `script.gs` into a Node VM with
`SpreadsheetApp`, `PropertiesService`, `CacheService`, `LockService`,
`UrlFetchApp`, `Utilities`, `Session`, `ContentService` and `HtmlService`
mocked, so backend logic is unit-testable outside Apps Script.
