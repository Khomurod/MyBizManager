# Staged migration plan

The full request spans a large refactor of the Omad accounting model. It is
split into independently reviewable stages so each one can be tested and
rolled back on its own.

| # | Stage | Status |
|---|---|---|
| 1 | Telegram credentials, authorization, tests & CI foundation | ✅ delivered |
| 1b | Telegram proxy removal, webhook verification, retry queue, `/yangi` idempotency | ✅ delivered |
| 2 | Code organization (module split, café duplicate removal) | ✅ delivered |
| 3 | Year-month data model (`2026-01`) + friendly Uzbek labels | ✅ delivered (tooling; live run pending) |
| 4 | Append-only transaction system (individual create/correct/cancel) | ✅ delivered |
| 5 | Retry queue and fast saving | ✅ delivered |
| 6 | Historical exchange rates stored per transaction; `sell` used consistently | ✅ delivered |
| 7 | Settings redesign (Sozlamalar sections A–E) | ✅ delivered |
| 8 | Tenant rent schedules, exceptions, start/end periods | ✅ delivered |
| 9 | Planned expenses with recurrence and ending rules | ✅ delivered |
| 10 | Data migration tooling, monetary formatting, cleanup | ✅ delivered (live run pending) |

## Remaining live action

Everything is implemented and tested. **One step has not been performed**,
because it needs access to the live spreadsheet and the Apps Script project:

> Running the period migration against the real `Omad_Transactions` sheet, and
> cutting over to the append-only ledger.

`docs/MIGRATION_RUNBOOK.md` is the step-by-step procedure, including the three
backups to take first and the rollback for every failure point. The tooling is
merged and exercised against representative fixtures and the `diagnostics/`
snapshots; nothing about the live data has been changed or claimed.

Also outstanding, for the same reason:

- deploying the current `script.gs` to the Apps Script project;
- adding the `processPendingTelegramJobs` time-driven trigger;
- setting `OMAD_ADMIN_KEY` and the Telegram credentials;
- rotating the previously exposed bot token via BotFather.

## Backup and rollback

Every stage must follow the same discipline.

### Before any data change

1. **Sheet-level backup.** `backupOmadState_()` already writes a full JSON
   snapshot into `Omad_Backups` before every Omad write. Verify the row
   exists before proceeding.
2. **File-level backup.** `File → Make a copy` of the spreadsheet, named
   `MyBizManager BACKUP <YYYY-MM-DD>`.
3. **Export.** Download the Omad sheets as `.xlsx` and store off-Drive.
4. **Repo snapshot.** Tag the pre-migration commit: `git tag pre-stage-<n>`.

`diagnostics/` in this repo already holds prewrite/postwrite JSON snapshots
from 2026-04-22 and can serve as sample data for migration dry runs.

### Migration procedure (stage 3 and 10)

1. **Preview.** `preview_omad_migration` returns the proposed
   `month → year-month` mapping, a per-year summary, the unresolved rows with
   their sheet row numbers, duplicate ids and the pre-migration totals. It
   writes nothing.
2. **Confirm the fallback year.** Most rows get their year from their own
   saved date. Only rows whose date cannot determine the year need the
   fallback, and the preview says exactly which ones and how many.
3. **Apply.** Write converted rows to a **new** `Omad_Transactions_V2`
   sheet. The original sheet is left untouched — this is what makes
   rollback cheap.
4. **Verify.** Row counts match, per-month UZS totals match the pre-migration
   totals, no duplicate transaction IDs.
5. **Report.** Append a migration report row to `Omad_Audit_Log`.
6. **Cut over.** Only after verification passes, point reads at V2.

### Rollback

| Failure point | Rollback |
|---|---|
| Preview or apply fails | Nothing to undo — the original sheet was never written |
| Verification fails | Point reads back at `Omad_Transactions`; delete V2 |
| Discovered after cutover | Restore from the `Omad_Backups` snapshot row taken immediately before cutover |
| Catastrophic | Restore the file-level spreadsheet copy |

### Rollback for stage 10

Monetary formatting is presentation only — the stored values are unchanged
numbers. `git revert` and redeploy.

The migration tooling itself is covered by `rollback_omad_migration`; see
`docs/MIGRATION_RUNBOOK.md`.

### Rollback for stage 9

Existing template expenses are read unchanged as one-time expenses. New fields
are additive; older code reads `month` and `amount` as before. `git revert`
and redeploy.

### Rollback for stage 8

Existing tenant records are read unchanged — the new fields are additive and
default to "no restriction". A tenant edited under the new UI gains
`startPeriod`, `endPeriod`, `rentChanges`, `exceptions`, `noRentPeriods` and
`active`; older code ignores them and falls back to `rent`, which is kept in
step with `defaultRent`.

To roll back, `git revert` and redeploy. The extra fields stay in
`Omad_Tenants` and are inert.

### Rollback for stage 7

Presentation and read-only diagnostics only; no stored data changes.
`git revert` and redeploy.

### Rollback for stage 6

No stored data changes; the rate columns were added in stage 4. `git revert`
and redeploy.

**Note the behaviour change:** tenant payments and rent expectations now both
use the sell rate. Debt figures will differ from the old mixed buy/sell
numbers by the spread. That is the fix, not a regression — but it is visible,
so mention it to the operator before deploying.

### Rollback for stage 5

No stored data changes. `git revert` the commit and redeploy. The
`Omad_Job_Queue` sheet is inert for older code.

### Rollback for stage 4

The ledger is only live after cutover, so `rollback_omad_migration` is also the
rollback for stage 4: reads and writes go back to the legacy sheet and the app
returns to the whole-list save automatically (it reads
`get_migration_status` on every sync).

Ledger rows are never deleted by a rollback. Any transactions created after
cutover stay in `Omad_Transactions_V2`; if you need them on the legacy sheet,
copy them across before rolling back.

### Rollback for stage 3

Stage 3 changes no stored data on its own. Reads resolve periods in memory and
the app keeps working against an unmigrated sheet.

If the migration has been **applied** but not cut over: nothing to undo — the
original sheet was never written. Delete `Omad_Transactions_V2` if you want.

If it has been **cut over**: run `rollback_omad_migration`. It points
`Omad_Active_Transactions_Sheet` back at `Omad_Transactions` and restores the
pre-migration rate map from `Omad_Rates_V1_Backup`. Migrated data is left in
place.

To roll back the code as well, `git revert` the commit and redeploy.

### Rollback for stage 2

Stage 2 is a pure reorganisation: no stored data, no API surface and no
business behaviour changed. To roll back, `git revert` the commit. The
deployed `script.gs` is byte-for-byte reproducible from `apps-script/` via
`npm run build`, so the Apps Script project only ever needs the bundle.

### Rollback for stage 1b

Stage 1b changed no stored business data. It adds one column
(`Request_ID`) to `Omad_Transactions` and one new sheet (`Omad_Job_Queue`).
To roll back:

1. `git revert` the commit and redeploy the Apps Script project.
2. The extra column and the queue sheet are inert for the old code — delete
   them only if you want a clean sheet.
3. Re-run **Sozlamalar → Telegram → 🔄 Webhook** so the webhook URL loses the
   `?wh=` secret the old code does not expect. (The old code ignores unknown
   query parameters, so this is optional.)

### Rollback for stage 1 (the original change)

Stage 1 changed no stored business data. To roll back:

1. `git revert` the commit.
2. Set `BOT_TOKEN` back in whatever form the old code expected — **but note
   the old token is revoked**, so a new token must be configured either way.
3. Script Properties added by this stage are inert if unused; delete them
   with Apps Script → Project Settings → Script Properties if desired.

No migration was performed and no sheet was rewritten by stage 1.
