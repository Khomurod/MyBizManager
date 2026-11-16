#!/usr/bin/env node
'use strict';

/**
 * Deploys the Edge function `api` (supabase/functions/api) to one Supabase
 * project, then checks that the deployed function answers as this code.
 *
 *   SUPABASE_ACCESS_TOKEN  a personal access token (GitHub secret of that name)
 *   SUPABASE_PROJECT_REF   the project: the test one from branches, the live
 *                          one from main (.github/workflows/ci.yml)
 *
 *   node scripts/edge-deploy.js           build, deploy, check
 *   node scripts/edge-deploy.js --check   only the check
 *
 * Fails closed, naming what is missing, like the Apps Script deploy.
 *
 * Deploying the function changes nothing the application does by itself: the
 * function serves a request only when app_properties says so (the ready
 * marker and EDGE_NATIVE_ACTIONS) and forwards everything else to Apps Script.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/** Pinned, like clasp and Playwright: a CLI release must not change a deploy unannounced. */
const SUPABASE_CLI = 'supabase@2.122.1';
const FUNCTION_NAME = 'api';
/** Next to the database (us-east-1), as the frontend calls it. */
const REGION = 'us-east-1';

function fail(message) {
  console.error('edge deploy: ' + message);
  process.exit(1);
}

function run(command, args, options) {
  console.log('$ ' + [command].concat(args).join(' '));
  return spawnSync(command, args, Object.assign({ cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, options));
}

function preflight(deploying) {
  const ref = String(process.env.SUPABASE_PROJECT_REF || '').trim();
  if (!/^[a-z]{20}$/.test(ref)) fail('SUPABASE_PROJECT_REF is missing or is not a project ref (20 lowercase letters).');
  if (deploying && !String(process.env.SUPABASE_ACCESS_TOKEN || '').trim()) {
    fail('the SUPABASE_ACCESS_TOKEN secret is not set for this workflow (Settings -> Secrets and variables -> Actions).');
  }
  return ref;
}

function deploy(ref) {
  // runtime.js is generated from script.gs and not committed.
  const build = run(process.execPath, ['scripts/build-apps-script.js'], { stdio: 'inherit' });
  if (build.status !== 0) fail('the build failed.');

  const base = ['--yes', SUPABASE_CLI, 'functions', 'deploy', FUNCTION_NAME, '--project-ref', ref, '--no-verify-jwt'];
  // Bundled by the platform rather than in Docker; an older CLI without the
  // flag bundles in Docker, which the runner also has.
  let result = run('npx', base.concat(['--use-api']));
  if (result.status !== 0 && /unknown flag/i.test(String(result.stderr))) result = run('npx', base);
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) fail('supabase functions deploy failed (exit ' + result.status + ').');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The function answers, as this code, from the database's region, with CORS for the browser. */
async function check(ref) {
  const url = 'https://' + ref + '.supabase.co/functions/v1/' + FUNCTION_NAME + '?forceFunctionRegion=' + REGION;
  let last = '';
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(url + '&probe=1', { signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      let probe = null;
      try { probe = JSON.parse(text); } catch (error) { probe = null; }
      if (res.ok && probe && probe.runtime === 'edge' && res.headers.get('x-mbm-runtime') === 'edge') {
        const options = await fetch(url, { method: 'OPTIONS', signal: AbortSignal.timeout(20000) });
        if (options.headers.get('access-control-allow-origin') !== '*') fail('OPTIONS does not answer CORS.');
        console.log('edge deploy: the function answers: ' + JSON.stringify({
          region: probe.region || res.headers.get('x-sb-edge-region') || '',
          ready: probe.ready, allow: probe.allow, forwardsTo: probe.forwardsTo, configRead: probe.configRead
        }));
        if (!probe.configRead) {
          console.log('edge deploy: note: app_properties could not be read (migration 20261116120000 not applied yet?); ' +
            'until it is, the function serves nothing itself.');
        }
        return;
      }
      last = 'HTTP ' + res.status + ': ' + text.slice(0, 200);
    } catch (error) {
      last = String(error && error.message || error);
    }
    await sleep(attempt * 3000);
  }
  fail('the deployed function does not answer as expected: ' + last);
}

(async () => {
  const deploying = !process.argv.includes('--check');
  const ref = preflight(deploying);
  if (deploying) deploy(ref);
  await check(ref);
})().catch(error => fail(String(error && error.stack || error)));
