'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('a post-save refresh does not rehydrate a stale snapshot or block another write', () => {
  const api = read('assets/omad/06-api.js');
  const app = read('assets/omad/12-app.js');

  assert.match(api, /async function syncData\(options = \{\}\)/);
  assert.match(api, /const background = !!\(options && options\.background\)/);
  assert.match(api, /const hadSnapshot = background \? false : hydrateFromSnapshot\(\)/);
  assert.match(app, /await syncData\(\{ background: true \}\)/);
});

test('rapid confirmed saves coalesce refreshes without losing the latest refresh', () => {
  const app = read('assets/omad/12-app.js');

  assert.match(app, /omadWriteRefreshPending_ = true/);
  assert.match(app, /while \(omadWriteRefreshPending_\)/);
  assert.match(app, /omadWriteRefreshPending_ = false/);
});

test('an ordinary Omad save shows its own button state instead of freezing the app', () => {
  // The entry form and the tenant-paid form both already disable their Save
  // button and relabel it, which is the local saving state *and* the guard
  // against a second submission. The full-screen loader on top of that only
  // whited out the dashboard behind the form. Migrations, backups, maintenance
  // and the initial load keep theirs.
  const app = read('assets/omad/12-app.js');
  const ledger = app.slice(app.indexOf('submitViaLedger = async function'),
    app.indexOf('submitTenantPaid = async function'));
  const pair = app.slice(app.indexOf('submitTenantPaid = async function'));

  assert.doesNotMatch(ledger, /showLoader\(/, 'the entry form no longer blocks the screen');
  assert.doesNotMatch(pair, /showLoader\(/, 'nor does the tenant-paid form');

  const entry = read('assets/omad/08-entry.js');
  assert.match(entry, /btn\.disabled = true; btn\.innerText = "Bajarilmoqda\.\.\."/,
    'the local saving state is still what the person sees');

  const system = read('assets/omad/10b-system.js');
  assert.match(system, /showLoader\(true\)/,
    'migrations, backups and maintenance still make the whole screen wait');
});

test('cancelling an entry refreshes in the background and refuses a second click', () => {
  const entry = read('assets/omad/08-entry.js');
  const cancel = entry.slice(entry.indexOf('async function deleteTx'));

  assert.match(cancel, /if\(cancellingEntry\) return/,
    'the guard is explicit rather than an overlay side effect');
  assert.match(cancel, /settleOmadWriteInBackground_\(\)/);
  assert.doesNotMatch(cancel.slice(0, cancel.indexOf('const grouped')), /await syncData\(\)/,
    'a foreground sync would rehydrate the snapshot and refuse the next write');
});

// ------------------------------------------------------------------- Mini App

test('the Mini App confirms a financial write before refreshing, and coalesces it', () => {
  const omad = read('assets/mini/03-omad.js');

  // Both entry flows: close, confirm, then refresh out of band.
  assert.strictEqual((omad.match(/refreshOmadInBackground\(\)/g) || []).length, 3,
    'the transaction flow, the tenant-paid flow, and the helper itself');
  assert.doesNotMatch(omad, /await loadOmad\(\);\n\s*\} catch/,
    'neither write waits for the figures to come back');
  assert.match(omad, /flushReports\(\)/, 'the Telegram nudge stays unawaited');

  // Coalesced, like the web app's.
  assert.match(omad, /miniOmadRefreshPending = true/);
  assert.match(omad, /while \(miniOmadRefreshPending\)/);
  assert.match(omad, /miniOmadRefreshPending = false/);
});

test('an older Mini App read can never paint over a newer one', () => {
  const omad = read('assets/mini/03-omad.js');

  assert.match(omad, /let miniOmadLoadSeq = 0/);
  assert.match(omad, /const seq = \+\+miniOmadLoadSeq/);
  // Guarded on both outcomes: a superseded answer is dropped whole, and a
  // superseded failure does not toast over a newer read that is still running.
  assert.strictEqual((omad.match(/if \(seq !== miniOmadLoadSeq\) return/g) || []).length, 2);
  // The gate closing is never stale news.
  assert.match(omad, /if \(error\.unauthorized\) return failAuth\(error\)/);
});

test('the Mini App snapshot is still only written from a live verified answer', () => {
  // The background refresh must not change what may reach storage: the snapshot
  // is display-only, keyed by the id in the verified response, and only for the
  // period the app opens on.
  const omad = read('assets/mini/03-omad.js');
  const load = omad.slice(omad.indexOf('async function loadOmad'));
  assert.match(load, /if \(state\.user && body\.omad\.period === currentPeriod\(\)\)/);
  assert.match(load, /writeMiniSnapshot\(state\.user\.id, \{/);
  // ...and it is only reached after the staleness check above it.
  assert.ok(load.indexOf('if (seq !== miniOmadLoadSeq) return') <
    load.indexOf('writeMiniSnapshot'), 'a superseded answer never reaches storage');
});
