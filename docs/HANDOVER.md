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

### Not verified live, and why

- **The Mini App has never been exercised on a phone.** The bot token lives in
  Script Properties and was not available to these sessions, so signed
  `initData` could not be produced. Everything is covered by integration tests
  that drive the real backend and the real task engine, but somebody with the
  phone should open it and try Omad, Café and Tasks once.

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

Read `docs/LIVE_STATE.md` first — it is kept current and describes what is
actually running, as opposed to what the design documents describe.
