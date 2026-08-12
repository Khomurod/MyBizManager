# Handover — 2026-08-12

The state of the system after the Mini App, V2 and café work. Everything below
was verified against the live systems unless it says otherwise.

---

## 1. What this project is

| Piece | Where |
|---|---|
| Frontend | <https://mybizmanager.pages.dev> — Cloudflare Pages, project `mybizmanager`, auto-deploys `main` |
| Backend | Google Apps Script, deployed by CI on every merge to `main` |
| Database | Google Sheet `1Q9_v2PrusZimoAjqbOUmHkW_NzDiV0z_8Wtr-v963CA` |
| Bot / Mini App | Telegram `@mybizmanagerbot` |

Three applications share that backend: **Omad** (rent/accounting), **Café**
(POS + admin) and **Tasks**, plus a Telegram bot and a Telegram Mini App.

`apps-script/*.gs` is the source of truth. `script.gs` is generated — run
`npm run build`, never edit it by hand. `npm run build:check` fails CI if it is
stale.

---

## 2. Where things stand

### Done and merged before this session

- Cloudflare Pages is the production frontend; Netlify is retired.
- The anonymous `get_omad` / `get_cafe` endpoints are gone; everything takes the
  access key. `LEGACY_CLIENT_GRACE` no longer exists.
- Telegram webhook secret cleaned from the debug log and rotated.
- 142 provably transposed historical dates repaired; 4 unprovable left alone.
- `Entry_Group_ID` backfilled across all 226 rows.

### Done in this session

**Stage 1 — Mini App** (merged, PR #27, #28)

Every task mutation from the Mini App was broken by a field-name mismatch that
the mocked tests could not see. Fixed: `taskId` → `id` translation, the
`view.today` / `view.counts` shape, routine `stats` and goal `progress`,
completion attribution to the real Telegram user, photo-required tasks going to
WaitingProof, and future-skip confirmation.

**A routine's recurrence was being silently reset to daily** on any edit that
did not resend it — this affected the web board too. Absent fields now mean
"leave alone"; explicitly empty ones still clear.

Speed: `mini_home` used to build Omad + Café + the whole task view, and the
client then called `mini_omad` anyway. **Four full ledger reads across two round
trips to paint one tab.** Now one read, one round trip; Café and Tasks load when
opened.

**Stage 2 — V2 cutover** (merged, PR #27, #29, #30 — **cutover is LIVE**)

Two bugs found and fixed before it was safe:

1. The migration never read `Entry_Kind`, so every tenant-paid pair would have
   arrived as two unrelated rows. Verification could not see it — it compared
   ten fields, none of them `Entry_Group_ID`, `Entry_Kind` or `Comment`.
2. `appendOmadTransaction_` wrote a 13-column legacy row into whatever sheet was
   active, and called `ensureOmadTransactionHeader_` first — which on the
   24-column ledger would have stamped the legacy header over `Rate_Buy`,
   `Rate_Sell`, `Status` and the rest. **One Telegram `/yangi` entry would have
   structurally destroyed the ledger.** Found by cutting over and checking every
   write path; rolled back within minutes, fixed, then cut over again.

Live result: `Omad_Transactions_V2` is active, 226 rows, identical ids, identical
tenant balances, identical per-period and cash/bank totals. Legacy
`Omad_Transactions` is intact for rollback.

**Stage 3 — Café** (merged, PR #31, #32, #33)

The till used to compute total, cost and profit and send them to be written
down, and depleted stock only in its own memory. The POS now sends *what was
ordered and how many*; the server prices it from the catalogue, validates stock,
moves stock and writes the sale atomically under a lock, keyed by a request id.
Void restores from the stored receipt. Close-day totals from recorded sales and
accepts only a counted stock level.

**Stage 5 — Mini App hardening** (this session)

Six things, each on its own commit.

1. **A Mini App task completion could be filed under someone else's name.** The
   handler read `payload.completedById || auth.userId` and the same for the
   name, the source and the author, so whenever the request carried those
   fields the browser's values won. Attribution is now stripped from the
   payload and rewritten from the verified `initData`. Stripped rather than
   overwritten, so a field added to the engine later cannot become spoofable by
   being forwarded. The /tasks board is untouched — it is admin-key gated and
   picks a completer from a list on purpose.
2. **70 `System_Config` passes to answer one Mini App request** with sixteen
   tenants, all returning the same bytes. Config reads are memoised for the
   duration of one request, and tenant payments are aggregated in one pass over
   the ledger instead of one pass per tenant. Now 4.
3. **The café tab parsed the receipt JSON of every sale ever made** to produce a
   line count for the ten it shows. Lean readers leave each receipt as text;
   only the shown rows are parsed.
4. **A write waited for Telegram.** The group card is queued and delivered by
   `mini_flush_reports`, which the client calls without awaiting. The
   whole-ledger snapshot before each tenant-paid entry is gone under V2 (the
   ledger is append-only, so there is nothing to undo) and now runs after
   validation on the legacy sheet.
5. **A deadline time never appeared on a phone.** The row read `o.dueTime`,
   which no occurrence carries — only a routine's definition does. It reads
   `dueLabel` now, the same field the /tasks board reads.
6. **A description or a responsible could be written but never deleted**, and
   the page forbade pinch-zoom to work around an iOS auto-zoom that 16px form
   controls prevent properly.

Also fixed in the test harness: `Utilities.formatDate` recognised one literal
pattern and returned `dd/MM/yyyy` for everything else, so code asking for
`yyyy-MM-dd` was tested against a string Apps Script cannot return — the café
month key came out as `12/08/2` and every month total was silently a day total.
Production was always correct; the test was not, which is why nothing had
caught it.

---

## 3. Immediate state to check first

```bash
git log --oneline -3 origin/main
```

Everything below was merged and deployed. `main`, Cloudflare and the Apps
Script deployment are all on the same commit; the last deploy job succeeded.

### The drift guard

`scripts/clasp-deploy.js` refuses to deploy when the live Apps Script project
defines a function the repository does not, because `clasp push` replaces rather
than merges. When you delete or rename a function on purpose, add it to
`RETIRED_FUNCTIONS` with a reason, and drop entries once their push has run. A
static-analysis test fails if an entry names a function that still exists. Do
**not** reach for the blanket `APPS_SCRIPT_ALLOW_REMOTE_DRIFT` variable — it
disarms the guard for everything.

This stopped three deploys during this work, every time correctly.

---

## 4. What still needs doing

### Verified live

- Omad on V2: 226 rows, append / correct / cancel, whole-list save inert.
- Café: server pricing (a `price` of 999 999 was written at the catalogue's
  8 000), idempotency, stock refusal, unknown-item refusal, void restoring from
  the stored receipt while ignoring a forged inventory, double-void no-op, and
  the stale-admin-save guard. The café was byte-identical after every test.
- Tasks, Telegram bot, System Health, and that anonymous access is still shut.
- After the Mini App hardening: the Apps Script deploy completed and System
  Health reports the answering deployment is the one the webhook points at;
  Omad still 226 rows, Café still 713, queue empty, ledger still V2. The
  frontend on Cloudflare was fetched and confirmed to carry the new page — the
  viewport meta has neither `maximum-scale` nor `user-scalable`, form controls
  are 16px, and the three changed Mini App scripts are the new ones.
- The Omad optimisation was checked against the **live** ledger rather than a
  fixture: 14 tenants × 7 periods, 98 pairs, the pre-aggregated figure equal to
  the per-tenant one in every case.

### Not verified live, and why

- **The Mini App has never been exercised on a phone.** The bot token lives in
  Script Properties and has not been available to any of these sessions, so
  signed `initData` cannot be produced and no request can get past the gate.
  Everything is covered by integration tests that drive the real backend and
  the real task engine, and by browser tests that render the real page against
  real server responses — but somebody with the phone should open it and try
  Omad, Café and Tasks once. Worth watching for specifically after this
  session's changes: that the Telegram group card still appears a few seconds
  after saving an entry (it is now sent by a follow-up request rather than
  inline), that a task row shows its deadline time, and that clearing a
  description on an edit sticks.

### Known gaps

- **System Health reports one warning:** `Trigger — Ro'yxatni o'qib bo'lmadi`.
  A *reporting* limitation, not a broken scheduler:
  `ScriptApp.getProjectTriggers()` throws because the live manifest's OAuth
  scopes do not include `script.scriptapp`. The trigger demonstrably works — a
  job queued with inline draining disabled was picked up and completed on its
  own. Fixing it means adding a scope to the live manifest, which forces a
  re-authorisation of the deployment; judged not worth the risk unattended.
- **The repository is public** and `diagnostics/*.json` contains committed
  financial dumps (118 transactions with tenant names and amounts). Deleting the
  files does not help — git history keeps them. Making the repo private is the
  real fix and is the owner's call.
- **Test data left behind:** none in Omad or Café — every test record was
  cancelled or voided and the totals verified identical. One cancelled task,
  `CLAUDE TEST — tekshiruv`, remains on the task board as audit history.
- **`Cafe_Inventory_Rev` started at 0** in production, so the very first
  inventory save after deploy was accepted without a version check by design.
  It is 1 now and enforcement is active — verified live.

### Possible next work

- The Telegram task wizard and the report-job queue were not part of this scope
  and were not audited for the same class of bug (field-name drift between a
  client and the engine).
- `cafe_admin.html` recipes, categories and settings still save wholesale with
  no version check. Only inventory was guarded, because only inventory is now
  also written by the server.

## 5. How to work on this safely

1. **Branch.** Develop on `claude/mybizmanager-production-rollout-h49f2p`. Never
   push to `main` directly; open a PR.
2. **Build.** `npm run build` after any `apps-script/*.gs` change, or CI fails on
   `build:check`.
3. **Full local suite** before pushing:
   ```bash
   npm test            # 747 unit/integration
   npm run test:e2e    # 187 browser
   npm run lint
   npm run scan:secrets
   npm run build:check
   ```
   Playwright note: this container's preinstalled Chromium matches
   `playwright@1.56.0`. `npm i --no-save playwright@1.56.0` if the browsers look
   missing. Do not run `playwright install`.
4. **Never weaken a test to make CI green.** Several tests in this session
   asserted an old contract and were *updated to assert the new one* — that is
   different from deleting the assertion.
5. **Live financial changes:** back up first (`create_backup`), snapshot via
   `get_omad_data`, make the change, then diff the snapshot and check tenant
   balances are identical. Reverse test records and never delete audit history.

### Rollback levers

| Situation | Action |
|---|---|
| V2 misbehaving | `rollback_omad_migration` — points reads/writes back at `Omad_Transactions`, which is intact |
| Bad backend deploy | Re-run CI on a known-good commit; the deployment id never changes |
| Bad frontend deploy | Cloudflare Pages keeps every deployment; roll back in the dashboard |

---

## 6. Credentials

The Cloudflare API token and `OMAD_ADMIN_KEY` were supplied by the owner for
this work and **the owner intends to rotate them now that it is finished.**
Assume they are dead. Nothing in the repository contains a
credential — `npm run scan:secrets` is clean, and the deploy reads its Apps
Script credentials from the `CLASP_JSON` GitHub secret.

The Telegram bot token and webhook secret live only in Script Properties.

---

## 7. Useful entry points in the code

| What | Where |
|---|---|
| API routing and auth gates | `apps-script/20_api.gs` |
| Access key check | `apps-script/03_settings.gs` → `checkAdminKey_` |
| Legacy transactions | `apps-script/08_omad_transactions.gs` |
| V2 ledger (append/correct/cancel) | `apps-script/14_ledger.gs` |
| Migration + verification | `apps-script/13_migration.gs` |
| Café (now authoritative) | `apps-script/12_cafe.gs` |
| Task engine | `apps-script/17_tasks_store.gs`, `18_`, `19_` |
| Mini App API | `apps-script/22_miniapp_api.gs` |
| Mini App auth | `apps-script/21_miniapp_auth.gs` |
| Health check | `apps-script/23_health.gs` |

Read **`docs/APP_BRIEF.md`** first — it is the central orientation document for
the whole application. Then `docs/LIVE_STATE.md`, which describes what is
actually running as opposed to what the design documents describe.

> This handover is a **point-in-time** record of the 2026-08-12 session. Its
> branch name and test counts are session-specific; do not treat them as
> standing instructions.
