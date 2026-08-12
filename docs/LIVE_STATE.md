# Live state

What is actually running, as opposed to what the design documents describe.
Update this file whenever the live system changes.

**Last verified: 2026-08-12** (frontend hosts, Telegram configuration and the
anonymous-endpoint exposure re-checked directly against the live systems).

---

## The short version

| | |
|---|---|
| Active transaction sheet | **`Omad_Transactions`** (legacy) |
| Is the V2 ledger live? | **No.** `Omad_Transactions_V2` does not exist |
| Migration state | `not_started` |
| Fallback year | `2026` |

**V2 is not live and cutting over is not part of current work.** The migration
code is maintained and tested, but the application reads and writes the legacy
sheet. Do not run `cutover_omad_migration` without a separate, approved plan.

---

## ⚠️ No frontend host is serving the current build

**Re-checked 2026-08-12 15:2x, independently, against the live systems.**

| Host | State |
|---|---|
| Netlify (`omad-d.netlify.app`) | **Serving, but stale.** `/assets/omad/06-api.js` does not contain `omad_access_key`; `/mini` returns 404 |
| Cloudflare Pages | **Not found.** No Pages project is connected to `Khomurod/MyBizManager` |
| GitHub Pages | **Off.** `khomurod.github.io/MyBizManager` returns 404 |

How the Cloudflare conclusion was reached, so it can be re-checked rather than
believed: the Cloudflare Pages GitHub App creates a GitHub *deployment* and a
*check run* on every build. The repository has 22 deployments and every one of
them was created by `github-actions` (the Apps Script deploy) or by the old
`github-pages` app — none by Cloudflare — and the four check runs on `main` are
all CI jobs. Nothing in the repository references Cloudflare either: there is no
`wrangler.toml`, no `_headers`, no `_redirects`.

This matters because the two halves deploy separately. CI pushes Apps Script
within a minute of a merge; the static host evidently does not. When the backend
started requiring an access key and the browser had not learned to send one,
**every save failed** — no rent recorded, no café sale rung up.

### The compatibility layer is gone from the code, not yet from production

`LEGACY_CLIENT_GRACE` and the anonymous `get_omad` / `get_cafe` routes have been
removed on the branch. **Merging that is gated on a current frontend being
live**, because the only host still answering serves a build that calls exactly
those routes: merging first would take the app down for a business using it
daily, reads and writes alike.

Until it merges, production still has the hole. Verified directly on
2026-08-12: `GET /exec?action=get_omad` returned the full ledger and
`?action=get_cafe` the whole café state, both with no credential of any kind,
and an unauthenticated `get_telegram_settings` POST returned the authorized user
id and both group chat ids.

### To close it

The order is not negotiable.

1. Get a host publishing `main`. Netlify's free build credits are spent, so the
   intended replacement is a Cloudflare Pages project connected to
   `Khomurod/MyBizManager` with production branch `main`. Pages serves
   `mini.html` and `tasks.html` at `/mini` and `/tasks` without any config, so
   `netlify.toml` does not need reproducing.
2. Confirm the live host actually serves the current build — do not infer it
   from a green merge:
   `curl -s https://<production-host>/assets/omad/06-api.js | grep -c omad_access_key`
   must print `1`, and `https://<production-host>/mini` must not 404.
3. Sign in on that host, load Omad and Café, save one entry, and reverse it.
4. Only then merge the branch that removes the compatibility layer. Everything
   requires the key from that moment, and every open browser session signs in
   once more.

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

A phone-first app served at `/mini` by whichever host serves the frontend,
opened from the bot's menu button. It is reachable **only** by the Telegram user in
`TELEGRAM_AUTHORIZED_USER_ID` — the same setting that already decides who may
run `/yangi`. There is no second user list.

Two things to know:

1. **Setting it up is one button.** Sozlamalar → Tizim → *Mini Appni Sozlash*
   installs the menu button through the Bot API and verifies it. Nothing has to
   be typed into BotFather.
2. **It has not been configured against the live bot yet.** Confirmed on
   2026-08-12: `get_telegram_settings` reports `miniAppUrl` empty and
   `miniAppStatus` null, so no menu button has ever been installed. Nothing
   points at Netlify, so nothing needs un-pointing — the URL to supply is the
   new production host's `/mini`. That button needs the admin key.

Opened in an ordinary browser it shows one sentence and asks the server for
nothing.

## System health

Sozlamalar → Tizim → *Tizim Salomatligi* checks fifteen things in one pass and
reports green / warning / error. The one worth knowing about: it compares the
deployment answering the request with the deployment the webhook points at, so
the "New deployment mints a URL nothing calls" trap described below is now
detected rather than discovered weeks later.

## Where everything lives

| Piece | Value |
|---|---|
| Frontend | **Unsettled.** Netlify (`omad-d.netlify.app`) still answers but serves a stale build and no longer deploys `main`; the intended replacement is Cloudflare Pages, which was not connected as of 2026-08-12 |
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
