---
name: implement
description: The repository's standard workflow for implementing a feature, fix, adjustment, removal or other meaningful application change. Use when the user invokes /implement, or asks for any change to how the application behaves. Runs understand → investigate → implement → test → self-review → verify → update the App Brief → report.
---

# /implement

Usage: `/implement <requested change, in the user's own words>`

The request describes the **result the user wants**, often in business language.
Determining the technical solution is your job, not theirs. Never ask the user to
prescribe an implementation when the desired outcome is already clear.

This skill is the *process*. The repository's own files are the *content*:

- `CLAUDE.md` — how you must work in this repository, and its permanent rules.
- The App Brief (`docs/APP_BRIEF.md`, or `APP_BRIEF.md` — read whichever exists)
  — what this application is, how it behaves, its business rules and decisions.

Read and obey those files. If anything below appears to conflict with them, they
win, and you say so in your report.

---

## 1. Understand

Before editing anything:

- Read `CLAUDE.md` in full.
- Read the sections of the App Brief that cover the area you are about to touch,
  plus any repository-specific docs it points you to.
- State to yourself the **final behaviour** the user wants — the end state, not
  the steps.
- Identify what must stay unchanged: the exceptions the user named, and adjacent
  behaviour they clearly still depend on.

If a genuine ambiguity would send the work in materially different directions,
ask. Otherwise decide, note the assumption, and continue.

## 2. Investigate

Before implementing:

- Read the real code paths involved — end to end, including callers and callees.
- When fixing a problem, find the **actual root cause**. The user's theory of the
  cause is a lead, not a fact; verify it against the code before acting on it.
- Trace the dependencies and data flow the change sits in, and check related code
  that could be affected.
- Look for existing patterns, helpers and components to reuse instead of
  inventing parallel ones.
- Check the repository's invariants that apply here — mirrored files that must
  change together, generated files, append-only data, permission gates,
  language/style constraints — as `CLAUDE.md` and the App Brief define them.
- For risky or cross-cutting changes, do enough impact analysis to know what else
  could break, and note it.

## 3. Implement

Implement the requested result **completely**.

- Fix the underlying problem, not just the visible symptom.
- Preserve unrelated existing functionality.
- Respect the existing architecture, conventions, permissions, business rules,
  integrations and repository invariants.
- Keep it as simple as the problem allows. No speculative abstraction, no
  unrelated refactors, no drive-by changes.
- Do not silently change behaviour the request did not ask you to change.
- If implementation reveals a materially better route to the requested outcome,
  take it — the desired result matters more than an assumed implementation — and
  say so in the report.
- Regenerate anything the repository generates from what you edited, and commit
  it, as `CLAUDE.md` requires.

## 4. Test

- Run the existing tests relevant to what changed.
- Add or update tests so the new or fixed behaviour is protected against
  regression, and so the behaviour you were told to preserve stays covered.
- Run the repository's required checks — build, lint, type-check,
  static analysis, e2e, secret scan — as `CLAUDE.md` and the App Brief define
  them. In this repository that is currently:
  `npm run build:check && npm run lint && npm test && npm run test:e2e && npm run scan:secrets`
  (verify against `package.json` and `CLAUDE.md`; those files, not this line, are
  authoritative).
- **Never state that a check passed unless you actually ran it and it passed.**
  A skipped or unavailable check is reported as skipped, never as green.
- A failure caused by your change is yours to diagnose and fix, not to report and
  stop at. Fix it and re-run.

## 5. Self-review

Review your own diff as if it were another developer's, and answer each question
honestly:

- Did I implement **everything** requested?
- Did I misread any part of the desired behaviour?
- Did I miss an edge case — empty, zero, missing, duplicate, concurrent, first
  run, permissions, boundaries?
- Did I change unrelated behaviour by accident?
- Did I duplicate logic, or make something more complicated than it needs to be?
- Did I violate a business rule, permission rule, integration contract,
  design-system rule or repository invariant?
- What is the regression risk, and what would catch it?
- Are the tests sufficient for what actually changed?
- Is there leftover debug, temporary or dead code?
- Does the final diff contain anything that should not be in it?

**Fix what you find.** Reporting a problem you could have fixed is not a
self-review.

## 6. Verify again

- Re-run the affected tests and checks after the self-review fixes.
- Read the final diff once more, top to bottom.
- Confirm the implementation matches the requested behaviour, and that the
  named exceptions still behave as before.

Do not declare completion while a known problem remains. If something genuinely
cannot be resolved inside this task, finish everything else and report it
plainly.

## 7. Documentation and the App Brief

Before the task is complete:

- Re-read the App Brief.
- Decide whether your change made any part of it untrue, or introduced a new
  behaviour, business rule, integration, dependency, exception or preserved
  decision that belongs in it.
- Update the relevant sections **in this same task and commit**. Add what is
  newly true; correct or remove what is now false.
- Check whether the change also made another current document inaccurate, and fix
  that too.
- Do not add minor implementation detail to the brief — it exists to stop the
  next agent misunderstanding the system.
- If the brief and the verified code disagree, **the code is the source of
  truth** and the brief gets corrected.

A task is not complete while the application behaves one way and the App Brief
says another.

## 8. Final report

Keep it short. Report only:

- What changed, in terms of behaviour.
- Whether the requested result is fully implemented.
- Which important tests and checks were run, and whether they passed (naming
  anything skipped).
- Anything significant found during self-review and corrected — especially if the
  real root cause differed from the one assumed in the request.
- Any genuine remaining limitation or uncertainty.

No low-level implementation narration unless the user asks for it.
