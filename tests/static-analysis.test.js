'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
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

/**
 * Every JavaScript block an HTML page executes, in document order: inline
 * <script> bodies plus the contents of locally referenced <script src="...">.
 * Remote scripts (the Tailwind CDN) are skipped.
 */
function pageScripts(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const blocks = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1]);
    if (!src) {
      blocks.push({ name: `${relative(htmlFile)}#inline`, code: match[2] });
      continue;
    }
    if (/^https?:/i.test(src[1])) continue;
    const linked = path.join(ROOT, src[1]);
    assert.ok(fs.existsSync(linked), `${relative(htmlFile)} references a missing script: ${src[1]}`);
    blocks.push({ name: src[1], code: fs.readFileSync(linked, 'utf8') });
  }
  return blocks;
}

/** Apps Script modules, in the load order the bundler uses. */
function appsScriptModules() {
  const dir = path.join(ROOT, 'apps-script');
  return fs.readdirSync(dir).filter(f => f.endsWith('.gs')).sort()
    .map(f => ({ name: `apps-script/${f}`, code: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

// --------------------------------------------------------- module boundaries

test('the task wizard never reaches into accounting data', () => {
  // The wizard runs inside the private /yangi conversation, which is where the
  // money lives, so the isolation rule has to be enforced structurally rather
  // than by review. Withholding `configSheet` from its entry points stops the
  // accidental case; this stops the deliberate one, because `doc` is in scope
  // and everything is one global namespace.
  //
  // Any genuinely new need here is a design decision, not a rename: change the
  // list only alongside the isolation documentation it mirrors.
  const forbidden = [
    'getActiveTenantNames_', 'normalizeTenantList_', 'readOmadTransactions_',
    'safeSaveOmad_', 'backupOmadState_', 'calculateActuals_', 'toUZS_',
    'Omad_Tenants', 'Omad_Rates', 'Omad_Transactions', 'Omad_Backups',
    'Omad_Template_Expenses', 'System_Config'
  ];

  const wizard = appsScriptModules().find(m => m.name.endsWith('19a_tasks_wizard.gs'));
  assert.ok(wizard, 'the wizard module exists');

  // Comments explain the rule by naming what is banned, so only real code counts.
  const code = wizard.code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');

  const offenders = forbidden.filter(name => code.indexOf(name) !== -1);
  assert.deepStrictEqual(offenders, [],
    `19a_tasks_wizard.gs must not touch accounting data: ${offenders.join(', ')}`);
});

// --------------------------------------------------------- the deployment gate

/**
 * The deploy job writes straight to production Apps Script, so the conditions
 * that hold it back are load-bearing. They are asserted here rather than left
 * to review, because weakening any one of them is a one-line edit that looks
 * harmless in a diff.
 */
test('production deployment stays gated behind green CI on main', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const deploy = workflow.slice(workflow.indexOf('\n  deploy:'));
  assert.ok(deploy, 'the deploy job exists');

  // Every check must pass first. Dropping one from this list is the failure
  // mode this guards: it would ship code no test had run against.
  assert.match(deploy, /needs:\s*\[static,\s*unit,\s*browser\]/,
    'deploy must wait for the static, unit and browser jobs');

  // A pull request or a feature branch must never reach production. Only a
  // push and an explicit manual dispatch qualify, and both are pinned to main.
  assert.match(deploy, /github\.event_name == 'push'/, 'deploy only on a push…');
  assert.match(deploy, /github\.event_name == 'workflow_dispatch'/, '…or a manual dispatch');
  assert.match(deploy, /github\.ref == 'refs\/heads\/main'/, 'deploy only from main');
  assert.ok(!/pull_request/.test(deploy.split('steps:')[0]),
    'no pull_request event may satisfy the deploy condition');

  // No enable switch. A `vars.`-gated deploy is how this job once skipped
  // silently for ever: the value had been added under Secrets, which the vars
  // context cannot read, and a skipped job looks identical to a healthy one.
  // Missing configuration must fail the job, not hide it.
  assert.ok(!/vars\./.test(deploy.split('steps:')[0].split('env:')[0]),
    'the deploy condition must not depend on a repository variable');

  // Two merges landing together must queue, not race or cancel each other.
  assert.match(deploy, /concurrency:/, 'deploy declares a concurrency group');
  assert.match(deploy, /cancel-in-progress:\s*false/,
    'an in-flight deployment is never cancelled halfway');

  // Credentials arrive as encrypted secrets, never as literals.
  for (const secret of ['CLASPRC_JSON', 'CLASP_JSON', 'APPS_SCRIPT_DEPLOYMENT_ID']) {
    assert.match(deploy, new RegExp(secret + ':\\s*\\$\\{\\{ secrets\\.' + secret + ' \\}\\}'),
      secret + ' comes from an encrypted secret');
  }
});

test('the repository commits no Apps Script manifest or clasp config', () => {
  // The manifest is pulled from the live project on every deploy. A committed
  // one could silently overwrite the running web-app access, executeAs,
  // timezone or scopes; a committed .clasp.json would publish the script id
  // and a .clasprc.json an OAuth refresh token.
  //
  // Tracked files only: the deploy job builds exactly these names under the
  // gitignored .clasp-work/, and those are the point rather than a violation.
  const forbidden = new Set(['appsscript.json', '.clasp.json', '.clasprc.json']);
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(tracked.status, 0, tracked.stderr);

  const offenders = tracked.stdout.split('\n')
    .filter(Boolean)
    .filter(file => forbidden.has(path.basename(file)));
  assert.deepStrictEqual(offenders, [],
    `clasp config must stay out of the repository: ${offenders.join(', ')}`);
});

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

// ------------------------------------------------- frontend delivery & session

/** The pages that are the signed-in web application. mini.html is not one. */
const WEB_APP_PAGES = ['omad_admin.html', 'cafe_admin.html', 'cafe_pos.html', 'tasks.html'];

test('no page compiles its stylesheet in the browser', () => {
  // cdn.tailwindcss.com is the Play CDN: it ships a compiler, scans the DOM and
  // generates the stylesheet on every load, on the cashier's phone. Tailwind's
  // own documentation says it is for development only, and it made the app
  // unstyled whenever the CDN was slow or blocked.
  const offenders = [];
  for (const file of walk(ROOT)) {
    if (path.extname(file) !== '.html') continue;
    if (fs.readFileSync(file, 'utf8').includes('cdn.tailwindcss.com')) offenders.push(relative(file));
  }
  assert.deepStrictEqual(offenders, [],
    `the Tailwind Play CDN is back in: ${offenders.join(', ')}`);
});

test('every page that uses Tailwind classes links the generated stylesheet', () => {
  const css = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'app.css'), 'utf8');
  assert.ok(css.length > 5000, 'the generated stylesheet is not a stub');

  // A handful the layouts cannot survive without. Not a substitute for looking
  // at the pages, but it catches a stylesheet regenerated from the wrong
  // content globs, which would otherwise be silently almost-empty.
  for (const utility of ['.hidden', '.flex', '.grid', '.font-bold', '.rounded-2xl']) {
    assert.ok(css.includes(utility + '{') || css.includes(utility + ','),
      `${utility} is missing from assets/css/app.css — run npm run build:css`);
  }

  for (const page of WEB_APP_PAGES.concat(['login.html'])) {
    const source = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.ok(source.includes('assets/css/app.css'), `${page} does not link the stylesheet`);
  }
});

test('every signed-in page loads the shared session module first', () => {
  // The session, the transport and what a failed request means live in one
  // file precisely so four screens cannot disagree about them. A page that
  // loads its own script first would be running before the guard.
  for (const page of WEB_APP_PAGES) {
    const blocks = pageScripts(path.join(ROOT, page));
    assert.ok(blocks.length > 0, `${page} runs no script at all`);
    assert.strictEqual(blocks[0].name, 'assets/session.js',
      `${page} runs ${blocks[0].name} before the session guard`);
  }
});

test('no signed-in page decides a permission for itself', () => {
  // The role in localStorage chooses which page renders and nothing else. A
  // page that branched on it for anything beyond that would be inviting the
  // reader to believe it is a permission, which it is not: the server checks
  // the role inside the signed token.
  for (const page of WEB_APP_PAGES) {
    const source = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.ok(!/omad_access_key/.test(source),
      `${page} still reads the stored admin key`);
  }
});

// ------------------------------------------------------------- syntax checks

test('script.gs parses as valid JavaScript', () => {
  const content = fs.readFileSync(path.join(ROOT, 'script.gs'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(content, { filename: 'script.gs' }));
});

test('every script an HTML page executes parses as valid JavaScript', () => {
  for (const file of walk(ROOT)) {
    if (path.extname(file) !== '.html') continue;
    for (const block of pageScripts(file)) {
      assert.doesNotThrow(
        () => new vm.Script(block.code, { filename: block.name }),
        `Syntax error in ${block.name} (referenced by ${relative(file)})`
      );
    }
  }
});

test('every Apps Script module parses as valid JavaScript', () => {
  for (const module of appsScriptModules()) {
    assert.doesNotThrow(
      () => new vm.Script(module.code, { filename: module.name }),
      `Syntax error in ${module.name}`
    );
  }
});

test('script.gs is the current build of apps-script/', () => {
  // The bundle is generated. A stale bundle means the deployed backend does
  // not match the reviewed source.
  const result = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'build-apps-script.js'), '--check'],
    { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
});

test('script.gs is marked as generated so nobody edits it by hand', () => {
  const head = fs.readFileSync(path.join(ROOT, 'script.gs'), 'utf8').slice(0, 400);
  assert.match(head, /GENERATED FILE - DO NOT EDIT/);
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

test('the generated script.gs has no duplicate function definitions', () => {
  const content = fs.readFileSync(path.join(ROOT, 'script.gs'), 'utf8');
  assert.deepStrictEqual(duplicatesIn(functionNames(content)), []);
});

test('no function name is defined in two Apps Script modules', () => {
  // Apps Script modules share one global scope, so a name defined twice means
  // one definition silently wins.
  const names = appsScriptModules().flatMap(m => functionNames(m.code));
  assert.deepStrictEqual(duplicatesIn(names), []);
});

test('no HTML page defines the same function twice across all its scripts', () => {
  // Every script a page loads shares one global scope. A repeated definition
  // means the later one silently shadows the earlier - exactly the café
  // close-day bug this suite used to allowlist.
  for (const file of walk(ROOT)) {
    if (path.extname(file) !== '.html') continue;
    const names = pageScripts(file).flatMap(block => functionNames(block.code));
    assert.deepStrictEqual(
      duplicatesIn(names), [],
      `Duplicate function definitions in ${relative(file)}`
    );
  }
});

test('the deploy guard only excuses functions the repository really has dropped', () => {
  // RETIRED_FUNCTIONS lets a deliberate removal through a guard whose whole
  // job is to stop clasp deleting live code. An entry naming a function that
  // still exists would silently disarm the guard for it, so the list is held
  // to being exactly what it claims: names that are gone.
  const deploy = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'clasp-deploy.js'), 'utf8');
  const block = /const RETIRED_FUNCTIONS = \{([\s\S]*?)\n\};/.exec(deploy);
  assert.ok(block, 'the retired-function list is where the guard reads it from');

  const names = Array.from(block[1].matchAll(/'([A-Za-z_$][\w$]*)'\s*:/g)).map(m => m[1]);
  assert.ok(names.length > 0, 'the list parses');

  const sources = fs.readdirSync(path.join(__dirname, '..', 'apps-script'))
    .filter(f => f.endsWith('.gs'))
    .map(f => fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8'))
    .join('\n');

  names.forEach(name => {
    const declared = new RegExp(`function\\s+${name.replace(/\$/g, '\\$')}\\s*\\(`).test(sources);
    assert.ok(!declared,
      `${name} is listed as retired but is still declared in apps-script/ — the guard would ignore it being deleted`);
  });
});
