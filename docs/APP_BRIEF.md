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
  assets/session.js  (shared session/transport)  ▲                            Omad_Job_Queue, backups, logs
  assets/css/app.css (generated Tailwind build)  │
                          Telegram Bot API ──────┘  (webhook + outbound sends)
```

- **`assets/session.js` is loaded first by every web page.** It owns what being
  signed in means, what a failed request means, and the per-screen snapshot.
  Four screens behaving differently about any of those is what caused the café
  incident.
- **`assets/css/app.css` is generated and committed.** The pages used to load
  the Tailwind Play CDN, which compiles the stylesheet in the browser on every
  load. `npm run build:css` regenerates it; Cloudflare Pages has no build step,
  which is why the output is in the repository.

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
| `01c_cache.gs` | Revision counters and the read-only summary cache |
| `01d_read_model.gs` | The materialised Omad summary: build, verify, rebuild |
| `02_validation.gs` | Rate limiting, length limits, input validators |
| `02a_auth.gs` | Users, password hashes, session tokens, roles, login throttling |
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
| `12a_cafe_catalogue.gs` | Recipe costing, catalogue revision, health warnings, stock movements |
| `12b_cafe_write_performance.gs` | Narrow café sale / stock-movement retry lookup and the recent-movements tail read, without changing stock or idempotency rules |
| `13_migration.gs` | Legacy→V2 migration: preview / apply / verify / cutover / rollback |
| `14_ledger.gs` | Append-only ledger: create / correct / cancel / read / audit |
| `14a_ledger_write_performance.gs` | Fast ledger request / transaction-id lookup, ID allocation and atomic multi-line entry creation |
| `15_system_status.gs` | Safe diagnostics for the Sozlamalar → Tizim panel |
| `15a_maintenance.gs` | Operator repairs (dates, debug-log secrets, webhook rotation) |
| `16_tasks_recurrence.gs` | Pure Asia/Tashkent time + recurrence engine |
| `17_tasks_store.gs` | `Tasks` / `Task_Occurrences` sheets, occurrences, view model |
| `18_tasks_service.gs` | Task Telegram namespace (`t_done:`, photo proof, cards) |
| `19_tasks_scheduler.gs` | Scheduler, task queue jobs, edit reconciliation, web API |
| `19a_tasks_wizard.gs` | The `📋 Vazifa` branch of `/yangi` |
| `19b_tasks_write_performance.gs` | Single-row task/occurrence lookup, and the on-demand `settle_tasks` / `mini_settle_tasks` schedule scan |
| `20_api.gs` | `doPost` / `doGet` routing and the auth gates only |
| `20a_write_performance_api.gs` | Batch-ledger API extension with rollout-safe fallback semantics |
| `21_miniapp_auth.gs` | Mini App `initData` signature verification |
| `22_miniapp_api.gs` | Mini App summaries and write actions |
| `23_health.gs` | Mini App configuration via Bot API, and the system health check |

## 4. Main features and workflows

### Omad (rent & cash accounting)
- **Dashboard** — period income/expense/net, all-time cash/bank/total, tenant
  debt, plan-vs-actual, and a short recent-activity list. It downloads **no
  transaction history**: the figures come from the read model (see
  [§9](#9-automatic-and-background-behaviour)) and switching months repaints
  from them without a round trip.
- **Entry (`Yangi`)** — a cart of lines (amount + currency + method) saved as
  one business action. Three shapes: ordinary income, ordinary expense, and the
  **tenant-paid expense pair**. A new multi-line ledger entry is committed by
  one batch action and one ledger write; the single-row API remains the safe
  rollout fallback and the edit/correction path.
- **History (`Tarix`)** — entries grouped by `Entry_Group_ID`, editable and
  cancellable **as a group**. Fetched a page of 40 business actions at a time
  (`get_omad_history`) when the tab is opened, never with the dashboard. A page
  always carries *every* row of each group on it, so an edit and a cancellation
  still see the whole business action.
- **Sozlamalar** — five sections: 💱 Kurslar (rates), 🏢 Ijarachilar (tenants),
  🧾 Rejali Chiqim (planned expenses), 📨 Telegram, 🗄️ Tizim (backups, migration,
  job queue, health, Mini App setup, data repairs).

### Café
- **POS** sends *which items and how many*; the server prices, costs, checks
  stock, moves stock and writes the sale — see [§6](#6-important-business-rules).
- **Void** restores stock from the stored receipt.
- **Close day** totals revenue and profit from recorded sales and accepts only
  the operator's **counted** stock level.
- **Admin** edits inventory, recipes, categories and the daily target, moves
  stock for reasons that are not sales (spoilage / waste / internal use /
  correction), and reads the warning layer: broken or duplicated recipes,
  low stock, and prices that look wrong.

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
engine, including reminder times, the daily-repeat choice and editing). Rates, tenant schedules, planned expenses, migration and maintenance
are **deliberately not** in the Mini App.

## 5. Permissions and access rules

There are **three** ways to be authorized, and every action belongs to one of
them.

| Gate | Proves | Used by |
|---|---|---|
| **Session token** — signed by `OMAD_SESSION_SECRET`, minted by `login`, carries the username, the role and an expiry | you signed in as this person, in this role | every web-app action: `omad_admin.html`, `cafe_admin.html`, `cafe_pos.html`, `tasks.html` |
| **Telegram `initData`** — HMAC verified against the bot token | Telegram signed this **and** you are `TELEGRAM_AUTHORIZED_USER_ID` | the Mini App (`mini_*` actions) |
| **Webhook secret (`?wh=`) + authorized user id** | Telegram delivered this update | the bot |

`OMAD_ADMIN_KEY` survives as an **internal break-glass credential**. It is
accepted as `omad_admin` wherever a session would be, so maintenance and
migration still work against a project whose user store is not set up. No
normal user needs to know it, no page asks for it, and no browser stores it.

### The three web roles are enforced on the server

| Role | May do |
|---|---|
| `omad_admin` | everything: the ledger, tenants, rates, planned expenses, settings, migration, maintenance, health, the task board, and both halves of the café |
| `cafe_admin` | read the café; edit inventory, recipes, categories and café settings |
| `cafe_seller` | read the café; ring up a sale, void one, close the day |

The role lists live in one place, `AUTH_ROLES_*` in `20_api.gs`, and every gate
names one. **Editing `localStorage` or opening another URL changes nothing** —
the role is inside a signed token the browser cannot forge, and the refusal
happens on the server. A refusal for the wrong role answers `code: "forbidden"`
and `authExpired: false`, which is deliberately *not* the shape that signs a
client out.

### Sessions

- Format `v1.<username>.<role>.<expiry>.<pwv>.<nonce>.<signature>`, signed with
  HMAC-SHA256. Stateless, so losing the cache or restarting the project cannot
  sign anybody out.
- **30 days.** Long enough that nobody is asked to sign in repeatedly.
- The stored record still decides: a changed password bumps `pwv` and every
  token carrying the old one stops working on the next request. That is the
  revocation mechanism, and it is what a password change is expected to do.
- Passwords are stored in `OMAD_USERS` as a per-user salt plus 200 chained
  HMAC-SHA256 rounds. **No password, and nothing replayable derived from one,
  is ever sent to a browser or committed.**

### Throttling

Three buckets, deliberately not one, and **a successful request never touches
any of them**:

| Bucket | Limit | Filled by |
|---|---|---|
| `login_u_<username>` | 8/min | failed logins for that one account |
| `login_all` | 100/min | all failed logins |
| `auth_fail` / `auth_key` | 10/min | a forged token, a wrong admin key, no credential at all |
| `user_<username>` | 120/min | that signed-in user's own requests |

This is the fix for the café incident. One shared bucket meant a stranger
guessing keys — or a second tab — could throttle the till, and the 40/min
hotfix that relieved the till also gave a guesser four times as many attempts.
The key comparison still happens **after** its own rate limit, so the endpoint
still cannot be used to guess it.

Rules that must not be weakened:

- **`doGet` is inert.** It reads nothing and answers every request with one
  sentence. A GET puts parameters in the URL, which is the one place a
  credential must never be. `tests/anonymous-access.test.js` is the regression
  inventory and the health check probes the live router.
- `mini_*` actions are routed **first** in `doPost`, so one can never fall
  through into a handler with a different gate. **Any action name starting with
  `mini_` is Mini-App-gated** — do not name a new admin action `mini_…`.
- **Neither the admin key nor a web session is accepted by the Mini App**, and
  the Mini App is never given one.
- Mini App task mutations **strip** attribution fields (`completedById`,
  `completedBy`, `completedByName`, `completedSource`, `createdBy`,
  `proofAwaitingUserId`) from the payload and rewrite them from the verified
  signature. Stripped rather than overwritten, so a new attribution field cannot
  become spoofable just by being forwarded.
- `/yangi` runs **only in a private chat with the authorized user**. The
  reporting group never accepts entry.

### Setting a password

`omad_admin` sets and resets every account from **Sozlamalar → 🗄️ Tizim →
Foydalanuvchilar**. Before any password exists, signing in as `omad_admin` with
the value of `OMAD_ADMIN_KEY` works once — that bootstrap answers
`bootstrap: true`, the login page says so, and it stops working the moment the
owner's own password is set. `setUserPassword(username, password, role)` in the
Apps Script editor does the same thing without a browser.

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
- A stored receipt has **two shapes**: `{ requestId, items: [...] }` since the
  café became server-authoritative, and a bare array before that. Every reader
  goes through `cafeReceiptItems_`, which resolves both. Handing the wrapper on
  as `items` is what made `sale.items.forEach(...)` throw on every modern
  receipt — and in the POS that threw inside the load, whose failure path then
  emptied the till.
- Inventory is written in exactly one place, `writeCafeInventory_`, which bumps
  `Cafe_Inventory_Rev`. The admin screen must quote the revision it loaded
  (`expectedRev`); a mismatch is refused. A **counted** stock level at close-day
  is deliberately *not* version-checked — a physical count is a measurement, not
  an edit of a stale copy — but it does leave a `recount` movement behind.
- **The catalogue has its own revision**, `Cafe_Catalogue_Rev`, bumped by every
  recipe, category and settings write and by nothing else. It is deliberately
  *not* the inventory counter: a sale bumps that one, and a busy till must never
  stop the manager editing a recipe. The check is opt-in — a caller that names
  `expectedCatalogueRev` is held to it exactly, and one that names none is an
  older client that could not quote it however strict the rule was.
- **A recipe's cost is derived, never sent.** `save_recipe` recomputes every
  ingredient line and the `baseCost` from the inventory as it is now, so a
  recipe cannot price a sale at one cost and the stock movement at another. An
  edit **keeps the recipe's id**, because sales reference recipes by id.
- **A recipe is retired, not deleted** (`active: false`). It leaves the POS
  menu and `resolveCafeSaleLines_` refuses it; every sale that already named it
  keeps its stored receipt and keeps counting.
- **Stock leaves for reasons that are not sales.** `adjust_cafe_stock` applies
  one movement under the script lock, keyed by `requestId`, and writes a row to
  `Cafe_Stock_Movements` saying which reason (`purchase`, `spoilage`, `waste`,
  `internal`, `correction`, `recount`) and why. A withdrawal larger than the
  shelf is refused — except `correction`, which is the admin saying the *count*
  was wrong. The retry check reads only the `Request_ID` column and then the one
  matching row, and a screen asking for recent movements is handed only the tail
  it will show — the whole history is never transferred to answer either.
- **Close-day refuses two accidents once each**, and neither is blocked: a
  second report for a day that already has one (`duplicate_close`) and a report
  for a day with no recorded sales (`empty_close`). Each is re-sent with
  `confirmDuplicate` / `confirmEmpty` when the operator says yes, so a genuine
  correction or a genuinely shut day still goes through — deliberately.

**Tasks**

- All scheduling and display use **Asia/Tashkent**, a fixed UTC+5 implemented
  with epoch-ms math in `16_tasks_recurrence.gs`. Never introduce
  `Utilities.formatDate` or host-local date maths into the task modules.
- **A task's type is immutable.** `save_task` refuses a type change.
- `Remind_Daily` means "every Tashkent day the occurrence stays open, and not
  one day more" — including past the deadline — stopping the moment it is
  completed, cancelled or skipped.
- **Reminders on a one-time task with no deadline are daily, and the engine
  decides that, not the form.** There is no deadline day to hang a single
  reminder on, so `remindDaily: false` there would mean reminders that never
  fire. `normalizeTaskInput_` forces it. The three clients that build the
  payload — the `/tasks` board, the Mini App and the `/yangi` wizard — all show
  the choice as locked, but none of them is what makes it true.
- **`reminderTimes` is a list of Asia/Tashkent `HH:mm` strings**, deduplicated
  and sorted on save. Several times a day is one card each: the sent-marker is
  `"<dateKey> <HH:mm>"`, so a scheduler pass that runs twice inside one slot
  cannot send twice. Nothing about the phone's or the browser's timezone enters
  it — both editors say so on the field.
- **Reminder times are the notification schedule, not an extra ping.** An
  occurrence with reminder times does not also send an immediate/midnight
  `Yangi vazifa`; its first due reminder is its first group card. If the task is
  created after an earlier reminder but another configured time was still ahead,
  the missed slot is consumed quietly and the later time is used. If it is
  created after all of today's reminder times, exactly the latest one is sent
  once as catch-up. Existing tasks keep the normal three-hour stale-reminder
  suppression after scheduler downtime. Occurrences with no reminder times keep
  the ordinary `Yangi vazifa` card.
- **An edit that does not mention a field leaves it alone**, which is what lets
  the Mini App's small sheet be safe: editing a title or a reminder there keeps
  the cadence, the start date, the end date, the due time and the photo rule.
  `reminderTimes` is therefore always sent explicitly, empty included — an
  absent list would make reminders impossible to switch off.
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
the request id so the entry can be retried without duplicating. For a multi-line
Omad entry, that request id is also bound to the original **line count**; reusing
it with a larger or smaller cart is refused rather than silently changing a
financial request after an uncertain response. Counted per-line ids let a
partial frontend/backend rollout resume only the missing lines safely.

## 7. Data other features depend on

**`System_Config`** is a key/value sheet (column A key, column B a JSON string):
`Omad_Tenants`, `Omad_Rates`, `Omad_Rates_V1_Backup`, `Omad_Template_Expenses`,
`Omad_Active_Transactions_Sheet`, `Omad_Migration_Status`,
`Omad_Migration_Fallback_Year`, `Omad_Read_Model`, `Cafe_Inventory`,
`Cafe_Inventory_Rev`, `Cafe_Recipes`, `Cafe_Categories`, `Cafe_Catalogue_Rev`,
`Cafe_Settings`.

`Omad_Read_Model` is the one **derived** entry: it is a summary of the ledger,
not a fact about it, and `CACHE_DERIVED_CONFIG_KEYS` keeps writing it from
bumping the revision it is keyed by. Deleting the row costs one rebuild.

**`Omad_Transactions_V2`** — the live append-only ledger (schema version 2, 24
columns): `ID, Request_ID, Created_At, Updated_At, Created_By, Source, Period,
Tenant, Type, Amount, Currency, Rate_Buy, Rate_Sell, Rate_Used, Rate_Type,
Amount_UZS, Method, Comment, Status, Related_ID, Telegram_Msg_ID,
Schema_Version, Entry_Group_ID, Entry_Kind`.

**`Omad_Transactions`** — the legacy 13-column sheet, kept intact so
`rollback_omad_migration` stays one action. Still the write path if a rollback
happens.

Other sheets: `Omad_Backups`, `Omad_Transaction_Archive`, `Omad_Audit_Log`,
`Telegram_Debug_Log`, `Cafe_Sales`, `Cafe_Kun_Yakuni`, `Cafe_Stock_Movements`,
`Tasks`, `Task_Occurrences`, `Omad_Job_Queue`.

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
`OMAD_ADMIN_KEY`*, `OMAD_USERS`*, `OMAD_SESSION_SECRET`*,
`OMAD_REV_OMAD` / `OMAD_REV_CAFE` / `OMAD_REV_TASKS` (cache revision counters,
not secrets), `TELEGRAM_WEBHOOK_SECRET`*, `TELEGRAM_WEBHOOK_SECRET_PREVIOUS`* (transient
during rotation), `TELEGRAM_WEBHOOK_ROTATED_AT`, `TELEGRAM_AUTHORIZED_USER_ID`,
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

**Netlify is not one of them.** The repository carries no Netlify
configuration and `tests/static-analysis.test.js` keeps it that way. The old
`omad-d` project is still linked to this repository on GitHub's side and still
posts three neutral preview checks per pull request; they mean nothing about
this application. Removing it is a browser step — `docs/DEPLOYMENT.md` names
exactly which.

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
- **Fast saving:** a write returns as soon as the record is stored. Web
  accounting writes send `deferReports: true`, so Telegram never runs before
  the browser receives confirmation; the dashboard refresh then happens in the
  background. Other callers may drain at most **one** queued job inline
  (`JOB_QUEUE_INLINE_BATCH = 1`), and the time-driven trigger is the durable
  sender. **Failing to *queue* a report never fails a save that already
  succeeded** — the enqueue is wrapped and logged.
- **Task mutations defer their settling the same way.** A `deferReports: true`
  task action does the durable write and the occurrence reconciliation it owns,
  answers with the board view, and runs **neither** the schedule scan nor the
  Telegram drain inside that response. The client then calls `settle_tasks`
  (`mini_settle_tasks` from the Mini App) **without awaiting it**, which runs one
  trigger cycle — scan, then drain — so a card still appears in seconds. Losing
  that request costs a delay and never a card: the five-minute trigger runs the
  same cycle. A client that sends nothing keeps the old inline behaviour exactly,
  which is what makes a partial frontend/backend rollout safe.
- **A café stock movement is complete when the backend confirms it.** The answer
  carries the authoritative inventory and the screen applies it immediately; the
  movement list and the low-stock card are a **background, coalesced** refresh
  rather than something the person recording a delivery waits through.
- The Mini App calls `mini_flush_reports` after a write **without awaiting it**,
  so the group card appears in seconds instead of at the next tick. Losing that
  request costs a delay, never a report.
- The task scheduler materialises occurrences for today + a 14-day horizon,
  idempotent on `(taskId, dateKey)` / `(taskId, stepIndex)`, and marks each
  reminder slot **at enqueue time**. Reminder-configured occurrences stay silent
  until a reminder is due; the first successful reminder becomes the editable
  group card. Existing tasks suppress reminders missed by more than 3 hours
  after downtime. A newly created task never blasts slots that were already in
  the past at creation: it waits for the next configured time, or sends only the
  latest once when every time for today was already past.
- **`System_Config` reads are memoised for one request** (`getConfigOnce_`).
  `resetRequestMemos_()` runs at the top of `doPost` and `doGet`, and `setConfig`
  drops the entry it overwrites so a read-after-write in the same request sees
  the new value. The memo caches the **read**, never the decision made from it.
- **Read-only display summaries are cached across requests** (`01c_cache.gs`),
  and nothing else is. Two properties make that safe:
  - **A revision counter per scope** (`OMAD`, `CAFE`, `TASKS`) is part of every
    cache key, and every write bumps it — `setConfig` for anything named
    `Omad_*`/`Cafe_*`, the ledger and legacy transaction writers, the café sales
    and close-day writers, and the task store writers. A write does not expire
    the old entry; it makes it **unreachable**. The TTL (60s for accounting,
    120s for the café, 90s for a task view whose key also carries the minute) is
    the backstop for a write path that forgets to bump.
  - **Only summaries.** Pricing, stock checks, the ledger read, task mutations
    and every write path read the sheets directly. A poisoned or missing cache
    can make a screen a minute out of date; it cannot make a sale, a balance or
    an occurrence wrong, and `tests/summary-cache.test.js` asserts exactly that
    by emptying and then poisoning the cache.
  Cached today: the Mini App Omad tab and café tab, the café POS payload, the
  café dashboard summary, and the task board view.
- **The Omad read model is a materialised summary that outlives the cache**
  (`01d_read_model.gs`). It lives in `System_Config` under `Omad_Read_Model` and
  holds, for the whole ledger: the all-time cash/bank/total balances, and per
  period the income, the expense, the net and what each tenant paid — plus the
  newest 30 business actions. The dashboard, `get_omad_dashboard`'s payload and
  the Mini App's Omad tab are all answered from it, so **between two ledger
  writes neither screen touches the ledger sheet at all**.
  - **It is not a second truth.** Every figure in it is produced by
    `calculateActuals_` and `tenantPaidTotals_` over the rows
    `readOmadTransactions_` returns. There is no second implementation of any
    monetary rule.
  - **It is keyed by the accounting revision and the active sheet name.** A
    create, a correction and a cancellation all bump the revision, which makes
    the stored model unusable rather than merely old. Writing the model
    deliberately does *not* bump it — `CACHE_DERIVED_CONFIG_KEYS` in
    `01c_cache.gs` is what stops the summary invalidating itself for ever.
  - **Every failure ends at the ledger.** Missing, unparsable, wrong version,
    wrong sheet, or unstorable — all of them compute the answer from the ledger,
    which is the behaviour that existed before it.
  - `verify_omad_read_model` rebuilds it from scratch and reports every field
    that disagrees; `rebuild_omad_read_model` stores a fresh one. Both are
    `omad_admin` only.
  - An *older* period's recent list is the one thing the stored window cannot
    always answer, and it falls back to a ledger pass rather than answering
    short.

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
| a new gated action | give it a role list from `AUTH_ROLES_*` in `20_api.gs`; there is no default |
| a new sheet write path | bump the matching `CACHE_SCOPE_*` revision, or a summary goes stale for its TTL |
| a ledger write path | the Omad read model is keyed by `CACHE_SCOPE_OMAD`; bumping it is what makes the dashboard see the write |
| a recipe / category / café setting write | bump `Cafe_Catalogue_Rev` via `bumpCafeCatalogueRev_`, or two stale sessions overwrite each other |
| a café stock write outside a sale | it must go through `adjust_cafe_stock`, or the movement history stops explaining the quantity |
| a Tailwind class on any page | run `npm run build:css` and commit `assets/css/app.css` |
| anything a web page loads | it must come after `assets/session.js`, which owns the session and the transport |

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
12. **A failed read never destroys what is on screen.** A network fault, a rate
    limit, a server error and an unparsable answer all keep the session and keep
    the data, say what went wrong in Uzbek, and offer Retry. Only
    `authExpired: true` — the server saying the session is over — returns anyone
    to the login page. The café till once cleared its stored key and reset its
    stock, categories and daily target on a *throttled* read, mid-shift.
    **A snapshot is readable, never writable.** Until a live read has succeeded
    in this session, every write is refused in the browser and the banner says
    so: `save_omad` submits the whole tenant list, rate table and expense
    templates (and the whole ledger before cutover), the café catalogue saves
    recipes, categories and settings as whole arrays with no version check, and
    close-day writes a counted inventory back wholesale. Any of those from a
    day-old copy overwrites everything changed since. Reads stay open, so Retry
    can recover.
13. **The cache never answers an authoritative question.** Prices, stock checks,
    the ledger, task state and every write path read the sheets. If deleting
    every cache entry would change an answer, that answer must not be cached.
14. **The read model is a copy of an answer, never the answer.** It is built by
    the same functions the full-ledger path uses, keyed by the accounting
    revision, and every failure mode ends in "compute it from the ledger".
    No write, price or decision may read from it. `verify_omad_read_model`
    exists so the claim is checkable against live data, not only in tests.
15. **A café recipe is retired, not deleted, and its cost is derived, not sent.**
    Sales reference recipes by id and their receipts have to keep reading, so an
    edit keeps the id and "delete" means `active: false`. The cost is
    recomputed from the inventory on every save, for the same reason the server
    prices a sale: the browser does not get to decide what something costs us.
16. **A blocking loader is a statement that the whole screen must wait.** Initial
    loads, migrations, cutover, backups, maintenance and the whole-list
    `save_omad` keep one. An ordinary save does not: the form disables its own
    button and relabels it, and the board or dashboard behind it stays readable.
    The rule this replaced an overlay with is that **wherever the overlay was the
    only thing preventing a second submission, an explicit in-flight guard takes
    its place** — `taskMutationInFlight` on the task board, `selling` in the POS,
    `cancellingEntry` for a group cancellation. Never fewer guards, only visible
    ones.

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
- **`cafe_admin.html` recipes, categories and settings still save wholesale**,
  but no longer unguarded: each quotes `Cafe_Catalogue_Rev` and a mismatch is
  refused. The guard is opt-in, so a client old enough not to send the
  revision can still overwrite — it could not quote a counter it has never
  heard of, and refusing it would break saving without protecting anything.
- **The Mini App paints a snapshot, under three conditions.** It shows the
  last answer the backend *verified* on this device, keyed by the Telegram id
  in that verified answer (never `initDataUnsafe`), discarded after a day, and
  labelled as stored for as long as it is on screen. A refused signature
  deletes it. Nothing is ever submitted from it, and the live answer replaces
  every field. Before this it rendered nothing until the round trip returned,
  which was a blank screen on every open.
- **`assets/css/app.css` is generated but not verified in CI.** `npm run
  build:css` regenerates it from the pages; CI does not run it, because making
  the deploy depend on a CSS toolchain is a worse failure mode than the one it
  would catch. A page that adds a class nobody regenerates for loses that one
  piece of styling — visible, and not a correctness problem.
- **`omad_admin.html` and `tasks.html` still load Font Awesome from a CDN** for
  their icons. It is a stylesheet plus a webfont rather than an in-browser
  compiler, so it is a much smaller cost than the Tailwind Play CDN was;
  self-hosting it means committing font binaries and was left out of scope.
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
npm run build:css        # regenerate assets/css/app.css (needs tailwindcss)
npm run lint             # static analysis: syntax, duplicates, deploy gating
npm test                 # unit/integration tests (node --test)
npm run test:e2e         # Playwright/Chromium browser flows
npm run scan:secrets     # working tree
npm run scan:secrets:history   # every committed blob
npm run bench            # sheet passes / bytes / ms per screen (see below)
```

- `npm run bench [rows]` opens each screen against a synthetic ledger and
  prints, per request, the number of whole-sheet passes, the payload size and
  the arithmetic time. Sheet passes are the figure that matters: each one is a
  round trip to the Sheets backend and dominates everything measured in
  milliseconds. It is a comparison tool, not an absolute one.
- `tests/gas-harness.js` loads `script.gs` into a Node VM with `SpreadsheetApp`,
  `PropertiesService`, `CacheService`, `LockService`, `UrlFetchApp`,
  `Utilities`, `Session`, `ContentService` and `HtmlService` mocked, so backend
  logic is testable outside Apps Script. **The harness's fidelity matters** — a
  previously wrong `Utilities.formatDate` mock hid a real class of bug.
- **Dates in tests are the recurring trap.** The harness's `formatDate` mock
  still **ignores its timezone argument** and formats with the host's local
  getters, though `Session.getScriptTimeZone()` reports `Asia/Tashkent`. So a
  date built from the host clock does not mean to the code what it means to
  the test. Build task date keys with the engine's own helpers
  (`taskDateKeyAddDays_`) or in fixed UTC+5 — never from `new Date()` local
  getters. A test that does is not stable; one here passed only between 19:00
  and midnight UTC, and the café tab's assertions still fail on a host behind
  UTC for this reason.
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

Operational state snapshot, rechecked read-only on **2026-08-17**:

| | |
|---|---|
| Active transaction sheet | **`Omad_Transactions_V2`** — the append-only ledger, cut over 2026-08-12 |
| Migration state | `cutover` (fallback year `2026`) |
| Legacy sheet | `Omad_Transactions`, intact, 226 rows |
| Frontend | Cloudflare Pages, auto-deploying `main` |
| Anonymous access | closed — `doGet` reads nothing |
| Telegram | webhook on the active deployment with a URL secret; one 5-minute trigger |
| Mini App | menu button installed and verified |
| Web sign-in | username + password, server-verified, 30-day signed session |

Account records and the session-signing secret are live Script Properties, not
repository state, so this document does not claim whether a one-time password
setup is pending. Sozlamalar → 🗄️ Tizim → Foydalanuvchilar is the operator
surface for account setup/rotation. A code deployment never rewrites
`OMAD_USERS` or `OMAD_SESSION_SECRET`.

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
