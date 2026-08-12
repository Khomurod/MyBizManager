# Handover — 2026-08-12

Written at the point work was stopped, for whoever picks this up next.
Everything below was verified against the live systems unless it says otherwise.

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

**Stage 3 — Café** (PR #31, **open, not merged**)

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
gh pr view 31            # or the GitHub UI
```

- **PR #31 is open.** Its last CI run failed on `Browser flows` because the café
  browser tests still asserted the old browser-computed contract. Those tests
  have since been updated (`tests/cafe-regression.e2e.js`,
  `tests/browser-telegram-settings.e2e.js`) and pass locally. **Confirm the
  latest-head CI is green before merging.**
- After merging, **verify the Apps Script deploy job actually succeeded** — do
  not assume. Twice this session it failed on the drift guard.

### The drift guard

`scripts/clasp-deploy.js` refuses to deploy when the live Apps Script project
defines a function the repository does not, because `clasp push` replaces rather
than merges. When you delete a function on purpose, add it to
`RETIRED_FUNCTIONS` with a reason. A static-analysis test fails if an entry names
a function that still exists. Do **not** reach for the blanket
`APPS_SCRIPT_ALLOW_REMOTE_DRIFT` variable — it disarms the guard for everything.

---

## 4. What still needs doing

### Stage 3 remainder

- [ ] Merge PR #31 once CI is green, and confirm the deploy job succeeded.
- [ ] **Live café verification has not been done.** Everything is covered by
      tests (19 unit + browser), but no real sale has been rung up through the
      deployed POS since the change. Do a labelled test sale, check the stock
      moved on the sheet, void it, confirm the stock came back.
- [ ] `cafe_admin.html` was not reviewed. It still writes inventory, recipes and
      prices wholesale via `save_inventory` / `save_recipe`. That is the admin
      screen so it is *meant* to be authoritative, but it has no optimistic-
      concurrency check — two admins editing at once, last write wins.

### Stage 4 — not started

- [ ] Re-audit Mini App performance end to end (the one-read change is in, but
      no timing has been measured against production).
- [ ] Reduce remaining Sheets/config reads on hot paths. `readCafeState_` is
      called more than once in some café flows.
- [ ] Add short-lived caching **only** where it clearly pays, and make financial
      writes invalidate it. Correctness wins over speed.
- [ ] Run the full suite, CI and a production verification pass at the end.

### Known gaps and risks

- **The Mini App has never been exercised live.** The bot token is in Script
  Properties and was not available to this session, so signed `initData` could
  not be produced. All Mini App verification is through integration tests that
  drive the real backend. Someone with the phone should open it and try Omad,
  Café and Tasks.
- **System Health reports one warning:** `Trigger — Ro'yxatni o'qib bo'lmadi`.
  This is a *reporting* limitation, not a broken scheduler:
  `ScriptApp.getProjectTriggers()` throws because the live manifest's OAuth
  scopes do not include `script.scriptapp`. The trigger demonstrably works — a
  job queued with inline draining disabled was picked up and completed on its
  own. Fixing it means adding a scope to the live manifest, which forces a
  re-authorisation of the deployment; that was judged not worth the risk without
  the owner present.
- **The repository is public** and `diagnostics/*.json` contains committed
  financial dumps (118 transactions with tenant names and amounts). Deleting the
  files does not help — git history keeps them. Making the repo private is the
  real fix and is the owner's call.
- **Test data left behind:** none in Omad (every test row was cancelled or
  reversed and balances verified identical). One cancelled task,
  `CLAUDE TEST — tekshiruv`, remains on the task board as audit history.

---

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
this session and **the owner intends to rotate them now that the work has
stopped.** Assume they are dead. Nothing in the repository contains a
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
