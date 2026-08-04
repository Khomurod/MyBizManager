'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

const SCANNED_EXTENSIONS = ['.html', '.gs', '.js', '.md', '.json', '.yml', '.yaml', '.csv'];
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), files);
    } else if (SCANNED_EXTENSIONS.includes(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function relative(file) {
  return path.relative(ROOT, file);
}

/** Inline <script> bodies of an HTML file, in document order. */
function inlineScripts(html) {
  const blocks = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    blocks.push(match[2]);
  }
  return blocks;
}

// ------------------------------------------------------------ secret scanning

test('no Telegram bot token is committed anywhere in the working tree', () => {
  // Real BotFather tokens: <6-16 digit bot id>:<35+ char secret>.
  const tokenPattern = /\b\d{6,16}:[A-Za-z0-9_-]{30,}\b/g;
  // Allowlisted by exact value, not by path, so a real secret dropped into
  // tests/ is still caught.
  const fixtureTokens = new Set(['123456789:AAFakeTokenForTestsOnly_0123456789abcd']);
  const offenders = [];

  for (const file of walk(ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const matches = (line.match(tokenPattern) || []).filter(m => !fixtureTokens.has(m));
      if (matches.length > 0) offenders.push(`${relative(file)}:${i + 1}`);
    });
  }

  assert.deepStrictEqual(offenders, [], `Telegram token-shaped secrets found: ${offenders.join(', ')}`);
});

test('the previously leaked token is fully removed from the working tree', () => {
  // The historically exposed token is identified by its SHA-256 digest so this
  // test can assert its absence without embedding the secret itself.
  const LEAKED_TOKEN_SHA256 = '1772566d70695b8fcf592d0f79bc39343a1447526f1a89e68733ca229c1a3852';
  const candidatePattern = /\b\d{6,16}:[A-Za-z0-9_-]{30,}\b/g;
  const offenders = [];

  for (const file of walk(ROOT)) {
    const content = fs.readFileSync(file, 'utf8');
    const matches = content.match(candidatePattern) || [];
    for (const candidate of matches) {
      const digest = crypto.createHash('sha256').update(candidate).digest('hex');
      if (digest === LEAKED_TOKEN_SHA256) offenders.push(relative(file));
    }
  }

  assert.deepStrictEqual(offenders, [], `Leaked token still present in: ${offenders.join(', ')}`);
});

test('no frontend file talks to api.telegram.org directly', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    if (path.extname(file) !== '.html') continue;
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('api.telegram.org')) offenders.push(relative(file));
  }
  assert.deepStrictEqual(offenders, [], `Frontend calls Telegram directly in: ${offenders.join(', ')}`);
});

test('no frontend file declares a BOT_TOKEN or CHAT_ID constant', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    if (path.extname(file) !== '.html') continue;
    const content = fs.readFileSync(file, 'utf8');
    if (/\b(const|let|var)\s+(BOT_TOKEN|CHAT_ID)\b/.test(content)) offenders.push(relative(file));
  }
  assert.deepStrictEqual(offenders, [], `Telegram credential constants found in: ${offenders.join(', ')}`);
});

test('script.gs reads the bot token only from Script Properties', () => {
  const content = fs.readFileSync(path.join(ROOT, 'script.gs'), 'utf8');
  assert.ok(
    /function getBotToken_\(\)\s*\{\s*return getTelegramSetting_\(TELEGRAM_PROP_BOT_TOKEN\);\s*\}/.test(content),
    'getBotToken_ must read exclusively from Script Properties'
  );
});

// ------------------------------------------------------------- syntax checks

test('script.gs parses as valid JavaScript', () => {
  const content = fs.readFileSync(path.join(ROOT, 'script.gs'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(content, { filename: 'script.gs' }));
});

test('every inline script in every HTML file parses as valid JavaScript', () => {
  for (const file of walk(ROOT)) {
    if (path.extname(file) !== '.html') continue;
    const blocks = inlineScripts(fs.readFileSync(file, 'utf8'));
    blocks.forEach((code, index) => {
      assert.doesNotThrow(
        () => new vm.Script(code, { filename: `${relative(file)}#script[${index}]` }),
        `Syntax error in ${relative(file)} inline script #${index}`
      );
    });
  }
});

// ------------------------------------------------- duplicate function detection

/** Top-level `function name(` declarations in a chunk of JavaScript. */
function functionNames(code) {
  const names = [];
  const pattern = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = pattern.exec(code)) !== null) names.push(match[1]);
  return names;
}

function duplicatesIn(names) {
  const counts = {};
  names.forEach(name => { counts[name] = (counts[name] || 0) + 1; });
  return Object.keys(counts).filter(name => counts[name] > 1).sort();
}

test('script.gs has no duplicate function definitions', () => {
  const content = fs.readFileSync(path.join(ROOT, 'script.gs'), 'utf8');
  assert.deepStrictEqual(duplicatesIn(functionNames(content)), []);
});

test('known duplicate-function debt is tracked and does not grow', () => {
  // cafe_pos.html carries pre-existing duplicates. They are deliberately not
  // fixed in this change (see PR scope), but the list must not grow.
  const known = {
    'cafe_pos.html': ['recomputeCloseDay', 'renderCloseDayList', 'submitCloseDay']
  };

  for (const file of walk(ROOT)) {
    if (path.extname(file) !== '.html') continue;
    const names = inlineScripts(fs.readFileSync(file, 'utf8')).flatMap(functionNames);
    const expected = known[path.basename(file)] || [];
    assert.deepStrictEqual(
      duplicatesIn(names),
      expected,
      `Duplicate function set changed in ${relative(file)}`
    );
  }
});
