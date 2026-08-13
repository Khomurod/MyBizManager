# Working on MyBizManager

**Read [`docs/APP_BRIEF.md`](docs/APP_BRIEF.md) before changing anything.** It is
the central App Brief: what this application is, who uses it, the business rules
that must not be broken, the permission gates and the background jobs. Its
documentation map names the four specialized documents and what each one owns.

Two rules that apply to every task:

1. **Before a change** — read the parts of the App Brief that cover the area you
   are touching, and verify them against the current code.
2. **After a change** — re-read the App Brief and update it in the *same* commit
   if your work changed anything it describes, or introduced a new rule,
   dependency, integration, exception or decision. A task is not complete while
   the brief and the application disagree.

Non-negotiables (the brief explains each):

- `apps-script/*.gs` is the backend source of truth and is **ES5 only**.
  `script.gs` is generated — run `npm run build` and commit it, or CI fails.
- `apps-script/05a_calculations.gs` ↔ `assets/omad/02b-calc.js` (and the
  tenants / periods pairs) are mirrors. Never change one without the other.
- The transaction ledger is append-only. Never rewrite or delete a financial row.
- Never push to `main` directly; develop on a branch and open a PR.

Before pushing: `npm run build:check && npm run lint && npm test && npm run test:e2e && npm run scan:secrets`
