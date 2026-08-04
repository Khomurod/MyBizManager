# Staged migration plan

The full request spans a large refactor of the Omad accounting model. It is
split into independently reviewable stages so each one can be tested and
rolled back on its own. **Stage 1 is delivered; stages 2–10 are not started.**

| # | Stage | Status |
|---|---|---|
| 1 | Telegram credentials, authorization, tests & CI foundation | ✅ delivered |
| 2 | Code organization (module split, café duplicate removal) | ⬜ not started |
| 3 | Year-month data model (`2026-01`) + friendly Uzbek labels | ⬜ not started |
| 4 | Append-only transaction system (individual create/correct/cancel) | ⬜ not started |
| 5 | Retry queue and fast saving | ⬜ not started |
| 6 | Historical exchange rates stored per transaction; `sell` used consistently | ⬜ not started |
| 7 | Settings redesign (Sozlamalar sections A–E) | ⬜ partial (D: Telegram done) |
| 8 | Tenant rent schedules, exceptions, start/end periods | ⬜ not started |
| 9 | Planned expenses with recurrence and ending rules | ⬜ not started |
| 10 | Data migration and final cleanup | ⬜ not started |

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

1. **Preview.** A `preview_migration` action returns the proposed
   `month → year-month` mapping and row counts, writing nothing.
2. **Confirm the migration year.** Month-only rows carry no year. The
   operator selects the year explicitly; the preview shows how many rows
   each year would receive.
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

### Rollback for stage 1 (this change)

Stage 1 changed no stored business data. To roll back:

1. `git revert` the commit.
2. Set `BOT_TOKEN` back in whatever form the old code expected — **but note
   the old token is revoked**, so a new token must be configured either way.
3. Script Properties added by this stage are inert if unused; delete them
   with Apps Script → Project Settings → Script Properties if desired.

No migration was performed and no sheet was rewritten by stage 1.
