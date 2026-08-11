# Deployment

**GitHub `main` is the source of truth for the backend.** Merging to `main`
updates the live Apps Script project automatically, once every CI check has
passed. Nobody pastes `script.gs` into the editor any more.

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
```

The deploy job is `.github/workflows/ci.yml → deploy`, and the orchestration is
`scripts/clasp-deploy.js`.

### What it never does

- **Never creates an Apps Script project.** It pushes into the existing one.
- **Never creates a deployment.** It calls `update-deployment` against the id
  already serving production, so the `/exec` URL is unchanged — which is what
  keeps the Telegram webhook, the three frontend hardcodes and every bookmark
  working. (`New deployment` mints a URL nothing calls; see
  [LIVE_STATE.md](LIVE_STATE.md).)
- **Never touches Script Properties.** `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_AUTHORIZED_USER_ID`,
  `TELEGRAM_GROUP_CHAT_ID`, `TELEGRAM_TASKS_GROUP_CHAT_ID`, `OMAD_ADMIN_KEY`
  and everything else are project state, not code. Updating the code inside the
  same project leaves them exactly where they are.
- **Never re-registers the webhook**, recreates the spreadsheet, or deletes the
  `processPendingTelegramJobs` trigger.
- **Never runs from a pull request or a feature branch.** The job is
  conditioned on `github.event_name == 'push'` and
  `github.ref == 'refs/heads/main'`, and `tests/static-analysis.test.js` fails
  the build if those conditions are ever weakened.

---

## One-time operator setup

Three **secrets** (Settings → Secrets and variables → Actions → *Secrets*):

| Secret | What to put in it |
|---|---|
| `CLASPRC_JSON` | The entire contents of `~/.clasprc.json` after running `clasp login` as the account that owns the script. Contains an OAuth refresh token. |
| `CLASP_JSON` | `{"scriptId":"<the existing project's script id>"}` — the `.clasp.json` of the live project. |
| `APPS_SCRIPT_DEPLOYMENT_ID` | The id of the deployment already serving production (the one ending `…DtCA2W`). |

One **variable** (same page → *Variables*):

| Variable | Value |
|---|---|
| `APPS_SCRIPT_DEPLOY_ENABLED` | `true` — the master switch. Until it is set, the deploy job is skipped and CI behaves exactly as before. |

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

The live deployment is the one whose id ends `…DtCA2W`. Confirm before using it
— see [LIVE_STATE.md](LIVE_STATE.md#where-everything-lives).

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
clasp can see, so frontend HTML, `assets/`, `tests/`, `docs/`, `diagnostics/`,
`script.gs`, `.git` and `node_modules` cannot reach Apps Script. `clasp
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
| Job skipped entirely | `APPS_SCRIPT_DEPLOY_ENABLED` is not `true`. |
| `✗ CLASPRC_JSON is not set` | The secret is missing or empty. |
| `✗ … is not valid JSON` | The secret was pasted partially, or wrapped in quotes. |
| `clasp pull` fails to authorise | The refresh token was revoked, or the Apps Script API is off for that account. Re-run `clasp login` and update the secret. |
| Drift or unsupported-file error | Somebody edited the live project by hand; see above. |
| Two merges at once | The second queues behind the first — the `apps-script-production` concurrency group serialises them, and neither is cancelled. |

Credentials are never printed. Ids appear masked (`1afG6M…9fgsWcpG`), and the
preflight reports that credentials are *present* rather than showing them.

---

## Manual deployment, if ever needed

The old path still works and needs no setup: run `npm run build`, open the
script project, paste `script.gs` over the existing code, then
**Deploy → Manage deployments →** the `…DtCA2W` deployment **→ New version**.
Prefer the pipeline; this is the fallback for an Actions outage.
