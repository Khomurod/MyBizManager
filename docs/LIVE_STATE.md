# Live state

What is actually running, as opposed to what the design documents describe.
Update this file whenever the live system changes.

**Last verified: 2026-08-12** (frontend hosts, Telegram configuration and the
anonymous-endpoint exposure re-checked directly against the live systems).

---

## The short version

| | |
|---|---|
| Active transaction sheet | **`Omad_Transactions_V2`** (the append-only ledger) |
| Is the V2 ledger live? | **Yes**, cut over 2026-08-12 |
| Migration state | `cutover` |
| Fallback year | `2026` |
| Legacy sheet | `Omad_Transactions` — kept intact, 226 rows, so rollback stays one action |

**V2 is live.** Transactions are appended, corrected and cancelled; nothing
rewrites the list. `save_omad` still carries the tenants, rates and template
expenses, and its transaction half is ignored — `saveOmadSettingsOnly_` is what
runs. `rollback_omad_migration` points reads and writes back at the legacy
sheet and is the tested way back.

---

## The frontend is Cloudflare Pages

**Set up and verified 2026-08-12.**

| | |
|---|---|
| Production URL | <https://mybizmanager.pages.dev> |
| Project | `mybizmanager`, Cloudflare Pages (not a Worker) |
| Connected repo | `Khomurod/MyBizManager` |
| Production branch | `main`, automatic deployments enabled |
| Build | none — the repo is already static, served from the root |
| Paid services | none; Pages free tier only |

Pages serves `mini.html` and `tasks.html` at the clean `/mini` and `/tasks`
paths on its own, so the `netlify.toml` rewrites had nothing left to do and the
file is deleted.

Every route was checked — `/`, `/login`, `/omad_admin`, `/cafe_admin`,
`/cafe_pos`, `/tasks`, `/mini` — along with the JS bundles. `06-api.js`,
`01-tasks-api.js` and `06-app.js` as served by Pages are byte-identical to
`main`. A freshly created project returns intermittent 522s at the edge for a
minute or two; they cleared on their own and are not a configuration problem.

### Netlify is retired

`omad-d.netlify.app` still answers, but it serves a build from before the access
key existed and no longer publishes `main` — its free build credits are spent.
Once the key is required everywhere that stale site simply cannot sign in.
**Deleting the Netlify site is a manual step**; nothing here depends on it.

### The compatibility layer is gone

`LEGACY_CLIENT_GRACE`, the second access check it needed, and the anonymous
`get_omad` / `get_cafe` routes are removed. Every business action takes the
access key, and `doGet` reads nothing at all.

The order that was followed, and that must be followed again if this is ever
re-done: the frontend went live and was proven first — signed in, read, wrote
and reversed — and only then was the hole closed. Closing it first takes the
whole application down.

`tests/anonymous-access.test.js` is the regression inventory and the health
check probes `doGet` for both retired routes on every run, so a re-opening is
caught rather than assumed impossible.

## Signing in now needs the access key

**This changes the daily workflow once.** `login.html` asks for a third field,
**Kirish kaliti**, which is the value of `OMAD_ADMIN_KEY` — the same key already
typed into Sozlamalar → Telegram. It is verified against the server before it is
stored, kept in `localStorage`, and sent with every request from then on.

Why: the `/exec` URL is hardcoded in three pages served from a public site, so
anyone who has seen the frontend knows it. Until this change that was enough to
read the whole financial ledger, the tenant list and every café sale with its
margin — and to write all of it.

Practical consequences on the day this deploys:

- every open browser session is signed out once and needs the key entered again
  (`omad_admin`, `cafe_admin` and `cafe_pos` alike);
- if `OMAD_ADMIN_KEY` is not set in Script Properties, **nobody can sign in**.
  It is already set — `get_telegram_settings` reported `adminKeyConfigured:
  true` on 2026-08-12 — but that is the one thing to check first if login fails;
- the username/password on that page are unchanged. They choose which app opens
  and are visible in the page source; they never were a security boundary.

The Telegram bot is unaffected: it is authorized by the webhook secret and
`TELEGRAM_AUTHORIZED_USER_ID`, not by this key.

## The Telegram Mini App

A phone-first app at <https://mybizmanager.pages.dev/mini>, opened from the
bot's menu button. It is reachable **only** by the Telegram user in
`TELEGRAM_AUTHORIZED_USER_ID` — the same setting that already decides who may
run `/yangi`. There is no second user list.

Two things to know:

1. **Setting it up is one button.** Sozlamalar → Tizim → *Mini Appni Sozlash*
   installs the menu button through the Bot API and verifies it. Nothing has to
   be typed into BotFather.
2. **It is configured, as of 2026-08-12.** It never had been before — the
   stored `miniAppUrl` was empty and no menu button had ever been installed,
   so nothing was pointing at Netlify and nothing needed un-pointing. The menu
   button now opens the Cloudflare URL above; Telegram confirmed the button,
   the bot, the authorized user and the webhook all green.

Opened in an ordinary browser it shows one sentence and asks the server for
nothing.

### Who did a task is decided by the signature

A task mutation from the Mini App used to read its own attribution off the
request: `payload.completedById || auth.userId`, and the same for the name, the
source and the author. A request is just JSON, so anyone reaching that endpoint
with a valid signature could file a completion under somebody else's name and
the occurrence row would record it as fact, with nothing to show the value had
been supplied rather than derived. The photo-proof slot was the same — a forged
`proofAwaitingUserId` pointed "the next photo closes this task" at another
account.

Those fields are now stripped from the payload before it reaches the task
engine and rewritten from the verified `initData`. Stripped rather than
overwritten, so an attribution field added to the engine later cannot become
spoofable just by being forwarded.

The /tasks board is deliberately unchanged: it is admin-key gated and picks a
completer from a list on purpose.

### A write returns before the Telegram card is sent

Storing the record and telling Telegram about it are two different jobs, and
only the first one is what the person tapping *Saqlash* is waiting for. The
write returns as soon as the row is stored; the group card is queued, and the
client calls `mini_flush_reports` afterwards **without awaiting it**, so the
card still appears in seconds instead of at the next five-minute trigger tick.

Losing that flush costs a delay and never a report — the job stays queued and
the trigger sends it, which `tests/miniapp-write-path.test.js` asserts.

The whole-ledger snapshot that used to precede every Mini App tenant-paid entry
is gone under V2. It exists to undo a rewrite, and the ledger is append-only —
a correction is another append with its own audit row — so it bought nothing
and grew with the ledger. The legacy sheet, which really is rewritten in place,
still takes one, and now only after the input has been validated: a mistyped
amount used to write a full copy of the ledger and then refuse the entry.

### Mobile behaviour

- Form controls are **16px**. iOS zooms the page in when a focused control's
  text is smaller than that and leaves it zoomed, walking the layout sideways
  in the middle of typing an amount.
- The page no longer carries `maximum-scale=1` or `user-scalable=no`. They were
  there to stop that zoom, but they do it by forbidding zoom outright, which
  takes pinch-to-zoom away from the people who most need it. Fixing the font
  size fixes the cause; both restrictions are gone and the browser tests refuse
  to let them come back.
- A deadline time appears on a task row. It used to read `o.dueTime`, which no
  occurrence carries — only a routine's *definition* does — so it was always
  undefined and a task due at 14:30 looked identical to one due at day's end.
  The row now reads `dueLabel`, the same field the /tasks board reads.
- Clearing a description or a responsible works. The engine resolved
  `payload.description || existing.description`, which cannot tell "did not
  mention it" from "asked for it to be empty", so those fields could be written
  and never deleted.

## The V2 cutover

Done on 2026-08-12, in the order preview → apply → verify → cutover, with the
legacy sheet left untouched throughout.

Two things were found and fixed before it was safe:

1. **The migration never read `Entry_Kind`.** `readRawTransactionRows_` read
   twelve of the legacy sheet's thirteen columns, so every migrated row arrived
   with an empty kind and a tenant-paid pair would have become two unrelated
   rows. Verification could not see it either — it compared ten fields, none of
   which were `Entry_Group_ID`, `Entry_Kind` or `Comment`. It now compares
   those three, checks that every source group arrives as the same set of ids,
   and checks that a tenant-paid pair still nets to zero.
2. **The Telegram `/yangi` entry would have corrupted the ledger.**
   `appendOmadTransaction_` wrote a thirteen-column legacy row into whichever
   sheet was active, and called `ensureOmadTransactionHeader_` first — which on
   a ledger sheet would have stamped the legacy header over `Rate_Buy`,
   `Rate_Sell`, `Status` and the rest. One bot entry was enough. This was found
   by cutting over and checking every write path; the cutover was rolled back
   within minutes, the fix shipped, and the cutover redone.

Verified after the cutover: 226 rows in and 226 out, identical ids, identical
tenant balances, identical per-period totals and cash/bank figures; a
whole-list `save_omad` changes no transaction; append, correct and cancel all
behave; and `Omad_Transactions` still holds its original 226 rows.

## The café is server-priced

The till used to compute the total, the cost and the profit and send them to be
written down, and it depleted stock only in its own memory — so a refresh
restored the stock it had just sold, two devices each tracked a different
inventory, and a stale screen could file any figure.

The POS now sends **what was ordered and how many**. The server reads the
catalogue, prices each line, costs a recipe from its ingredients, refuses a
sale the stock cannot cover, moves the stock and writes the sale — all under
one lock, keyed by a request id so a double tap cannot ring it up twice. A void
restores stock from the receipt that was stored rather than from an inventory
the browser supplies. Close-day totals revenue and profit from the sales
actually recorded and accepts only the counted stock level, which is the one
figure a person has to supply.

Verified live on 2026-08-12 against the deployed backend: a sale carrying a
`price` of 999 999 was written at the catalogue's 8 000; the same request id
twice produced one sale; 500 units of something with 8 in stock was refused by
name; an unknown product was refused; a void carrying a forged inventory of
99 999 restored the receipt's two units and ignored the payload; a second void
was a no-op. The café was byte-identical afterwards — 713 sales, 40 closings,
every quantity unchanged.

Because the till no longer owns stock, the admin screen can no longer overwrite
it blindly: `Cafe_Inventory_Rev` is bumped by every inventory write and quoted
back on every admin save, so a screen that loaded before a sale is refused and
told to reload.

## Reads per request

Every figure here is derived from a full pass over a sheet, so the number of
passes is the response time. What was measured and fixed:

| Path | Before | After |
|---|---|---|
| Mini App first screen | 4 ledger reads over 2 round trips, plus a café read and a full task-view build | **1** ledger read, 1 round trip |
| Transaction report job | 2 ledger reads, plus one more *per row* to stamp the message id | **1** on the ledger (rows write back by position) |
| Café sale | 2 passes over the 700-row sales sheet | **1** |
| Café void | 2 | **1** |
| Migration verification | 2 ledger reads | **1** |
| Mini App first screen, 16 tenants | 70 `System_Config` passes | **4** |
| Mini App café tab | one `JSON.parse` per sale ever made | the 10 rows shown |

`tests/read-efficiency.test.js` counts the passes directly rather than timing
anything, so a regression fails the build instead of just feeling slow.

**Config reads are memoised for one request.** Every `System_Config` lookup is
a full pass over the sheet to pull out one cell, and the hot ones were asked
for over and over while answering a single request: the rate table once per
tenant for the rent and again once per tenant for the payments, the
active-sheet key on every ledger read, the fallback year on every period
resolution.

`getConfigOnce_` memoises the **read**, never the decision made from it, so
callers still re-derive whatever they derive. The memo lasts one request: Apps
Script gives each execution a fresh global scope, every entry point clears it
anyway so the guarantee does not rest on that, and `setConfig` — the only thing
in the codebase that writes `System_Config` — drops the entry it overwrites, so
a handler that changes a value and reads it back within the same request sees
the new one. That last case is the dangerous one and is asserted directly.

Tenant payments are aggregated in one pass over the ledger rather than one pass
per tenant, and a test asserts the aggregate equals the per-tenant figure for
every tenant.

**Still no cross-request cache.** The obvious candidates are all financial
summaries, and every one of them would need invalidating from six different
write paths — the web save, the ledger create/correct/cancel, the tenant-paid
pair, the Mini App and the Telegram bot. A missed hook there is a wrong balance
shown to the owner, which is a worse failure than a slow one. Everything above
is exact and carries no such risk.

## System health

Sozlamalar → Tizim → *Tizim Salomatligi* checks fifteen things in one pass and
reports green / warning / error. Two worth knowing about: it compares the
deployment answering the request with the deployment the webhook points at, so
the "New deployment mints a URL nothing calls" trap described below is detected
rather than discovered weeks later; and it probes `doGet` for the retired
anonymous routes, so it reports what the deployed router actually does rather
than what a flag in the source says.

## Where everything lives

| Piece | Value |
|---|---|
| Frontend | <https://mybizmanager.pages.dev> — Cloudflare Pages project `mybizmanager`, auto-deploys `main` |
| Apps Script project | **LIVE** (renamed from "Untitled project") |
| Script ID | `1afG6M-…9fgsWcpG` — full value only in the `CLASP_JSON` secret |
| Google Sheet | `1Q9_v2PrusZimoAjqbOUmHkW_NzDiV0z_8Wtr-v963CA` ("Budgeting app") |
| Active deployment | id begins `AKfycbzhKyEOG…`, ends `…DtCA2W` |
| Executes as | the owner; access: Anyone |

The backend URL is hardcoded in **three** places, which must always agree:

- `assets/omad/00-config.js`
- `cafe_admin.html`
- `cafe_pos.html`

> The Script ID is masked here because clasp guidance keeps `.clasp.json` out of
> version control and the deployment reads it from an encrypted secret instead.
> It was committed in full before this change, so it is still recoverable from
> git history — treat it as known, not as rotated.

### Deploying Apps Script

**Merging to `main` deploys the backend.** CI builds, lints, scans for secrets
and runs both test suites; if all of that is green, the `deploy` job pushes
`apps-script/*.gs` into this same project, cuts an immutable version tagged
with the commit SHA, and moves the `…DtCA2W` deployment on to it. Nothing is
pasted by hand. Full procedure and the one-time secrets:
[DEPLOYMENT.md](DEPLOYMENT.md).

The deployment id never changes, so the `/exec` URL, the Telegram webhook and
every Script Property stay attached exactly as they are.

To ship a commit that is already on `main` — or to retry after fixing a secret
— use **Actions → CI → Run workflow** on `main` rather than pushing an empty
commit. If the three deployment secrets are missing the job **fails and names
them**; it never skips quietly.

#### The trap this replaced

The project has around twenty deployments and only one is live. The manual
procedure was: Deploy → **Manage deployments** → the deployment ending
`…DtCA2W` → pencil → Version → **New version** → Deploy.

**Never "New deployment".** It mints a *new URL that nothing calls*, so the code
looks deployed while the app keeps running the old version. This happened
repeatedly and is why production ran stale code for weeks. The pipeline uses
`clasp update-deployment` against the existing id precisely so this cannot
happen again; the manual path remains only as an Actions-outage fallback.

An **archived** deployment cannot be given a new version — the version selector
is not offered and there is no restore action — but it *keeps serving traffic*.
The previous live deployment (`hmm4`, ending `…Zi1SMkdtw`) is archived and
permanently pinned to old code; the frontend was repointed away from it.

To confirm which deployment is live, call `?action=get_omad` and check a known
row's `periodSource`, or read the Executions list and look at the version
column.

---

## Telegram

| | |
|---|---|
| Webhook | points at the active deployment, with a verification secret in the URL |
| Trigger | `processPendingTelegramJobs`, time-driven, every 5 minutes — **the only one needed** |
| Bot token | in Script Properties — never in the repo |

That single trigger now performs the whole cycle: it scans the task schedules,
enqueues anything due, then drains the queue. There is no second
`processTaskSchedules` trigger to maintain, and running both entry points
cannot duplicate a message.

Credentials live in Script Properties (`TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_AUTHORIZED_USER_ID`,
`TELEGRAM_GROUP_CHAT_ID`, `OMAD_ADMIN_KEY`) and are set through
**Sozlamalar → Telegram**, not by hand.

Changing the backend URL means re-running the **Webhook** button, or Telegram
keeps delivering to the old deployment.

### Tasks (not yet deployed as of this change)

The task-management feature (`/tasks`, see [TASKS.md](TASKS.md)) is delivered
and tested. The backend ships itself on the next merge to `main`; two operator
steps remain, both about configuration rather than code:

1. set **Vazifalar Guruhi ID** in Sozlamalar → Telegram (Script Property
   `TELEGRAM_TASKS_GROUP_CHAT_ID`) and add the bot to that group. It must be the
   group's **numeric** chat id — an `@username` is refused, because incoming
   callbacks and photos only ever carry `chat.id`;
2. make sure **`OMAD_ADMIN_KEY`** is set in Script Properties — the /tasks page
   now requires it to *read* the board, not only to change it. Without it the
   page shows a key prompt and no data.

**No second trigger is needed.** The existing `processPendingTelegramJobs`
trigger runs the task scheduler before draining the queue.

Until step 1, task messages are simply not sent; the accounting flows are
unaffected either way.

**Reminders.** A one-time task set to remind daily now does exactly that: every
Tashkent day it stays open, whether its deadline is still ahead, is today, or
went past — stopping the moment it is completed, cancelled or skipped. It
previously fired only on the deadline date, because the occurrence's own date
took priority over the daily flag. Tasks left on the deadline-only setting are
unchanged, and no saved data needed migrating.

**Creating tasks from the bot** (the `📋 Vazifa` button on `/yangi`) ships in
the same deployment and needs **no** extra configuration — no new Script
Properties, no webhook change. `TELEGRAM_AUTHORIZED_USER_ID` already decides
who may use it. Once the backend is deployed, the next `/yangi` shows three
buttons instead of two. Without step 2 the task is still created; only the
group card is not sent.

**Dates.** The task sheets now protect their own date, time and timestamp
columns by formatting them as text before writing, exactly as the accounting
sheets do (see *Dates* below). Reads also recover a cell that an older write
already let the spreadsheet coerce, so any rows written before this change heal
themselves the next time they are updated.

### Secret redaction

`Telegram_Debug_Log` previously recorded the webhook verification secret,
because every API call logged its whole request body and `setWebhook` carries
that secret twice — in the callback URL as `wh=` and again as `secret_token`.

Request bodies are no longer logged. What is written is the operation, the HTTP
result, a masked chat id and Telegram's error description after redaction.
`redactSecrets_` removes the bot token, webhook secret and admin key by value,
and also removes anything *shaped* like a credential so a rotated value is
still caught.

**Outstanding, with the tooling now shipped.** Debug rows written before that
change may still contain the old webhook secret. Two controls in
**Sozlamalar → Tizim → Ma'lumotlarni Tuzatish** do the work, and both need the
admin key:

1. **Loglarni Tozalash** (`purge_telegram_debug_secrets`) — copies
   `Telegram_Debug_Log` to a timestamped backup sheet, then re-redacts every row
   in place. Safe to press twice.
2. **Webhook Kalitini Almashtirish** (`rotate_telegram_webhook_secret`) — mints
   a new verification secret, re-points Telegram at it and verifies. The old
   secret stays accepted until the new one is confirmed, so no update is
   dropped; if anything fails the old secret is restored and the webhook is
   re-pointed at it.

Run 1 then 2. Neither has been run against the live project yet — they need the
admin key, which only the operator has.

**The bot token is not being rotated.** The two tokens exposed in git history
belong to a bot id that was revoked; nothing in this change indicates the
current token has ever left Script Properties, and the debug logger has never
recorded it since request bodies stopped being logged.

---

## Dates

The spreadsheet reads typed text with a MM/DD/YYYY locale while the app writes
day-first, so Sheets silently rewrote `05/08/2026` (5 August) as 8 May whenever
the day was 12 or lower. Writing the accounting period as `2026-08` had the
same problem: it was stored as a date.

Writes no longer hand the spreadsheet anything it can reinterpret — dates go in
as real date values and the Month column is text-formatted before values land.
Reads also understand a Month cell that was already turned into a date, so
affected rows resolve correctly without editing the sheet.

**Outstanding, with the tooling now shipped.** The Date column on older rows
still shows day and month transposed. The accounting is unaffected — month
labels drive every figure — so this is cosmetic.

Measured against the live sheet on 2026-08-12, over all 226 rows:

| | Rows |
|---|---|
| date agrees with the instant its transaction id encodes | 80 |
| **provably transposed** — swapping day and month reproduces that instant | **142** |
| disagrees some other way — not provable, left alone | 4 |
| no usable epoch prefix on the id | 0 |

**Sozlamalar → Tizim → Ma'lumotlarni Tuzatish** has *1. Sanalarni Tekshirish*
(reports the table above, writes nothing) and *2. Sanalarni Tuzatish* (backs up,
then corrects only the 142). The 4 unprovable rows are reported and never
touched — correcting them would mean guessing, which is why they are left as
they are. Neither control has been run live: both need the admin key.

---

## Rent and debt

Tenant debt is calculated from the rent that applies in the month being viewed,
resolved in this order:

1. inactive, or outside the agreement start/end → no rent
2. legacy disabled month → no rent
3. `noRentPeriods` → no rent
4. monthly exception → the exception amount
5. the latest applicable scheduled rent change
6. the default rent

`assets/omad/02b-calc.js` and `apps-script/05a_calculations.gs` are two
implementations of the same rules and are compared field-by-field by
`tests/calc-parity.e2e.js`. Do not change one without the other.

**Note:** O'quv Markaz carries *both* an August 2026 exception of 500 USD and a
rent change effective 2026-08 of 500 USD. They agree, so the result is correct
either way, but the duplication is redundant and someone should decide which
was intended.

---

## Saving

Apps Script answers HTTP 200 for almost everything, including its own errors.
A save counts as successful only when the body parses **and** says
`status: "success"`. Anything else keeps the form, the cart and the request id
so the entry can be retried without duplicating.

---

## Source of truth

- **GitHub `main` is the source of truth for the backend.** What is merged there
  is what production runs, because CI deploys it — see
  [DEPLOYMENT.md](DEPLOYMENT.md). Editing the live project in the Apps Script
  IDE is not a way to ship: the next merge overwrites it, and the deploy's
  drift guard fails the build rather than deleting the change silently.
- `apps-script/*.gs` is the source. Edit there. These are the files clasp
  uploads.
- `script.gs` is **generated** by `npm run build`. Never edit it by hand;
  `npm run build:check` fails the build if it is stale. It is kept as a
  review aid and a manual-deployment fallback, not the production path.
- The Apps Script manifest is deliberately **not** in the repository. The deploy
  pulls the live project's own `appsscript.json` and copies it back unchanged,
  so a stale local copy can never overwrite the running web-app settings.
- On Windows, `build:check` can report the bundle stale purely because of CRLF
  line endings in the checkout. It is LF-clean in git and passes in CI.
