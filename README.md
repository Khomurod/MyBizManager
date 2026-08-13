# MyBizManager

Day-to-day operations for one small Uzbek business, in three areas that share a
single backend, database and Telegram bot:

- **Omad** — rent and cash accounting for a commercial property, in UZS and USD.
- **Café** — point of sale, stock, recipes and daily close-out.
- **Tasks** — recurring and one-off work, assigned and proved through Telegram.

The UI is in Uzbek (Latin). There is a web app, a Telegram bot (`/yangi`) and a
Telegram Mini App.

## Start here

**[`docs/APP_BRIEF.md`](docs/APP_BRIEF.md) is the orientation document** — what
the application is, who uses it, the business rules that must not be broken,
the permission gates and the background jobs. Read it before changing anything.

| If you need | Read |
|---|---|
| The rules, gates and preserved decisions | [`docs/APP_BRIEF.md`](docs/APP_BRIEF.md) |
| Sheet schemas, data shapes, the API surface | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Hosting, the CI pipeline, rollback | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) |
| The task module in depth | [`docs/TASKS.md`](docs/TASKS.md) |
| Bot / webhook / group setup (operator, Uzbek) | [`docs/TELEGRAM_SETUP.md`](docs/TELEGRAM_SETUP.md) |

## Shape of the repository

```
apps-script/*.gs   Google Apps Script backend — the source of truth, ES5 only
script.gs          GENERATED bundle of the above; never hand-edit
assets/**, *.html  the static frontend (classic scripts, no bundler, no framework)
tests/             node --test unit/integration (*.test.js) and Playwright (*.e2e.js)
scripts/           build, deploy and secret-scan tooling
```

The frontend is served by Cloudflare Pages from `main` with no build step. The
backend is deployed to Google Apps Script by CI on every green merge to `main`.

## Getting started

Requires Node 20+.

```bash
npm install
npm run build          # regenerate script.gs from apps-script/
npm test               # unit/integration tests
npm run test:e2e       # browser tests (Playwright + Chromium)
```

Before pushing, run everything CI runs:

```bash
npm run build:check && npm run lint && npm test && npm run test:e2e && npm run scan:secrets
```

Three rules that catch most mistakes:

- **`script.gs` is generated.** Run `npm run build` after any `apps-script/`
  change and commit the result, or `build:check` fails CI.
- **`apps-script/05a_calculations.gs` and `assets/omad/02b-calc.js` are
  mirrors** (as are the tenants and periods pairs). Never change one alone.
- **The transaction ledger is append-only.** Never rewrite or delete a
  financial row.

**Never push to `main` directly** — develop on a branch and open a PR. The full
set of non-negotiables is in [`CLAUDE.md`](CLAUDE.md) and the App Brief.
