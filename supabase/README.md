# Supabase

The database that replaces the "Budgeting app" Google Sheet, and the Edge
function that serves the same API next to it. Project `mybizmanager`
(`ksdqoftlxrkpyylbbyoi`, us-east-1); test project `mybizmanager-staging`
(`uzpfgnjxvmrzwvocuiaf`, synthetic data only).

- `migrations/` — the schema, in the order it was applied. Each file is
  applied once, through the Supabase migrations API; never edit an applied
  file, add a new one. `tests/supabase-mock.js` builds its in-memory database
  from these files, so the tests run against the schema that is live.
  The functions `mbm_apply` (a request's writes as one transaction) and
  `mbm_counts` (every row count in one call) are in
  `20261102160523_batched_writes_and_counts.sql`; callable only with the
  secret key. `20261116120000_edge_shared_state.sql` adds the state both
  runtimes share (`app_properties`, `app_lease`, `app_cache`, `mbm_lock`,
  `mbm_unlock`); `20261116130000_edge_cron.sql` the timed calls
  (`pg_cron` + `pg_net`, `mbm_call_edge`); `20261116140000_pg_net_schema.sql`
  moves `pg_net` out of `public` where that file's first version put it;
  `20261116150000_lease_fencing.sql` makes `mbm_lock` wait without holding
  the lease row and adds the `fence` op to `mbm_apply`.
- `functions/api/` — the Edge function. `index.ts` is the entry point;
  `lib/` holds the routing, the replay executor and the Apps Script service
  stand-ins; `runtime.js` is generated from `script.gs` by `npm run build` and
  not committed. CI deploys it (`scripts/edge-deploy.js`).
- `config.toml` — `verify_jwt = false` for `api`: the backend authenticates
  every request itself, and Telegram and the browser send no Supabase JWT.
- `reset_before_cutover.sql` — empties every table so a failed import can be
  re-run. It refuses to run once a cutover has happened.

How the application uses it is in `docs/ARCHITECTURE.md` (Supabase storage,
The Edge function); deploying, switching over and going back are in
`docs/DEPLOYMENT.md`.
