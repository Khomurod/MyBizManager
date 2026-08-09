# Live state

What is actually running, as opposed to what the design documents describe.
Update this file whenever the live system changes.

**Last verified: 2026-08-05.**

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

## Where everything lives

| Piece | Value |
|---|---|
| Frontend | <https://omad-d.netlify.app> — Netlify, auto-deploys `main` |
| Apps Script project | **LIVE** (renamed from "Untitled project") |
| Script ID | `1afG6M-B6sFgPdfNIfwMFCIx3HAHDqliV-4Zhbiu6YhNNoMHb9fgsWcpG` |
| Google Sheet | `1Q9_v2PrusZimoAjqbOUmHkW_NzDiV0z_8Wtr-v963CA` ("Budgeting app") |
| Active deployment | id begins `AKfycbzhKyEOG…`, ends `…DtCA2W` |
| Executes as | the owner; access: Anyone |

The backend URL is hardcoded in **three** places, which must always agree:

- `assets/omad/00-config.js`
- `cafe_admin.html`
- `cafe_pos.html`

### Deploying Apps Script — the trap

The project has around twenty deployments. Only one is the live one.

**To ship a backend change:** Deploy → **Manage deployments** → select the
deployment whose id ends `…DtCA2W` → pencil → Version → **New version** →
Deploy.

**Never use "New deployment".** It mints a *new URL that nothing calls*, so the
code looks deployed while the app keeps running the old version. This happened
repeatedly and is why production ran stale code for weeks.

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
| Retry trigger | `processPendingTelegramJobs`, time-driven, every 5 minutes |
| Bot token | in Script Properties — never in the repo |

Credentials live in Script Properties (`TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_AUTHORIZED_USER_ID`,
`TELEGRAM_GROUP_CHAT_ID`, `OMAD_ADMIN_KEY`) and are set through
**Sozlamalar → Telegram**, not by hand.

Changing the backend URL means re-running the **Webhook** button, or Telegram
keeps delivering to the old deployment.

### Tasks (not yet deployed as of this change)

The task-management feature (`/tasks`, see [TASKS.md](TASKS.md)) is delivered
and tested but requires three manual operator steps before it is live:

1. deploy the regenerated `script.gs` to the `…DtCA2W` deployment (new version);
2. set **Vazifalar Guruhi ID** in Sozlamalar → Telegram (Script Property
   `TELEGRAM_TASKS_GROUP_CHAT_ID`) and add the bot to that group;
3. add a second time-driven trigger for **`processTaskSchedules`** (every 5
   minutes), separate from the existing `processPendingTelegramJobs` trigger.

Until step 2, task messages are simply not sent; the accounting flows are
unaffected either way.

### Secret redaction

`Telegram_Debug_Log` previously recorded the webhook verification secret,
because every API call logged its whole request body and `setWebhook` carries
that secret twice — in the callback URL as `wh=` and again as `secret_token`.

Request bodies are no longer logged. What is written is the operation, the HTTP
result, a masked chat id and Telegram's error description after redaction.
`redactSecrets_` removes the bot token, webhook secret and admin key by value,
and also removes anything *shaped* like a credential so a rotated value is
still caught.

**Outstanding:** debug rows written before this change may still contain the
old webhook secret. Rotating that secret and clearing those rows is still to be
done.

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

**Outstanding:** the Date column on roughly 143 older rows still shows day and
month transposed. The accounting is unaffected — month labels drive every
figure — so this is cosmetic, and a correction has not been applied.

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

- `apps-script/*.gs` is the source. Edit there.
- `script.gs` is **generated** by `npm run build`. Never edit it by hand;
  `npm run build:check` fails the build if it is stale.
- On Windows, `build:check` can report the bundle stale purely because of CRLF
  line endings in the checkout. It is LF-clean in git and passes in CI.
