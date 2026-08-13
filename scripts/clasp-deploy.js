#!/usr/bin/env node
'use strict';

/**
 * Prepares and completes an Apps Script deployment driven by clasp.
 *
 *   node scripts/clasp-deploy.js preflight   validate config, write credentials
 *   node scripts/clasp-deploy.js stage       combine the live manifest + modules
 *   node scripts/clasp-deploy.js release     create a version, move the deployment
 *
 * The workflow interleaves these with the clasp commands themselves, so the
 * Actions log reads as the sequence it actually is:
 *
 *   preflight -> clasp pull -> stage -> clasp show-file-status -> clasp push
 *             -> release
 *
 * Three rules shape everything here.
 *
 * 1. The live project's own `appsscript.json` is authoritative. It is pulled
 *    from the running project and copied through byte for byte; the repository
 *    deliberately does not contain a manifest, so there is nothing stale that
 *    could overwrite the live web-app settings, timezone or scopes.
 *
 * 2. `clasp push` replaces the remote project's contents rather than merging
 *    into them, so anything live that the push does not carry is deleted. Both
 *    `assertNoUnsupportedRemoteFiles` and `assertNoRemoteDrift` exist to turn
 *    that from a silent data loss into a failed build.
 *
 * 3. Nothing secret is ever printed. Ids are masked, credentials are written to
 *    disk and never echoed, and the preflight reports presence rather than
 *    values.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'apps-script');
const WORK_DIR = path.join(ROOT, '.clasp-work');
const PULL_DIR = path.join(WORK_DIR, 'pull');
const PUSH_DIR = path.join(WORK_DIR, 'push');
const MANIFEST = 'appsscript.json';

// Mirrors clasp's own default list, which is written the same allowlist way:
// exclude everything, then re-include exactly the file types a project holds.
const CLASPIGNORE = [
  '**/**',
  '!' + MANIFEST,
  '!*.gs',
  '.git/**',
  'node_modules/**'
].join('\n') + '\n';

// clasp writes server-side code back as .js on pull; the repo keeps .gs.
const SERVER_JS_EXTENSIONS = ['.js', '.gs'];

function fail(message, hint) {
  console.error('✗ ' + message);
  if (hint) console.error('  ' + hint);
  process.exit(1);
}

/** Enough of an id to recognise, never enough to use. */
function mask(value) {
  const text = String(value || '');
  if (text.length <= 12) return '…';
  return text.slice(0, 6) + '…' + text.slice(-6);
}

function readEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value : '';
}

function parseJsonEnv(name) {
  const raw = readEnv(name);
  if (!raw) {
    fail(`${name} is not set.`,
      'Deployment is configured through GitHub encrypted secrets; see docs/DEPLOYMENT.md.');
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    // Deliberately not echoing the value or the parser's excerpt of it.
    fail(`${name} is not valid JSON.`, 'Re-copy the file contents into the secret verbatim.');
  }
}

/** Parses a JSON secret without exiting, so every problem can be collected. */
function tryParseJsonEnv(name) {
  const raw = readEnv(name);
  if (!raw) return { problem: `${name} is not set — add it as a repository secret.` };
  try {
    return { value: JSON.parse(raw) };
  } catch (error) {
    return { problem: `${name} is not valid JSON — re-copy the file contents verbatim.` };
  }
}

/** The `.clasp.json` clasp should use, regenerated rather than trusted. */
function writeProjectConfig(dir, scriptId, projectId) {
  fs.mkdirSync(dir, { recursive: true });
  const config = { scriptId: scriptId, rootDir: '.' };
  if (projectId) config.projectId = projectId;
  fs.writeFileSync(path.join(dir, '.clasp.json'), JSON.stringify(config, null, 2) + '\n');
}

function moduleFiles() {
  return fs.readdirSync(SRC_DIR).filter(name => name.endsWith('.gs')).sort();
}

/**
 * Adds markdown to the run's summary page, so the outcome is legible without
 * opening the log. A no-op outside Actions; the log always carries the same
 * facts in plain text.
 */
function writeStepSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, lines.join('\n') + '\n');
}

// ------------------------------------------------------------------ preflight

/**
 * Fails closed unless everything a deployment needs is present, then writes the
 * credential file and the config `clasp pull` will run against.
 *
 * Every secret is checked before anything exits, so one run tells the operator
 * the whole list rather than one item per round trip — which matters because
 * the only way to retry is another deployment run. The report goes to the step
 * summary too, so a failure is legible from the run page without opening logs.
 * Nothing sensitive is printed: presence, and ids masked to their ends.
 */
function preflight() {
  const clasprc = tryParseJsonEnv('CLASPRC_JSON');
  const claspJson = tryParseJsonEnv('CLASP_JSON');
  const deploymentId = readEnv('APPS_SCRIPT_DEPLOYMENT_ID').trim();
  const problems = [];
  const status = [];

  if (clasprc.problem) {
    problems.push(clasprc.problem);
    status.push(['CLASPRC_JSON', '❌ missing or unreadable']);
  } else if (!(clasprc.value &&
      (clasprc.value.tokens || clasprc.value.token || clasprc.value.access_token))) {
    problems.push('CLASPRC_JSON does not look like a clasp credentials file — ' +
      'run `clasp login` locally and copy ~/.clasprc.json verbatim.');
    status.push(['CLASPRC_JSON', '❌ not a clasp credentials file']);
  } else {
    status.push(['CLASPRC_JSON', '✅ present']);
  }

  let scriptId = '';
  if (claspJson.problem) {
    problems.push(claspJson.problem);
    status.push(['CLASP_JSON', '❌ missing or unreadable']);
  } else {
    scriptId = String((claspJson.value || {}).scriptId || '').trim();
    if (!scriptId) {
      problems.push('CLASP_JSON has no "scriptId" — copy the .clasp.json of the existing project.');
      status.push(['CLASP_JSON', '❌ no scriptId']);
    } else {
      status.push(['CLASP_JSON', '✅ script ' + mask(scriptId)]);
    }
  }

  if (!deploymentId) {
    problems.push('APPS_SCRIPT_DEPLOYMENT_ID is not set — it must be the id of the deployment ' +
      'already serving production, so its URL is preserved.');
    status.push(['APPS_SCRIPT_DEPLOYMENT_ID', '❌ missing']);
  } else {
    status.push(['APPS_SCRIPT_DEPLOYMENT_ID', '✅ ' + mask(deploymentId)]);
  }

  console.log('Deployment preflight');
  status.forEach(([name, state]) => console.log('  ' + name.padEnd(26) + state));
  writeStepSummary(['### Deployment preflight', '', '| Setting | State |', '|---|---|']
    .concat(status.map(([name, state]) => '| `' + name + '` | ' + state + ' |'))
    .concat(['']));

  if (problems.length) {
    console.error('');
    problems.forEach(problem => console.error('✗ ' + problem));
    console.error('  All three are repository secrets: Settings → Secrets and variables → ' +
      'Actions → Secrets. See docs/DEPLOYMENT.md.');
    process.exit(1);
  }

  fs.writeFileSync(path.join(os.homedir(), '.clasprc.json'),
    JSON.stringify(clasprc.value), { mode: 0o600 });
  writeProjectConfig(PULL_DIR, scriptId, claspJson.value.projectId);

  console.log('  credentials written to ~/.clasprc.json (mode 600)');
  console.log('  ' + moduleFiles().length + ' modules under apps-script/ will be uploaded');
}

// ---------------------------------------------------------------------- stage

function listPulled() {
  if (!fs.existsSync(PULL_DIR)) {
    fail('Nothing was pulled from the live project.', 'The `clasp pull` step must run before `stage`.');
  }
  return fs.readdirSync(PULL_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
}

/**
 * Refuses to push when the live project holds a kind of file this deployment
 * does not produce - an HTML template, say. Pushing would delete it.
 */
function assertNoUnsupportedRemoteFiles(pulled) {
  const unsupported = pulled.filter(name =>
    name !== MANIFEST && SERVER_JS_EXTENSIONS.indexOf(path.extname(name)) === -1);
  if (unsupported.length === 0) return;
  fail('The live project contains files this deployment cannot reproduce: ' + unsupported.join(', '),
    'clasp push replaces remote contents, so these would be deleted. Resolve them before deploying.');
}

/** Top-level `function name(` declarations, the same way static analysis reads them. */
function functionNames(code) {
  const names = new Set();
  const pattern = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = pattern.exec(code)) !== null) names.add(match[1]);
  return names;
}

/**
 * Functions deliberately removed from the repository, and why.
 *
 * A removal that was meant looks exactly like the accident this guard exists
 * to catch, so it is named here rather than waved through with the blanket
 * APPS_SCRIPT_ALLOW_REMOTE_DRIFT flag: everything not on this list still stops
 * the deploy, which is the point of the guard.
 *
 * Entries become inert once the push that removes them has run - the function
 * is no longer in the live project, so it can no longer appear as drift - and
 * can be deleted at any later tidy-up.
 */
const RETIRED_FUNCTIONS = {
  // Replaced by resolveReportGroupFrom_, which picks the group out of rows the
  // caller has already read. The old one fetched the whole ledger for itself
  // and the caller then fetched it again for the balances -- two full passes
  // per report, and a report is queued for every accounting entry.
  'resolveReportGroup_': 'replaced by resolveReportGroupFrom_',
  // Split into per-action gates in doPost when the three web roles became real.
  // One function answering verify_access, get_omad_data and get_cafe_data meant
  // one permission level for all three, which is exactly what a café seller
  // must not have.
  'authenticatedReadAction_': 'replaced by per-action role gates in doPost'
};

/**
 * Proves the modular sources comprehensively represent what is running.
 *
 * Because a push replaces rather than merges, a function that exists only in
 * the live project - someone editing the web IDE directly - would be deleted
 * without trace. Comparing declared function names is cheap, needs no
 * formatting-insensitive diff, and catches exactly that case.
 */
function assertNoRemoteDrift(pulled) {
  const remote = new Set();
  for (const name of pulled) {
    if (SERVER_JS_EXTENSIONS.indexOf(path.extname(name)) === -1) continue;
    functionNames(fs.readFileSync(path.join(PULL_DIR, name), 'utf8'))
      .forEach(fn => remote.add(fn));
  }

  const local = new Set();
  for (const name of moduleFiles()) {
    functionNames(fs.readFileSync(path.join(SRC_DIR, name), 'utf8'))
      .forEach(fn => local.add(fn));
  }

  const gone = Array.from(remote).filter(fn => !local.has(fn)).sort();
  const retired = gone.filter(fn => Object.prototype.hasOwnProperty.call(RETIRED_FUNCTIONS, fn));
  const missing = gone.filter(fn => !Object.prototype.hasOwnProperty.call(RETIRED_FUNCTIONS, fn));
  const added = Array.from(local).filter(fn => !remote.has(fn)).sort();

  console.log('  remote functions ' + remote.size + ', repository functions ' + local.size);
  if (added.length) console.log('  new in this push ' + added.length + ': ' + added.slice(0, 10).join(', ') +
    (added.length > 10 ? ', …' : ''));
  if (retired.length) console.log('  retiring ' + retired.length + ' on purpose: ' +
    retired.map(fn => fn + ' (' + RETIRED_FUNCTIONS[fn] + ')').join(', '));

  if (missing.length === 0) return;
  const summary = missing.slice(0, 20).join(', ') + (missing.length > 20 ? ', …' : '');
  if (process.env.APPS_SCRIPT_ALLOW_REMOTE_DRIFT === 'true') {
    console.log('  ! drift accepted by APPS_SCRIPT_ALLOW_REMOTE_DRIFT: ' + summary);
    return;
  }
  fail(`The live project defines ${missing.length} function(s) the repository does not: ${summary}`,
    'Pushing would delete them. Port them into apps-script/ first, or set the repository ' +
    'variable APPS_SCRIPT_ALLOW_REMOTE_DRIFT=true if they are genuinely obsolete.');
}

/**
 * Builds the directory clasp will push: the live manifest, unchanged, plus
 * every module in the repository, and nothing whatsoever besides.
 */
function stage() {
  const claspJson = parseJsonEnv('CLASP_JSON');
  const pulled = listPulled();

  console.log('Live project contents');
  pulled.forEach(name => console.log('  ' + name));

  if (pulled.indexOf(MANIFEST) === -1) {
    fail('The live project did not return an ' + MANIFEST + '.',
      'Refusing to invent a manifest: that would overwrite the running web-app settings.');
  }
  assertNoUnsupportedRemoteFiles(pulled);
  assertNoRemoteDrift(pulled);

  fs.rmSync(PUSH_DIR, { recursive: true, force: true });
  fs.mkdirSync(PUSH_DIR, { recursive: true });

  // Copied, never generated: whatever the live project says its manifest is,
  // is what goes back.
  fs.copyFileSync(path.join(PULL_DIR, MANIFEST), path.join(PUSH_DIR, MANIFEST));

  const modules = moduleFiles();
  for (const name of modules) {
    fs.copyFileSync(path.join(SRC_DIR, name), path.join(PUSH_DIR, name));
  }

  writeProjectConfig(PUSH_DIR, String(claspJson.scriptId || '').trim(), claspJson.projectId);
  fs.writeFileSync(path.join(PUSH_DIR, '.claspignore'), CLASPIGNORE);

  console.log('Staged for upload');
  console.log('  ' + MANIFEST + ' (taken from the live project, unchanged)');
  modules.forEach(name => console.log('  ' + name));
  console.log('  ' + (modules.length + 1) + ' files total; no HTML, tests, docs or script.gs');
}

// -------------------------------------------------------------------- release

/**
 * Runs clasp in the staging directory.
 *
 * A failure here is almost always an expired refresh token or the Apps Script
 * API being off for the account, and clasp reports both as an unhandled stack
 * trace. Turning that into one actionable line matters: this runs unattended,
 * and the person reading the log later is looking for what to fix.
 */
function clasp(args) {
  const binary = path.join(ROOT, 'node_modules', '.bin', 'clasp');
  try {
    return execFileSync(binary, args, { cwd: PUSH_DIR, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim().split('\n').slice(-3).join(' ');
    fail(`clasp ${args.filter(a => !a.startsWith('-')).join(' ')} failed.`,
      detail + ' — check CLASPRC_JSON is current and the Apps Script API is enabled.');
  }
}

/** The last JSON object a clasp command printed, past any spinner output. */
function parseClaspJson(output, command) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end === -1) fail(`clasp ${command} produced no JSON output.`);
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch (error) {
    fail(`Could not read the result of clasp ${command}.`);
  }
}

/**
 * Freezes this commit as an immutable Apps Script version and moves the
 * existing deployment on to it.
 *
 * `update-deployment` against the id already serving production is what keeps
 * the web-app URL - and with it the Telegram webhook and every Script Property
 * attached to the project - exactly as it was. A new deployment would mint a
 * URL nothing calls.
 */
function release() {
  const deploymentId = readEnv('APPS_SCRIPT_DEPLOYMENT_ID');
  if (!deploymentId) fail('APPS_SCRIPT_DEPLOYMENT_ID is not set.');
  const sha = readEnv('GITHUB_SHA') || 'local';
  const shortSha = sha.slice(0, 7);
  // A commit message is free-form and often multi-line; a version description
  // is one line. Taking the subject keeps the Apps Script version list
  // readable and the value is passed as an argv entry, never through a shell.
  const subject = readEnv('COMMIT_SUBJECT').split('\n')[0].trim();
  const description = ('GitHub ' + shortSha + ' ' + subject).trim().slice(0, 200);

  const version = parseClaspJson(clasp(['--json', 'create-version', description]), 'create-version');
  const versionNumber = Number(version.versionNumber);
  if (!Number.isFinite(versionNumber) || versionNumber <= 0) {
    fail('clasp create-version did not return a version number.');
  }

  const deployed = parseClaspJson(
    clasp(['--json', 'update-deployment', '-V', String(versionNumber), '-d', description, deploymentId]),
    'update-deployment');

  if (String(deployed.deploymentId) !== deploymentId) {
    fail('clasp redeployed a different deployment than the one requested.',
      'Expected ' + mask(deploymentId) + ', got ' + mask(deployed.deploymentId) + '.');
  }

  console.log('Deployed commit ' + shortSha + ' as version ' + versionNumber +
    ' on deployment ' + mask(deploymentId) + ' (unchanged — same URL).');
  writeStepSummary([
    '### Apps Script deployed',
    '',
    '| | |',
    '|---|---|',
    '| Commit | `' + shortSha + '` |',
    '| Version | `' + versionNumber + '` |',
    '| Deployment | `' + mask(deploymentId) + '` (unchanged — same URL) |',
    '',
    'Script Properties, the Telegram webhook and the web-app URL were not touched.',
    ''
  ]);
}

const command = process.argv[2];
if (command === 'preflight') preflight();
else if (command === 'stage') stage();
else if (command === 'release') release();
else fail('Usage: clasp-deploy.js preflight|stage|release');
