# Supabase

The database that replaces the "Budgeting app" Google Sheet. Project
`mybizmanager` (`ksdqoftlxrkpyylbbyoi`, us-east-1).

- `migrations/` — the schema, in the order it was applied. Each file is
  applied once, through the Supabase migrations API; never edit an applied
  file, add a new one. `tests/supabase-mock.js` builds its in-memory database
  from these files, so the tests run against the schema that is live.
  The functions `mbm_apply` (a request's writes as one transaction) and
  `mbm_counts` (every row count in one call) are in
  `20261102160523_batched_writes_and_counts.sql`; callable only with the
  secret key.
- `reset_before_cutover.sql` — empties every table so a failed import can be
  re-run. It refuses to run once a cutover has happened.

How the application uses it, and the move from Sheets, is in
`docs/ARCHITECTURE.md#supabase-storage` and `docs/DEPLOYMENT.md`.
