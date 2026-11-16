# Deployment

**GitHub `main` is the source of truth.** Merging to `main` updates the live
Apps Script project and the Supabase Edge function automatically, once every
CI check has passed, and Cloudflare Pages publishes the frontend from the same
branch. Nobody pastes `script.gs` into the editor any more.

For what the application *is* and the rules it must not break, read
[APP_BRIEF.md](APP_BRIEF.md). This page is the deployment detail behind it.

---

## Where everything lives

| Piece | Value |
|---|---|
| Frontend | <https://mybizmanager.pages.dev> — Cloudflare Pages project `mybizmanager`, connected to `Khomurod/MyBizManager`, production branch `main`, automatic deployments, **no build step** |
| Backend | Google Apps Script project **LIVE**, deployed by CI on every merge to `main` |
| Script ID | `1afG6M-…9fgsWcpG` — the full value exists only in the `CLASP_JSON` secret |
| Active deployment | id begins `AKfycbzhKyEOG…`, ends `…DtCA2W` — **never recreated** |
| Executes as | the owner; access: Anyone |
| Database | Google Sheet `1Q9_v2PrusZimoAjqbOUmHkW_NzDiV0z_8Wtr-v963CA` while `OMAD_STORAGE` is `sheets` |
| Database (after the move) | Supabase project `mybizmanager`, ref `ksdqoftlxrkpyylbbyoi`, us-east-1, organisation "Khomurod's Org", free plan. Schema: `supabase/migrations/` |
| Edge function | `api` in the same project: `https://ksdqoftlxrkpyylbbyoi.supabase.co/functions/v1/api?forceFunctionRegion=us-east-1`, deployed by CI on every merge to `main`. Answers itself only what `app_properties` allows and forwards the rest to Apps Script — see [The Edge function](#the-edge-function) |
| Test project | Supabase project `mybizmanager-staging`, ref `uzpfgnjxvmrzwvocuiaf`, us-east-1, same organisation, free plan. Synthetic data only; the Edge function is deployed there on request |
| Timed jobs | the Apps Script trigger `processPendingTelegramJobs`, every 5 minutes, until the jobs are switched to the Edge function; then `pg_cron` in the database (`mbm-telegram-jobs`) |
| Daily copy of the database | the script owner's Google Drive: spreadsheets "MyBizManager zaxira — kun …" (one per weekday) and "— oy MM" (one per month), written at 03:00 Tashkent (`pg_cron` job `mbm-db-backup`) |
| Bot / Mini App | Telegram `@mybizmanagerbot` |

The Script ID is masked here because clasp guidance keeps `.clasp.json` out of
version control. It was committed in full before that change, so it is still
recoverable from git history — treat it as known, not as rotated.

Cloudflare Pages serves `mini.html` and `tasks.html` at the clean `/mini` and
`/tasks` paths with no configuration, which is why the repository carries no
rewrite file. To roll the frontend back, pick an earlier deployment in the
Cloudflare dashboard — every one is kept.

### Netlify is not part of this project

There is **no Netlify configuration in this repository** — no `netlify.toml`, no
`_redirects`, no `_headers`, and nothing in the workflow that mentions it.
`tests/static-analysis.test.js` asserts that, so a build file cannot reappear
without somebody deciding to add one.

The old Netlify project is called **`omad-d`**. `omad-d.netlify.app` is *not*
production: it serves a build from before the login page was rewritten and can
no longer sign in. Nothing in the application, the deploy or the Telegram
configuration points at it.

**One manual step remains, and it can only be done in a browser.** The Netlify
GitHub App is still linked to this repository, so every pull request still gets
three neutral checks — *Redirect rules – omad-d*, *Header rules – omad-d*,
*Pages changed – omad-d* — linking to `app.netlify.com/projects/omad-d`. They
are noise: a green Netlify check says nothing about this application, and a red
one says nothing either.

To stop them, do **one** of these (the first is the cleanest):

1. **Delete the project.** Netlify → *Projects* → **omad-d** → *Project
   configuration* → *General* → *Danger zone* → **Delete project**. The
   `omad-d.netlify.app` hostname stops resolving; nothing here uses it.
2. **Unlink the repository only.** Netlify → **omad-d** → *Project
   configuration* → *Build & deploy* → *Continuous deployment* → **Unlink
   repository**. The project survives as a dead site but stops watching GitHub.
3. **Remove this repository from the Netlify GitHub App.** GitHub → *Settings*
   → *Applications* → *Installed GitHub Apps* → **Netlify** → *Configure* →
   under *Repository access*, uncheck `Khomurod/MyBizManager`.

Do **not** uninstall the Netlify GitHub App outright — the installation is
account-wide and other repositories may be using it.

---

## What happens on a merge

```
push to main
   └── CI: build/bundle check · static analysis · secret scans (tree + history)
       ·   unit tests · browser tests            ← all must be green
           └── deploy job
                 1. validate configuration          fail closed if incomplete
                 2. clasp pull                      fetch the LIVE manifest
                 3. stage                           live manifest + apps-script/*.gs
                 4. clasp show-file-status          preflight: what will upload
                 5. clasp push -f                   replace the project's code
                 6. clasp create-version            immutable version for this SHA
                 7. clasp update-deployment         move the EXISTING deployment
           └── edge-production job                  (alongside, same gate)
                 1. npm run build                   script.gs → runtime.js
                 2. supabase functions deploy api   to ksdqoftlxrkpyylbbyoi
                 3. probe                           GET ?probe=1 answers from the
                                                    Edge runtime; CORS preflight ok
```

The deploy job is `.github/workflows/ci.yml → deploy`, and the orchestration is
`scripts/clasp-deploy.js`. The Edge function's job is `edge-production`, run
by `scripts/edge-deploy.js` (Supabase CLI pinned, `--no-verify-jwt`). Deploying
the function flips no switch: what it answers itself is decided by rows in
`app_properties`, which only an operator changes.

A branch deploys the function to the **test project** only when asked: a
commit whose message contains `[edge-staging]`, or **Run workflow** on that
branch (`edge-staging` job). It never runs from `main`. After the deploy,
`scripts/edge-staging.js` (test project only, its ref is fixed in the script):

1. applies every migration the test project has not recorded, by name, each
   with its record in one transaction (through the Management API, with the
   same access token);
2. if the project is empty, inserts the synthetic data set of
   `scripts/staging-seed.js` — invented tenants and amounts, built by the
   real import code, so the rows have the live tables' exact shape;
3. sets the switches so the function answers everything itself (there is no
   Apps Script behind the test project), a fresh admin key for the run, and
   the cron and webhook secrets once — all masked in the log;
4. exercises it: dashboard and ledger reads, the tasks and café reads, a
   write and the same write again (stored once, no lease left held), an
   account, sign-in and a refused wrong password, a Telegram update, the
   timed jobs and a refused wrong cron secret, `get_health` answered
   `unconfigured`, both `pg_cron` jobs present. Each call's time goes to the
   run's summary page.

The live project's migrations are never applied this way: they stay a
deliberate step of [Switching production over](#switching-production-over).

### What it never does

- **Never creates an Apps Script project.** It pushes into the existing one.
- **Never creates a deployment.** It calls `update-deployment` against the id
  already serving production, so the `/exec` URL is unchanged — which is what
  keeps the Telegram webhook, the five frontend hardcodes and every bookmark
  working. (`New deployment` mints a URL nothing calls; see
  [Never "New deployment"](#never-new-deployment).)
- **Never touches Script Properties.** `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_AUTHORIZED_USER_ID`,
  `TELEGRAM_GROUP_CHAT_ID`, `TELEGRAM_TASKS_GROUP_CHAT_ID`, `OMAD_ADMIN_KEY`,
  `OMAD_USERS`, `OMAD_SESSION_SECRET` and everything else are project state,
  not code. **A deploy therefore never signs anybody out** — the session secret
  and the password hashes outlive it. Updating the code inside the
  same project leaves them exactly where they are.
- **Never re-registers the webhook**, recreates the spreadsheet, or deletes the
  `processPendingTelegramJobs` trigger.
- **Never writes to the database.** Neither job applies a migration or
  changes a row; the Edge function's switches stay as the operator left them.
- **Never runs from a pull request or a feature branch.** The job accepts only
  a push or a manual dispatch, and only on `github.ref == 'refs/heads/main'`.
  `tests/static-analysis.test.js` fails the build if those conditions are ever
  weakened.

### Deploying on demand

The workflow accepts **Run workflow** (Actions → CI → Run workflow) on `main`.
Use it to deploy a commit that is already merged, or to retry after correcting
a secret, instead of pushing an empty commit. Dispatching from any other branch
runs the tests but not the deploy.

---

## One-time operator setup

Four **secrets**, and nothing else
(Settings → Secrets and variables → Actions → the *Secrets* tab) — three for
Apps Script, one for the Edge function:

| Secret | What to put in it |
|---|---|
| `CLASPRC_JSON` | The entire contents of `~/.clasprc.json` after running `clasp login` as the account that owns the script. Contains an OAuth refresh token. |
| `CLASP_JSON` | `{"scriptId":"<the existing project's script id>"}` — the `.clasp.json` of the live project. |
| `APPS_SCRIPT_DEPLOYMENT_ID` | The id of the deployment already serving production (the one ending `…DtCA2W`). |
| `SUPABASE_ACCESS_TOKEN` | A Supabase personal access token (supabase.com → Account → Access Tokens) of an account in the organisation that owns both projects. It deploys functions; it is not a database key. Set 2026-11-16. |

There is **no enable switch**. With the secrets in place a push to `main`
deploys; without them the job fails and names what is missing.

> ### Secrets and variables are different tabs, and the difference bites
>
> The workflow reads these four through `${{ secrets.* }}`, so they must be on
> the **Secrets** tab. It reads `APPS_SCRIPT_ALLOW_REMOTE_DRIFT` (optional,
> below) through `${{ vars.* }}`, so that one must be on the **Variables** tab.
> A value on the wrong tab is not an error — it is simply invisible, and the
> workflow behaves as though you never set it.
>
> Variables must also be at **repository** scope. GitHub resolves a job's
> `environment:` only after the job starts, so an environment-scoped variable
> cannot be read by anything evaluated before that. Secrets are fine at either
> scope, because they are read inside the running job.
>
> An earlier version of this workflow gated the whole deploy job on a
> `vars.APPS_SCRIPT_DEPLOY_ENABLED` variable. It was set as a *secret*, so the
> job skipped — green, silent, and for ever. The gate is gone; if you still
> have that secret, delete it, nothing reads it.

### Minting `CLASPRC_JSON`

```bash
npm install --no-save @google/clasp@3.3.0
npx clasp login                 # opens a browser; sign in as the script owner
cat ~/.clasprc.json             # copy the whole file into the secret, verbatim
```

The Apps Script API must be on for that account, once:
<https://script.google.com/home/usersettings>.

### Finding the script and deployment ids

```bash
npx clasp clone-script <scriptId>     # or read .clasp.json of an existing clone
npx clasp list-deployments            # ids and their current versions
```

The live deployment is the one whose id ends `…DtCA2W` — see
[Where everything lives](#where-everything-lives). To confirm which deployment
is actually answering, run **Sozlamalar → Tizim → Tizim Salomatligi**: its
first check compares the deployment serving the request with the one the
Telegram webhook points at.

### Why these are secrets

Official clasp guidance treats `.clasprc.json` and `.clasp.json` as files to
keep out of version control: the first holds a refresh token that grants access
to the account's Apps Script projects, the second names the project. Neither is
committed here — `.gitignore` excludes them and
`tests/static-analysis.test.js` fails if one is ever tracked.

---

## What gets uploaded

`apps-script/*.gs` and nothing else, plus the manifest the live project already
has. The staging directory is built fresh on every run and is the only thing
clasp can see, so frontend HTML, `assets/`, `tests/`, `docs/`, `script.gs`,
`.git` and `node_modules` cannot reach Apps Script. `clasp
show-file-status` prints the exact list before the push:

```
Tracked files:
└─ 01_shared_utils.gs
   … 23 modules …
└─ appsscript.json
Untracked files:
└─ .clasp.json
└─ .claspignore
```

### `script.gs` is still built and still committed

`npm run build` regenerates it and `npm run build:check` fails CI if it is
stale. It is now a **fallback and a review aid** — one file to read a diff in,
and something to paste by hand if Actions is unavailable — not the production
path. The modules under `apps-script/` are what ships.

### The manifest is never invented

`appsscript.json` carries the web-app access level, `executeAs`, the timezone
and the OAuth scopes. Getting it wrong would change how the live web app runs.
So the repository deliberately contains no manifest: the deploy pulls the
running project's own and copies it back byte for byte. If the pull returns no
manifest, the deploy fails rather than guessing.

---

## Two guards worth understanding

`clasp push` **replaces** the project's contents — it does not merge. Anything
live that the push does not carry is deleted. Two checks in
`scripts/clasp-deploy.js` turn that from silent data loss into a failed build.

**Unsupported remote files.** If the live project contains a file this
deployment cannot reproduce — an HTML template, say — the deploy stops:

```
✗ The live project contains files this deployment cannot reproduce: Sidebar.html
```

**Backend drift.** Every top-level function declared in the live project must
exist somewhere in `apps-script/`. A function added by hand in the web IDE and
never brought back into the repository would be deleted by the next push, so
instead:

```
✗ The live project defines 2 function(s) the repository does not: …
  Pushing would delete them. Port them into apps-script/ first, or set the
  repository variable APPS_SCRIPT_ALLOW_REMOTE_DRIFT=true if they are
  genuinely obsolete.
```

Fix it by porting the code into a module and letting CI ship it. The override
variable exists for the case where the remote code really is dead, and should
be removed again afterwards.

---

## The Supabase database

The schema is not deployed by CI. Each file in `supabase/migrations/` is
applied once, through the Supabase migrations API (the dashboard's SQL editor
or the MCP `apply_migration`), with the file named by the version Supabase
records. Never edit an applied file; add a new one, and the matching entry in
`SUPABASE_SHEETS`. The tests build their database from these files, so a
column the code needs and the schema lacks fails CI.

Apply a migration **before** deploying code that needs it. The one exception
is built in: without `20261102160523_batched_writes_and_counts.sql` (the
functions `mbm_apply` and `mbm_counts`) the backend still works, one REST call
per write, just slower and not atomic. It is applied to `mybizmanager`.

The Edge function adds three, applied as the first step of
[switching it on](#switching-production-over):

| Migration | Adds | Before it is applied |
|---|---|---|
| `20261116120000_edge_shared_state.sql` | `app_properties`, `app_lease`, `app_cache`; `mbm_lock` / `mbm_unlock`; the property ops in `mbm_apply` | the settings cannot be moved to the database (the move says which migration is missing); everything else works as before |
| `20261116130000_edge_cron.sql` | `pg_cron`, `pg_net` (in `extensions`); `mbm_call_edge(job)`; the jobs `mbm-telegram-jobs` (every 5 min) and `mbm-db-backup` (22:00 UTC) | no nightly copy; the jobs run on the Apps Script trigger as before |
| `20261116140000_pg_net_schema.sql` | moves `pg_net` out of `public` where the first version of the file above put it (the test project); a no-op anywhere else | — |

They are inert until rows in `app_properties` give them something to do.

### Moving the data from Sheets (once)

1. **Script Properties** (Apps Script → Project Settings): `SUPABASE_URL` =
   `https://ksdqoftlxrkpyylbbyoi.supabase.co`, `SUPABASE_SECRET_KEY` = the
   project's secret key (Supabase → Project Settings → API Keys → Secret
   keys). Never paste the key anywhere else. Leave `OMAD_STORAGE` unset.
2. **Sozlamalar → Tizim → Tizim Salomatligi**: "Ma'lumotlar bazasi" says
   "Google Sheets; Supabase tayyor".
3. **Backups**, as before any live financial change: `create_backup`, and a
   Drive *File → Make a copy* of the spreadsheet.
4. **Supabase card → Tezlikni o'lchash** (optional): the same reads timed on
   both stores from Google's servers. Before the copy the database is empty,
   so the whole-ledger figure means more after a move.
5. **Supabase card → 1. Ko'rib chiqish.** Must say "Ko'chirishga tayyor" with
   a row count per sheet. Nothing is written.
6. At a quiet moment (no entries, no sales), **2. Ko'chirish va o'tish.** While
   it copies, every other request — the app, the Mini App, the bot — is
   answered "Ma'lumotlar Supabase'ga ko'chirilmoqda" (`OMAD_STORAGE` holds a
   `moving:…` marker, which expires by itself after ten minutes). It
   copies, verifies every cell and the money, and switches only if both agree.
   On success the app is on Supabase from the next request.
7. If the copy stops halfway, or verification fails, nothing switched and the spreadsheet is still the
   store. Run `supabase/reset_before_cutover.sql` in the SQL editor and repeat
   from step 5.

### Going back

**Supabase card → Google Sheets'ga Qaytish** (`rollback_supabase_storage`)
sets `OMAD_STORAGE=sheets`. It works even if the database cannot be reached.
Entries made while Supabase was live stay only in Supabase.

---

## The Edge function

How it decides who answers, and how it runs the backend, is in
[ARCHITECTURE.md → The Edge function](ARCHITECTURE.md#the-edge-function).
This is the operator's side.

### Its switches

Rows of `app_properties` in the live project, changed in the Supabase SQL
editor (or through the Supabase connector, with the owner's ok). The function
reads them again every 15 seconds; nothing is redeployed.

| Row | What it does |
|---|---|
| `EDGE_APPS_SCRIPT_URL` | Where the function forwards: the live `/exec` URL, the same one as `GOOGLE_APP_URL` in `assets/omad/00-config.js`. Absent: the function answers `503 unconfigured` and the browser goes straight to Apps Script |
| `__PROPERTIES_READY` | Written by **Sozlamalarni bazaga**, deleted by **Sozlamalarni qaytarish** (Tizim → Supabase card). Absent: the function answers nothing itself |
| `EDGE_NATIVE_ACTIONS` | What it answers itself: a comma list of actions; `*` for every web action, `telegram` for the bot's updates, `jobs` for the timed jobs. Empty or absent: nothing |
| `EDGE_FUNCTION_URL` | Where `pg_cron` calls: the function URL with `?forceFunctionRegion=us-east-1` |
| `EDGE_CRON_SECRET` | What `pg_cron` sends, and what the function and Apps Script check, on the timed calls. Made by the database; never typed, shown or pasted |

A move of the settings in either direction leaves every `EDGE_*` row where it
is.

### Switching production over

Not before the owner has said **ok** to the merge and to the switch, in so
many words. Each step is undone by the matching row of
[Going back](#going-back-from-the-edge-function).

1. **Migrations.** Apply `20261116120000_edge_shared_state.sql`,
   `20261116130000_edge_cron.sql` and `20261116140000_pg_net_schema.sql`, in
   that order, to `mybizmanager`. (The test project took the same three from
   CI; see above.)
2. **The rows.** In the SQL editor; the secret is made by the database and
   never leaves it:
   ```sql
   insert into public.app_properties (key, value) values
     ('EDGE_APPS_SCRIPT_URL', '<the /exec URL from assets/omad/00-config.js>'),
     ('EDGE_FUNCTION_URL', 'https://ksdqoftlxrkpyylbbyoi.supabase.co/functions/v1/api?forceFunctionRegion=us-east-1'),
     ('EDGE_CRON_SECRET', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
   on conflict (key) do update set value = excluded.value, updated_at = now();
   ```
3. **Merge.** CI deploys Apps Script and the function. From the next page
   load each browser calls the function first, which forwards everything to
   Apps Script: the app behaves as before, one hop longer. The nightly copy
   starts that night.
4. **Tizim → Supabase → Sozlamalarni bazaga.** Copies the settings, verifies
   them, switches Apps Script over and writes `__PROPERTIES_READY`. Then
   **Tizim salomatligi**: every row green.
5. **Reads.**
   ```sql
   insert into public.app_properties (key, value) values ('EDGE_NATIVE_ACTIONS',
     'get_omad_data,get_omad_history,list_transactions,get_cafe_data,get_tasks,mini_home,mini_omad,mini_cafe,mini_tasks')
   on conflict (key) do update set value = excluded.value, updated_at = now();
   ```
   Open the dashboard, the Mini App, the café and the tasks. In the browser's
   network panel the answers carry `X-MBM-Runtime: edge`.
6. **Every web action:** `EDGE_NATIVE_ACTIONS` = `*`. Sign-in, entries, café
   sales, task changes.
7. **The bot:** `*,telegram`; then Sozlamalar → Telegram, webhook URL =
   `https://ksdqoftlxrkpyylbbyoi.supabase.co/functions/v1/api?forceFunctionRegion=us-east-1`,
   and register it. The health check then says "Webhook Edge funksiyasiga
   ulangan". (Pointing the webhook at the function while `telegram` is not
   in the list is harmless: the function forwards the update.)
8. **The timed jobs:** `*,telegram,jobs`. Apps Script's trigger stands down
   from its next run ("skipped"); `mbm-telegram-jobs` does the work every
   5 minutes. The health check's trigger row says "Edge funksiyasi bajaradi
   (pg_cron)".
9. **Measure** the screens that were timed before the switch, the same way,
   and keep the figures in the Library.

### Going back from the Edge function

Fastest first. None of them loses an entry: whichever runtime answers, it
writes to the same database.

| What | How | Effect |
|---|---|---|
| One group | remove it from `EDGE_NATIVE_ACTIONS` | within 15 s Apps Script answers it again, through the function |
| Everything | `EDGE_NATIVE_ACTIONS` = `''` | the function forwards every request |
| The bot | register the webhook back to the `/exec` URL | Telegram calls Apps Script directly |
| The timed jobs | remove `jobs` | Apps Script's trigger runs them again from its next run; the cron calls answer "skipped" |
| The settings | Tizim → Supabase → **Sozlamalarni qaytarish** | the marker goes first, so the function stops answering; then the database copy is written back to Script Properties |
| A broken function deploy | revert the commit on `main` | CI deploys the previous code. Meanwhile each browser that cannot get an answer from the function uses Apps Script directly for 5 minutes at a time |
| The function altogether | revert the frontend's use of `assets/backend.js`, or roll Cloudflare back to an earlier deployment | browsers call Apps Script directly again |

### Seeing what the timed calls did

```sql
select jobname, schedule, active from cron.job;
select jobid, status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
select id, status_code, left(content, 200) from net._http_response order by created desc limit 10;
```

### The daily copy, and restoring from it

Supabase's free plan keeps no backup the owner can download, so Apps Script
writes one into the owner's Google Drive every night at 03:00 Tashkent:
`mbm-db-backup` → the function (`?job=db-backup`) → Apps Script
(`run_database_backup` with the cron secret). **Tizim → Zaxira nusxa → Hozir Google
Diskka saqlash** writes one at any time. The health check's "Kunlik zaxira"
row warns after 36 hours without one and turns red after 60, or when the last
one was not written whole.

It works before the settings have moved: Apps Script reads the cron secret
from `app_properties` directly. It needs steps 1–3 above (the migrations, the
rows, the merge).

Each spreadsheet has a **Zaxira** tab (when, and rows per table) and one tab per
business table with the original spreadsheet's name, columns and values. Not
in it: the settings (Apps Script keeps its own copy in Script Properties; the
bot token and password hashes do not belong in a spreadsheet),
`Omad_Backups` and the Telegram debug log.

Restoring has **not been rehearsed** on the live data; rehearse on the test
project before relying on it. The two routes:

- **Back to Sheets.** In the backup file, each table tab → *Copy to* →
  *Existing spreadsheet* → the "Budgeting app" spreadsheet; there, delete the
  old tab and rename the copy to the original name. Then **Tizim → Supabase →
  Google Sheets'ga Qaytish**: the app runs from the restored spreadsheet.
- **Into a new Supabase project.** Create it, apply every migration in order,
  put its URL and secret key into Script Properties (`SUPABASE_URL`,
  `SUPABASE_SECRET_KEY`), and move the restored spreadsheet into it from step
  5 of [Moving the data from Sheets](#moving-the-data-from-sheets-once). The
  live project's tables are never emptied once a cutover has happened
  (`reset_before_cutover.sql` refuses).

## Never "New deployment"

The project has around twenty deployments and **only one is live**. The manual
path is Deploy → **Manage deployments** → the deployment ending `…DtCA2W` →
pencil → Version → **New version** → Deploy.

**Never "New deployment".** It mints a *new URL that nothing calls*, so the code
looks deployed while the app keeps running the old version. This happened
repeatedly and is why production once ran stale code for weeks. The pipeline
uses `clasp update-deployment` against the existing id precisely so it cannot
happen again; the manual path remains only as an Actions-outage fallback.

An **archived** deployment cannot be given a new version — the version selector
is not offered and there is no restore action — but it *keeps serving traffic*.
The previous live deployment (`hmm4`, ending `…Zi1SMkdtw`) is archived and
permanently pinned to old code. Nothing points at it any more; leave it alone.

---

## Rolling back

Versions are immutable and numbered, and each one's description carries the Git
SHA that produced it. To go back:

```bash
npx clasp list-versions                             # find the good one
npx clasp update-deployment -V <n> <deploymentId>   # point production at it
```

Or in the editor: **Deploy → Manage deployments →** the `…DtCA2W` deployment
**→** pencil **→ Version →** pick the older version **→ Deploy**. Still never
*New deployment*.

Then revert the offending commit on `main` so the next deploy does not
reintroduce it.

---

## When something fails

| Symptom | Cause |
|---|---|
| Job skipped entirely | The run is not on `main`, or one of `static` / `unit` / `browser` did not pass. Nothing else can skip it — there is no enable switch. |
| Job stuck on *waiting* | The `production` environment has a required reviewer. Approve it on the run page, or remove the rule. |
| `✗ CLASPRC_JSON is not set` | The secret is missing, empty, or on the *Variables* tab instead of *Secrets*. |
| `✗ … is not valid JSON` | The secret was pasted partially, or wrapped in quotes. |
| `clasp pull` fails to authorise | The refresh token was revoked, or the Apps Script API is off for that account. Re-run `clasp login` and update the secret. |
| Drift or unsupported-file error | Somebody edited the live project by hand; see above. |
| Two merges at once | The second queues behind the first — the `apps-script-production` concurrency group serialises them, and neither is cancelled. |
| `edge deploy: the SUPABASE_ACCESS_TOKEN secret is not set` | The secret is missing or on the *Variables* tab. |
| `edge deploy: supabase functions deploy failed` | The token was revoked or belongs to an account outside the organisation; or the bundle failed — the log above it names the file. |
| `edge deploy: the deployed function does not answer as expected` | It deployed but does not boot or answer from the Edge runtime: Supabase → Edge Functions → `api` → Logs. Browsers fall back to Apps Script meanwhile. |
| Every request goes straight to `script.google.com` | The function answered with a platform error or `unconfigured` (no `EDGE_APPS_SCRIPT_URL`), so each device skips it for 5 minutes. `GET …/functions/v1/api?probe=1` says what it sees. |

The first step of the job prints a present/absent table for all three secrets —
to the log and to the run's summary page — and reports **every** problem at
once rather than one per run, so a misconfiguration takes one round trip to
diagnose rather than three.

Credentials are never printed. Ids appear masked (`1afG6M…9fgsWcpG`), and the
preflight reports that credentials are *present* rather than showing them.

---

## Manual deployment, if ever needed

The old path still works and needs no setup: run `npm run build`, open the
script project, paste `script.gs` over the existing code, then
**Deploy → Manage deployments →** the `…DtCA2W` deployment **→ New version**.
Prefer the pipeline; this is the fallback for an Actions outage.
