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
