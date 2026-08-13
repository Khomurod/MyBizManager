# App Brief — MyBizManager

**The single orientation document for this repository.** Read it before you
change anything; update it when your change makes part of it untrue.

Everything here was verified against the code and configuration in this
repository, not copied from the older design documents. Where an older document
disagrees, this one is right — see [Documentation map](#documentation-map).

---

## 0. Permanent rule for every AI coding agent

**This brief is a living document and must stay synchronised with the real
application.** It is part of the work, not documentation housekeeping.

**Before making a change**

1. Read the sections of this brief that touch the area you are about to change.
2. Verify those claims against the current code. This brief can drift; the code
   is the source of truth. If you find a discrepancy, fix the brief as part of
   your task even when the discrepancy is unrelated to your change.

**After completing any meaningful change** — a feature, a bug fix, a removal, a
behavioural adjustment, a new or changed integration, a workflow change, a new
business rule or exception, a changed permission, a changed background job:

3. Re-read this brief.
4. If your work changed anything described here, update that part in the **same
   task and the same commit** as the change.
5. If your work introduced a new important behaviour, rule, dependency,
   integration, exception or decision, add it in the right section.
6. If something described here was removed or is no longer true, correct or
   delete it.

**A task is not complete while this brief says one thing and the application
does another.**

Keep it accurate, useful and reasonably concise. Do **not** add minor
implementation detail — function-level notes, refactor narratives, changelog
entries. This brief exists to stop an agent misunderstanding the system; detail
that does not serve that belongs in code comments or in `docs/`.

---

## 1. App purpose

MyBizManager runs the day-to-day operations of one small Uzbek business. It
covers three areas that share one backend, one database and one Telegram bot:

| Area | Business problem |
|---|---|
| **Omad** (Omad-D) | Rent and cash accounting for a commercial property: what each tenant owes, what they paid, what the business spent, and the cash/bank balance. Money is tracked in **UZS and USD**, so exchange rates are part of the accounting, not a display concern. |
| **Café** | A café's point of sale and stock: sales, recipes, ingredient consumption, margins, daily close-out. |
| **Tasks** | Assigning, reminding about and proving completion of recurring and one-off work, through Telegram. |

The whole UI is in **Uzbek (Latin)**. User-facing strings you add must match.

## 2. Main users

There is effectively **one operator/owner** plus café staff. Access is
deliberately small and simple.

| User | How they use it |
|---|---|
| Owner / accountant | `omad_admin.html` — dashboard, entry, history, settings, migration and maintenance controls. The Telegram Mini App on a phone. The `/yangi` bot conversation. |
| Café admin | `cafe_admin.html` — inventory, recipes, categories, café settings. |
| Café seller | `cafe_pos.html` — ring up sales, void, close the day. |
| Task participants | A Telegram **group**: they receive task cards and press ✅ / send a proof photo. They never touch the web apps. |

## 3. Shape of the system

```
Cloudflare Pages (static HTML/JS)         Google Apps Script web app        Google Sheets
  login.html                                 doPost  (everything)             System_Config
  omad_admin.html + assets/omad/*      ──▶   doGet   (inert banner)     ──▶   Omad_Transactions_V2
  cafe_admin.html, cafe_pos.html                                              Omad_Transactions (legacy)
  tasks.html + assets/tasks/*                                                 Cafe_Sales, Cafe_Kun_Yakuni
  mini.html + assets/mini/*  (Telegram Mini App)                              Tasks, Task_Occurrences
                                             ▲                                Omad_Job_Queue, backups, logs
                          Telegram Bot API ──┘  (webhook + outbound sends)
```

- **Backend source of truth is `apps-script/*.gs`.** They share one global
  scope and are concatenated in filename order.
- **`script.gs` is generated.** Never hand-edit it. Run `npm run build` after
  any `apps-script/` change and commit the result; `npm run build:check` fails
  CI on a stale bundle.
- **`apps-script/*.gs` is ES5 only** — `var`, no arrow functions, no
  `let`/`const`, no template literals. Private helpers end with `_`. Frontend
  code under `assets/**` and the HTML pages are modern JS.
- Frontend pages are **classic scripts in load order sharing one global
  scope** — no bundler, no modules, no framework. A static-analysis test fails
  the build if any page defines the same function twice.
- The Apps Script **manifest (`appsscript.json`) is deliberately not in the
  repository**; the deploy pulls the live project's own copy.

### Backend modules

| Module | Contents |
|---|---|
| `01_shared_utils.gs` | JSON/HTML/date helpers, `getConfig`/`setConfig`, the per-request config memo |
| `01a_periods.gs` | Canonical `YYYY-MM` periods, Uzbek labels, legacy period resolution |
| `02_validation.gs` | Rate limiting, length limits, input validators |
| `03_settings.gs` | Script Properties, secrets, `checkAdminKey_`, Telegram settings actions |
| `04_audit_history.gs` | Backups, transaction archive, audit and debug logs |
| `05_exchange_rates.gs` | Rate normalisation, `toUZS_`, balances |
| `05a_calculations.gs` | Every monetary rule (mirrored by `assets/omad/02b-calc.js`) |
| `06_tenants.gs` | Tenants and effective-dated rent |
| `07_planned_expenses.gs` | Planned (template) expenses and recurrence |
| `08_omad_transactions.gs` | Legacy sheet read/normalise/append/rewrite; `safeSaveOmad_` |
| `08a_tenant_paid.gs` | The tenant-paid-on-our-behalf pair |
| `09_telegram_service.gs` | Telegram API calls and the `/yangi` conversation |
| `10_retry_queue.gs` | `Omad_Job_Queue` worker |
| `11_report_jobs.gs` | Server-composed business reports |
| `12_cafe.gs` | Café catalogue, pricing, sales, voids, close-day |
| `13_migration.gs` | Legacy→V2 migration: preview / apply / verify / cutover / rollback |
| `14_ledger.gs` | Append-only ledger: create / correct / cancel / read / audit |
| `15_system_status.gs` | Safe diagnostics for the Sozlamalar → Tizim panel |
| `15a_maintenance.gs` | Operator repairs (dates, debug-log secrets, webhook rotation) |
| `16_tasks_recurrence.gs` | Pure Asia/Tashkent time + recurrence engine |
| `17_tasks_store.gs` | `Tasks` / `Task_Occurrences` sheets, occurrences, view model |
| `18_tasks_service.gs` | Task Telegram namespace (`t_done:`, photo proof, cards) |
| `19_tasks_scheduler.gs` | Scheduler, task queue jobs, edit reconciliation, web API |
| `19a_tasks_wizard.gs` | The `📋 Vazifa` branch of `/yangi` |
| `20_api.gs` | `doPost` / `doGet` routing and the auth gates only |
| `21_miniapp_auth.gs` | Mini App `initData` signature verification |
| `22_miniapp_api.gs` | Mini App summaries and write actions |
| `23_health.gs` | Mini App configuration via Bot API, and the system health check |

## 4. Main features and workflows

### Omad (rent & cash accounting)
- **Dashboard** — period income/expense/net, all-time cash/bank/total, tenant
  debt, plan-vs-actual.
- **Entry (`Yangi`)** — a cart of lines (amount + currency + method) saved as
  one business action. Three shapes: ordinary income, ordinary expense, and the
  **tenant-paid expense pair**.
- **History (`Tarix`)** — entries grouped by `Entry_Group_ID`, editable and
  cancellable **as a group**.
- **Sozlamalar** — five sections: 💱 Kurslar (rates), 🏢 Ijarachilar (tenants),
  🧾 Rejali Chiqim (planned expenses), 📨 Telegram, 🗄️ Tizim (backups, migration,
  job queue, health, Mini App setup, data repairs).

### Café
- **POS** sends *which items and how many*; the server prices, costs, checks
  stock, moves stock and writes the sale — see [§6](#6-important-business-rules).
- **Void** restores stock from the stored receipt.
- **Close day** totals revenue and profit from recorded sales and accepts only
  the operator's **counted** stock level.
- **Admin** edits inventory, recipes, categories and the daily target.

### Tasks (`/tasks` and Telegram)
- Task types: `once`, `routine` (daily / weekdays / weekly interval / monthly
  day-or-last / custom N-day), `goal` (ordered steps).
- Occurrence statuses: `Open | WaitingProof | Completed | Cancelled | Skipped`.
  **`Overdue` is derived on read, never stored.**
- The Telegram group receives a card per occurrence with a ✅ button; a
  photo-proof task is *claimed* by pressing, then completed only by a photo
  replying to the prompt from the claimant.
- Board tabs: Bugun | Vazifalar | Muntazam | Maqsadlar | Bajarilgan.

### Telegram bot (`/yangi`, private chat only)
Guided entry of an income/expense transaction, or — via the **📋 Vazifa**
button — creation of a task. Wizard callbacks use the `bot_vz` prefix.

### Telegram Mini App (`/mini`)
Phone-first, three tabs: 💰 Omad (figures, tenant debt, recent entries, and the
three entry forms), ☕ Kafe (monitoring only), ✅ Vazifalar (the same task
engine). Rates, tenant schedules, planned expenses, migration and maintenance
are **deliberately not** in the Mini App.

## 5. Permissions and access rules

There are exactly **three** ways to be authorized, and every action belongs to
one of them.

| Gate | Proves | Used by |
|---|---|---|
| **Access key** — `OMAD_ADMIN_KEY` in Script Properties, compared by `checkAdminKey_` | you signed in | every web-app action, every admin/maintenance/migration action, and every `/tasks` action **including reads** |
| **Telegram `initData`** — HMAC verified against the bot token | Telegram signed this **and** you are `TELEGRAM_AUTHORIZED_USER_ID` | the Mini App (`mini_*` actions) |
| **Webhook secret (`?wh=`) + authorized user id** | Telegram delivered this update | the bot |

Rules that must not be weakened:

- **`doGet` is inert.** It reads nothing and answers every request with one
  sentence. A GET puts parameters in the URL, which is the one place a key must
  never be. The old anonymous `get_omad` / `get_cafe` GET routes are **gone**;
  `tests/anonymous-access.test.js` is the regression inventory and the health
  check probes the live router for them.
- `mini_*` actions are routed **first** in `doPost`, so one can never fall
  through into a handler with a different gate. **Any action name starting with
  `mini_` is Mini-App-gated** — do not name a new admin action `mini_…`.
- **The admin key is never sent to, or accepted from, the Mini App.**
- Mini App task mutations **strip** attribution fields (`completedById`,
  `completedBy`, `completedByName`, `completedSource`, `createdBy`,
  `proofAwaitingUserId`) from the payload and rewrite them from the verified
  signature. Stripped rather than overwritten, so a new attribution field cannot
  become spoofable just by being forwarded.
- The key comparison happens **after** a rate limit on every path that exposes
  it (`read_auth`, `tg_admin`, `tasks_read`, `mini_auth`), so the endpoint
  cannot be used to guess the key.
- `/yangi` runs **only in a private chat with the authorized user**. The
  reporting group never accepts entry.

### The web "roles" are not a security boundary

`login.html` holds three username/password pairs in plain page source
(`omad_admin`, `cafe_admin`, `cafe_seller`). They only choose which page opens
and which `localStorage` guard passes. **Server-side there is one key and one
permission level:** a café seller's stored key is the same `OMAD_ADMIN_KEY` that
unlocks the accounting and the maintenance actions. Do not add a feature that
assumes the server can tell the three roles apart — it cannot.

`/tasks` is a double gate in practice: `assets/omad/00-config.js` redirects
anyone not signed in as `omad_admin`, and the board additionally asks for the
admin key, which it keeps only in `sessionStorage`.

## 6. Important business rules

**Money**

- **Every UZS figure the business acts on uses the `sell` rate — including
  projections.** The `buy` rate is recorded for history and used in no
  calculation. Mixing them made tenant debt wrong by the spread.
- A **ledger row freezes** `Rate_Buy`, `Rate_Sell`, `Rate_Used` and
  `Amount_UZS` at write time; every consumer reads `Amount_UZS`. Changing a rate
  therefore cannot move a historical figure. Legacy rows have no frozen value
  and are still converted live.
- Income / expense / net are scoped to the selected period. **Cash, bank and
  total are always all-time** — money in the safe does not reset with the
  reporting month.
- `Cancelled`, `Corrected` and `Void` rows are excluded from every figure.
- `apps-script/05a_calculations.gs` and `assets/omad/02b-calc.js` are **two
  implementations of the same rules**, compared field-by-field by
  `tests/calc-parity.e2e.js`. **Never change one without the other.**

**Periods**

- Canonical period is `YYYY-MM`. Uzbek labels (`Yanvar 2026`) are produced for
  display and never stored.
- Legacy month-name rows are resolved in a fixed order (exact period → month
  name agreeing with the date → December/January adjacency → conflict → date
  only → configured fallback year → unresolved). Two-digit years, impossible
  days and `29/02` in a non-leap year are **rejected, never guessed**.

**Tenants**

- Rent is **effective-dated**. Resolution order, highest first: inactive or
  outside `startPeriod`/`endPeriod` → 0; legacy `disabledMonths` → 0;
  `noRentPeriods` → 0; `exceptions` → that amount; latest applicable
  `rentChanges`; `defaultRent`.
- **Tenants are never deleted** — their payment history has to keep resolving.
  Deactivating or setting an end period is what "removing" means.

**Planned expenses** are a *plan*, never money that moved. Projection and actual
figures are reported side by side and **never summed** — a paid planned expense
appears in both, and adding them double-counts it. Intervals count from
`startPeriod`, so an expense starting in November falls due in February, May,
August — it keeps its own rhythm rather than snapping to calendar quarters.

**Tenant-paid expenses** (`tenant_paid_expense`) — a tenant settles one of our
bills and it comes off what they owe:

- Two rows (income against the tenant, expense against `Umumiy Naqd Puldan` /
  `Umumiy Bankdan` matching the method) written in **one** `setValues` call, so
  partial creation is unreachable.
- The expense is booked against the same method, so **cash and bank do not
  move**: the tenant's balance changes, ours does not. Both facts are still
  reported in period totals rather than netted away.
- The tenant must be a **real tenant** (not an expense bucket) and a **purpose
  is required** — it is what makes the expense half readable a year later.
- Created, reported, edited and cancelled **as a pair**, resolved by
  `Entry_Group_ID`.

**Café — the server is authoritative**

- The POS sends only items and quantities. Price, cost, stock movement, totals,
  profit and close-day revenue are all computed server-side from the catalogue.
  An item the catalogue does not contain is refused; a sale the stock cannot
  cover is refused by name.
- `saveCafeSale_` runs entirely **under the script lock** (read-modify-write on
  stock), and is keyed by `requestId` — a retry or double tap answers
  `duplicate: true` and moves stock once.
- A **void restores stock from the stored receipt**, never from an inventory the
  browser supplies; voiding twice is a no-op.
- Inventory is written in exactly one place, `writeCafeInventory_`, which bumps
  `Cafe_Inventory_Rev`. The admin screen must quote the revision it loaded
  (`expectedRev`); a mismatch is refused. A **counted** stock level at close-day
  is deliberately *not* version-checked — a physical count is a measurement, not
  an edit of a stale copy.

**Tasks**

- All scheduling and display use **Asia/Tashkent**, a fixed UTC+5 implemented
  with epoch-ms math in `16_tasks_recurrence.gs`. Never introduce
  `Utilities.formatDate` or host-local date maths into the task modules.
- **A task's type is immutable.** `save_task` refuses a type change.
- `Remind_Daily` means "every Tashkent day the occurrence stays open, and not
  one day more" — including past the deadline — stopping the moment it is
  completed, cancelled or skipped.
- **Pausing a routine stops everything**, including days already materialised;
  unseen future days are removed. Completed, skipped and already-announced days
  survive as history.
- A removed goal step keeps its row (flagged `Meta_JSON.removedStep`) and drops
  out of progress.
- On an edit, **an absent field means "leave alone"; an explicitly empty one
  clears**. `startKey` is the deliberate exception — a routine must begin
  somewhere, so a blank keeps the stored value.
- Task columns are **positional on read**: you may append a column to
  `TASKS_HEADER` / `TASK_OCC_HEADER`, never insert or reorder.

**Saving, everywhere**

Apps Script answers HTTP 200 for almost everything, including its own errors. A
save counts as successful only when the body parses **and** says
`status: "success"`. On anything else the client keeps the form, the cart and
the request id so the entry can be retried without duplicating.

## 7. Data other features depend on

**`System_Config`** is a key/value sheet (column A key, column B a JSON string):
`Omad_Tenants`, `Omad_Rates`, `Omad_Rates_V1_Backup`, `Omad_Template_Expenses`,
`Omad_Active_Transactions_Sheet`, `Omad_Migration_Status`,
`Omad_Migration_Fallback_Year`, `Cafe_Inventory`, `Cafe_Inventory_Rev`,
`Cafe_Recipes`, `Cafe_Categories`, `Cafe_Settings`.

**`Omad_Transactions_V2`** — the live append-only ledger (schema version 2, 23
columns): `ID, Request_ID, Created_At, Updated_At, Created_By, Source, Period,
Tenant, Type, Amount, Currency, Rate_Buy, Rate_Sell, Rate_Used, Rate_Type,
Amount_UZS, Method, Comment, Status, Related_ID, Telegram_Msg_ID,
Schema_Version, Entry_Group_ID`.

**`Omad_Transactions`** — the legacy 13-column sheet, kept intact so
`rollback_omad_migration` stays one action. Still the write path if a rollback
happens.

Other sheets: `Omad_Backups`, `Omad_Transaction_Archive`, `Omad_Audit_Log`,
`Telegram_Debug_Log`, `Cafe_Sales`, `Cafe_Kun_Yakuni`, `Tasks`,
`Task_Occurrences`, `Omad_Job_Queue`.

**Two identifiers everything else hangs off:**

- **`Entry_Group_ID`** — the business action a row belongs to. It is **stored,
  never inferred** (timestamps collide, and a two-sided entry spans id bases).
  Web entry mints `grp_web_<millis>_<random>` once per submission and keeps it
  in `sessionStorage`, so a retry lands in the same group; an edit reuses the
  group it edits. `/yangi` uses `grp_<uuid>` per conversation. Rows predating the
  column resolve to a deterministic `grp_legacy_<idBase>`. Reporting, editing,
  cancellation and history **all resolve rows through it**.
- **`Entry_Kind`** — `""` (ordinary) or `tenant_paid_expense`. Stored rather
  than deduced; a correction inherits it, so an entry cannot change kind by
  being edited.

**Script Properties** (secrets never reach the browser): `TELEGRAM_BOT_TOKEN`*,
`OMAD_ADMIN_KEY`*, `TELEGRAM_WEBHOOK_SECRET`*, `TELEGRAM_AUTHORIZED_USER_ID`,
`TELEGRAM_GROUP_CHAT_ID`, `TELEGRAM_TASKS_GROUP_CHAT_ID`,
`TELEGRAM_WEBHOOK_URL`, `TELEGRAM_WEBHOOK_STATUS`, `TELEGRAM_LAST_SUCCESS`,
`TELEGRAM_LAST_ERROR` (`*` = secret). They are project state, not code — the
deploy never touches them.

## 8. Integrations

| Integration | What depends on it |
|---|---|
| **Google Sheets** (`1Q9_v2Prus…v963CA`) | the entire database |
| **Google Apps Script** web app `/exec` | the entire backend; one deployment id, never recreated |
| **Telegram Bot API** | `/yangi` entry, task cards and reminders, group reports, the Mini App menu button and its `initData` signature |
| **Cloudflare Pages** (`mybizmanager.pages.dev`) | serves the static frontend from `main`, no build step; serves `/mini` and `/tasks` as clean paths with no config |
| **GitHub Actions + clasp** | the backend deployment pipeline |

**The `/exec` URL is hardcoded in five places, which must always agree:**
`assets/omad/00-config.js`, `assets/mini/00-config.js`, `login.html`,
`cafe_admin.html`, `cafe_pos.html`. (`omad_admin.html` and `tasks.html` get it
from `assets/omad/00-config.js`.)

**There is no generic Telegram proxy.** `telegram_send` / `telegram_edit` /
`telegram_delete` were removed — they let any caller post arbitrary text into
the reporting group. The browser submits a *business operation* and the server
composes the message from data it already stored.

## 9. Automatic and background behaviour

- **One time-driven trigger: `processPendingTelegramJobs`, every 5 minutes.** It
  runs the task scheduler first (so a reminder coming due now is enqueued and
  sent in the same tick) and then drains `Omad_Job_Queue`. The scan is wrapped
  in a `try` because this queue also carries financial reports. **No second
  trigger is needed**; `processTaskSchedules` remains a safe manual entry point.
- **Every Telegram send is a queued job**, so an outage degrades to "the report
  is late", never "the money is wrong". Jobs are claimed under the script lock,
  retried with exponential backoff from ~30s, and give up after
  `JOB_MAX_ATTEMPTS = 5`. Job types: `omad_transaction_report`,
  `omad_transaction_delete_report`, `cafe_close_day_report`, `task_notify`,
  `task_reminder`, `task_update_message`, `task_proof_prompt`.
- A permanently failed job gets one `onJobPermanentlyFailed_` call so it can
  clean up state — `task_proof_prompt` uses it to release an occurrence that
  would otherwise wait forever for a prompt that was never delivered.
- **Fast saving:** a write returns as soon as the record is stored; at most
  **one** queued job drains inline (`JOB_QUEUE_INLINE_BATCH = 1`), so response
  time does not grow with the backlog. `deferReports: true` skips the inline
  drain. **Failing to *queue* a report never fails a save that already
  succeeded** — the enqueue is wrapped and logged.
- The Mini App calls `mini_flush_reports` after a write **without awaiting it**,
  so the group card appears in seconds instead of at the next tick. Losing that
  request costs a delay, never a report.
- The task scheduler materialises occurrences for today + a 14-day horizon,
  idempotent on `(taskId, dateKey)` / `(taskId, stepIndex)`, marks each reminder
  slot **at enqueue time**, and suppresses reminders missed by more than 3 hours
  rather than blasting them after downtime.
- **`System_Config` reads are memoised for one request** (`getConfigOnce_`).
  `resetRequestMemos_()` runs at the top of `doPost` and `doGet`, and `setConfig`
  drops the entry it overwrites so a read-after-write in the same request sees
  the new value. The memo caches the **read**, never the decision made from it.
  **There is no cross-request cache, by design** — every candidate is a financial
  summary with six write paths, and a missed invalidation is a wrong balance.

## 10. Relationships — where one change breaks another

| If you touch… | Also check |
|---|---|
| `apps-script/05a_calculations.gs` | `assets/omad/02b-calc.js` (and `tests/calc-parity.e2e.js`) — mirrors |
| `apps-script/06_tenants.gs` | `assets/omad/04-tenants.js` — mirrors |
| `apps-script/01a_periods.gs` | `assets/omad/01b-periods.js` — mirrors |
| any `apps-script/*.gs` | run `npm run build`, commit `script.gs` |
| a transaction write path | the ledger, the group report job, the history grouping, the Mini App and the bot all read the same rows |
| the ledger row shape | `13_migration.gs` verification compares fields; adding a field means teaching it |
| an inventory write | must go through `writeCafeInventory_` or the revision guard silently stops working |
| an action name | check the routing order in `20_api.gs` — `mini_*` first, then tasks, then reads, then the rest; a café action is matched last |
| deleting or renaming a backend function | add it to `RETIRED_FUNCTIONS` in `scripts/clasp-deploy.js` with a reason, or the deploy's drift guard fails |
| a new money input field | add its id to `MONEY_FIELD_IDS` |
| the task sheets | columns are positional — append only |

## 11. Decisions that must be preserved

1. **The ledger is append-only.** Financial records are never rewritten in
   place and never deleted. A correction appends the replacement **first**, then
   marks the original `Corrected`; if the second write fails the replacement is
   marked `Void` and the correction reported failed. Never a hidden original.
   The whole-list `save_omad` rewrite is **refused for transactions** while V2 is
   live (`saveOmadSettingsOnly_` runs instead); tenants, rates and planned
   expenses still save through it.
2. **Migration never destroys the source.** `apply_omad_migration` rebuilds
   `Omad_Transactions_V2` from scratch and never touches the legacy sheet;
   `rollback_omad_migration` points reads back and restores the pre-migration
   rate map without deleting migrated data. **It does destroy the *target*:**
   apply clears V2 and repopulates it from the legacy sheet alone, and no guard
   stops it running while V2 is live — so it must never be run while the
   migration state is `cutover`. The full precondition chain is in
   [`ARCHITECTURE.md`](ARCHITECTURE.md#migration-and-cutover).
3. **Tasks never touch financial data — one-way isolation.** The `/yangi`
   conversation may *create* a task; nothing in the task module reads or writes
   a transaction, tenant, rate or backup. `19a_tasks_wizard.gs` is never handed
   `configSheet`, which makes this structural. `tests/task-isolation.test.js` and
   `tests/static-analysis.test.js` enforce it.
4. **`bot_vz`, not `t_`, for wizard callbacks.** `isTaskTelegramUpdate_` claims
   any `t_`-prefixed callback *before* any chat or user check, so a `t_` wizard
   would sit on the one path with no authorization gate.
5. **Server-composed Telegram messages only** (no generic proxy — see §8).
6. **Idempotency on every write.** `/yangi` uses its `sessionId`; web entry
   mints a request id per submission and mirrors it into `sessionStorage` so a
   mid-save refresh resubmits the *same* id; café sales use `requestId`; the
   wizard finds an existing task by `Meta_JSON.tgRequestId`.
7. **Money inputs stay `type="text"` with `inputmode="decimal"`.** A
   `type="number"` field rejects the grouping spaces; `inputmode` is what raises
   the numeric keypad. `cleanMoneyString`'s rule: the last separator is a decimal
   point only when followed by one or two digits, or nothing.
8. **Mini App form controls are 16px and the page allows pinch-zoom.** iOS
   auto-zooms a focused control smaller than 16px; fixing the font size fixes the
   cause, so `maximum-scale` / `user-scalable=no` are gone from `mini.html` and
   `tasks.html` and the browser tests refuse to let them back. (`login.html`,
   `omad_admin.html`, `cafe_admin.html` and `cafe_pos.html` still carry them;
   changing that is a separate decision.)
9. **Telegram task cards are HTML and every interpolated value is escaped.**
   The description budget is applied to the **raw** text before escaping, and an
   over-long message drops the description rather than truncating unsafely.
   Wizard messages are plain text with **no** `parse_mode` on purpose.
10. **Deploy by moving the existing deployment, never by creating one.** "New
    deployment" mints a URL nothing calls — this is why production once ran stale
    code for weeks.
11. **Never weaken a test to make CI green.** Updating an assertion to the new
    contract is fine; deleting it is not.

## 12. Known limitations and intentional exceptions

- **The legacy pre-cutover path is not idempotent.** It is dormant while V2 is
  live and exists for rollback.
- **Legacy rows carry no frozen exchange rate** and are converted live.
- **Historical `Date` column transposition:** older rows may show day and month
  swapped. **Cosmetic only** — the period/`Month` column drives every figure.
  `audit_transaction_dates` classifies and `fix_transaction_dates` corrects only
  **provably** transposed rows (swapping reproduces the instant the id encodes);
  anything unprovable is reported and never touched.
- **`ScriptApp.getProjectTriggers()` throws** because the live manifest's OAuth
  scopes omit `script.scriptapp`, so the health check reports the trigger as
  unreadable. The trigger itself works. Fixing it needs a manifest scope change
  and a re-authorisation of the deployment.
- **`cafe_admin.html` recipes, categories and settings still save wholesale with
  no version check.** Only inventory is guarded, because only inventory is also
  written by the server.
- **The repository is public and its git history contains committed financial
  dumps** — the 2026-04 `diagnostics/` snapshots, with real tenant names and
  amounts. They are no longer in the working tree, but removing files does not
  remove them from history. Making the repo private, or rewriting history, is
  the owner's call. **Do not commit another data export.**
- **The Script ID and the leaked bot tokens are recoverable from git history.**
  Treat them as known, not rotated. Current secrets live only in Script
  Properties. `docs/TELEGRAM_SETUP.md` holds the history-rewrite procedure if
  it is ever wanted.
- **The Mini App has never been exercised on a real phone** — signed `initData`
  cannot be produced without the bot token. It is covered by integration and
  browser tests only.
- **On Windows, `build:check` can report the bundle stale purely from CRLF line
  endings.** It is LF-clean in git and passes in CI.
- **One tenant (O'quv Markaz) carries both an August 2026 exception and a rent
  change effective 2026-08, both 500 USD.** They agree, so the result is correct
  either way; the duplication is unresolved.

## 13. Testing and operational expectations

```
npm run build            # regenerate script.gs from apps-script/
npm run build:check      # fail if the bundle is stale
npm run lint             # static analysis: syntax, duplicates, deploy gating
npm test                 # unit/integration tests (node --test)
npm run test:e2e         # Playwright/Chromium browser flows
npm run scan:secrets     # working tree
npm run scan:secrets:history   # every committed blob
```

- `tests/gas-harness.js` loads `script.gs` into a Node VM with `SpreadsheetApp`,
  `PropertiesService`, `CacheService`, `LockService`, `UrlFetchApp`,
  `Utilities`, `Session`, `ContentService` and `HtmlService` mocked, so backend
  logic is testable outside Apps Script. **The harness's fidelity matters** — a
  previously wrong `Utilities.formatDate` mock hid a real class of bug.
- CI (`.github/workflows/ci.yml`) runs static analysis, secret scans (tree *and*
  full history), unit tests and browser tests on **every branch and PR**. On
  `main` only, a green run then deploys: `clasp pull` (live manifest) → stage →
  `clasp push -f` → new version tagged with the commit → `update-deployment`
  against the **existing** deployment id.
- The deploy **fails closed**: missing credentials fail the job and name what is
  absent. There is no enable switch.
- **The drift guard**: the deploy refuses to push when the live project defines a
  function the repository does not (someone edited the web IDE). Fix it by
  porting the function in, or by adding it to `RETIRED_FUNCTIONS` with a reason.
  Do **not** reach for `APPS_SCRIPT_ALLOW_REMOTE_DRIFT` — it disarms the guard
  for everything.
- **Editing the live Apps Script project is not a way to ship.** GitHub `main`
  is the source of truth; the next merge overwrites the editor.
- **Never push to `main` directly** — develop on a branch and open a PR.
- **Before a live financial change:** `create_backup`, snapshot via
  `get_omad_data`, make the change, then diff the snapshot and confirm tenant
  balances are identical. Reverse test records; never delete audit history.

### Rollback levers

| Situation | Action |
|---|---|
| V2 misbehaving | `rollback_omad_migration` — the legacy sheet is intact |
| Bad backend deploy | Re-run CI on a known-good commit; the deployment id never changes |
| Bad frontend deploy | Cloudflare Pages keeps every deployment; roll back in the dashboard |

## 14. Live state

Verified 2026-08-12 and unchanged in the repository since:

| | |
|---|---|
| Active transaction sheet | **`Omad_Transactions_V2`** — the append-only ledger, cut over 2026-08-12 |
| Migration state | `cutover` (fallback year `2026`) |
| Legacy sheet | `Omad_Transactions`, intact, 226 rows |
| Frontend | Cloudflare Pages, auto-deploying `main` |
| Anonymous access | closed — `doGet` reads nothing |
| Telegram | webhook on the active deployment with a URL secret; one 5-minute trigger |
| Mini App | menu button installed and verified |

Hosting, project ids and the deployment id are in `docs/DEPLOYMENT.md` — the
one place that records them. If a change makes any of this untrue, update it
there and here.

## Documentation map

Five documents, each authoritative for one thing. Nothing else in this
repository is project documentation.

| File | What it is |
|---|---|
| **`docs/APP_BRIEF.md`** (this file) | Orientation: what the app is, its rules, gates, jobs and preserved decisions. Read first. |
| `docs/ARCHITECTURE.md` | Design reference: sheet schemas, data shapes, the API surface, and why each mechanism is shaped the way it is. |
| `docs/DEPLOYMENT.md` | The CI pipeline, its one-time secrets, where everything is hosted, and how to roll back. |
| `docs/TASKS.md` | Deep reference for the task module. |
| `docs/TELEGRAM_SETUP.md` | Operator guide for bot, webhook, group and Mini App setup (Uzbek). |

`CLAUDE.md` says how to work here; `.claude/skills/implement/` is the change
workflow. `README.md` is a short entry point, not a second brief.

Completed plans, migration runbooks, session handovers and the 2026-04
diagnostic snapshots have been removed — git history holds them, and the rules
worth keeping from them live in the documents above.
