# Migration runbook — running the period migration on the live spreadsheet

This is the step-by-step procedure for the one remaining live action. Everything
in it is implemented and tested.

> **Status as of 2026-08-05: not run. The live app is on the legacy
> `Omad_Transactions` sheet, `Omad_Transactions_V2` does not exist, and the
> migration state is `not_started`.** A migration was attempted earlier and
> rolled back, so treat any earlier "applied" note as out of date. Running this
> runbook is a separate, approved piece of work - see
> [LIVE_STATE.md](LIVE_STATE.md).
>
> Verification now also compares every migrated row field by field, including
> each frozen `Amount_UZS` against the rate recorded on that same row. Do not
> cut over on matching totals alone.

Read the whole page before starting. Every step is reversible until step 8.

---

## 0. Before you begin

You need:

- edit access to the MyBizManager Google Spreadsheet;
- access to the Apps Script project bound to it;
- the `OMAD_ADMIN_KEY` value from Script Properties.

Deploy the current `script.gs` first (**Apps Script → paste `script.gs` → Deploy
→ Manage deployments → edit → New version**). The migration actions do not exist
in older deployments.

---

## 1. Back up

Three independent copies. Do all three — they fail in different ways.

| # | Backup | How | Why |
|---|---|---|---|
| 1 | JSON snapshot | **Sozlamalar → Tizim → Zaxira Nusxa Yaratish** | In-sheet, instant, restores through the app |
| 2 | Full file copy | Drive → **File → Make a copy** → name it `MyBizManager BACKUP <YYYY-MM-DD>` | Survives anything done inside the sheet |
| 3 | Off-Drive export | **File → Download → Microsoft Excel (.xlsx)**, store outside Drive | Survives losing the Drive account |

**Verify backup 1 before continuing:** the Tizim panel must show a fresh
timestamp and a non-zero row count. If it does not, stop.

Tag the repository at the commit you are deploying:

```bash
git tag pre-live-migration
git push origin pre-live-migration
```

---

## 2. Preview

**Sozlamalar → Tizim → 1. Ko'rib chiqish** (the admin key must be filled in on
the Telegram section first).

The preview writes nothing. Read it carefully:

- **Per-year breakdown** — does the spread of years match what you know of the
  business? A year you have never traded in means a date is wrong somewhere.
- **Unresolved rows** — each is listed with its sheet row number. These are rows
  whose year cannot be derived from their own date.
- **Duplicate ids** — must be empty. If not, fix them in the sheet first; the
  migration refuses to run.

## 3. Deal with unresolved rows

Two options, in order of preference:

1. **Fix the dates in the sheet.** Open each listed row number and correct the
   `Date` column. Re-run the preview. This is better because the year then comes
   from the record itself.
2. **Choose a fallback year.** Only if the date genuinely cannot be recovered.
   Pick it in the **Zaxira Yil** selector and re-run the preview — it will show
   how many rows that year would receive.

Do not proceed while the preview says *"Hali ko'chirib bo'lmaydi"*.

---

## 4. Apply

**2. Ko'chirish.**

This writes `Omad_Transactions_V2`. **`Omad_Transactions` is not touched** —
that is what makes the rest of this cheap to undo. Another `Omad_Backups`
snapshot is taken first, and the rate map is converted with the original kept
under `Omad_Rates_V1_Backup`.

If it is interrupted, just run it again: the target sheet is rebuilt from
scratch each time.

## 5. Verify

**3. Tekshirish.** It compares the migrated sheet against the original on:

- row counts
- unique transaction ids
- every period being canonical
- per-period UZS totals
- cash, bank, total, income and expense balances

Anything other than *"Tekshiruv muvaffaqiyatli"* means **stop**. Nothing is live
yet; report the failure list.

## 6. Check the numbers yourself

Open the dashboard and compare against what you knew before:

- total cash and bank balances
- this month's income and expense
- tenant debt for the current period

These should be **identical**, with one expected exception: debt figures now use
the sell rate on both sides of the comparison, so they may differ from the old
mixed buy/sell numbers by the spread. That is the stage 6 fix, not a migration
error.

---

## 7. Cut over

**4. Yoqish.** It refuses unless verification passes. It flips
`Omad_Active_Transactions_Sheet` to `Omad_Transactions_V2`.

From this moment the app reads and writes the append-only ledger, and entry
switches to create/correct/cancel automatically.

## 8. Watch for a day

- Enter one income and one expense from the web
- Enter one transaction through Telegram `/yangi`
- Correct one and cancel one
- Confirm the group reports arrive
- Check **Tizim → Kutilayotgan Vazifalar** is not accumulating failures

## Rolling back

**Orqaga Qaytarish** at any point. It:

- points reads and writes back at `Omad_Transactions`
- restores the pre-migration rate map
- **does not delete anything**

Transactions created *after* cutover live in `Omad_Transactions_V2`. If you roll
back after entering some, copy those rows into `Omad_Transactions` by hand
before rolling back, or they will not appear.

| Failure point | What to do |
|---|---|
| Preview or apply fails | Nothing to undo — the original was never written |
| Verification fails | Delete `Omad_Transactions_V2`, fix the data, start again |
| Wrong numbers after cutover | **Orqaga Qaytarish** |
| Something worse | Restore the `Omad_Backups` snapshot row, then the file copy |

---

## After a successful cutover

Leave things alone for at least a full month-end close.

Then, and only then:

1. Rename `Omad_Transactions` to `Omad_Transactions_V1_ARCHIVE` and protect it
   (right-click the tab → **Protect sheet**) so nothing writes to it by accident.
2. **Do not delete it.** It costs nothing to keep and it is the last line of
   defence.
3. The backward-compatible read path in `readOmadTransactions_` can be removed
   once the archive has been untouched for a quarter — but it is small, tested,
   and harmless, so there is no hurry.

## Setting up the retry trigger

Independently of the migration, add the time-driven trigger so queued Telegram
reports go out even when nobody is using the app:

**Apps Script → Triggers → Add Trigger** → function `processPendingTelegramJobs`,
event source *Time-driven*, *Minutes timer*, *Every 5 minutes*.

This is the only trigger the project needs. The same function also scans the
task schedules and enqueues any due notifications and reminders before draining
the queue, so there is no separate `processTaskSchedules` trigger to add.
