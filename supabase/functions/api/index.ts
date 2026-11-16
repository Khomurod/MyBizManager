// Supabase Edge function `api`: the MyBizManager backend, next to its database.
//
// The backend is the Apps Script code itself (apps-script/*.gs, bundled as
// script.gs and wrapped by scripts/edge-runtime.js into runtime.js). This file
// only receives the HTTP request, decides who answers it (lib/routing.js) and
// turns the answer back into HTTP:
//
//   - answered here: the request runs through the replay executor
//     (lib/executor.js) over the Edge stand-ins for the Apps Script services
//     (lib/gas-shims.js) -- the same doPost, the same business rules, the same
//     database, without Apps Script's start-up time;
//   - forwarded: the body goes to the Apps Script web app unchanged, and its
//     answer comes back unchanged. That is every request until the settings
//     have moved into the database, and always the actions only Apps Script
//     can serve.
//
// Endpoints (all on /functions/v1/api, `?forceFunctionRegion=us-east-1` keeps
// it next to the database):
//   POST            the API, and the Telegram webhook (?wh=<secret>)
//   GET             the inert banner Apps Script's doGet answers; ?probe=1 says
//                   which region and which switches this deployment sees
//   POST ?job=telegram-jobs   the five-minute job, called by pg_cron with the
//                   x-mbm-cron header (EDGE_CRON_SECRET in app_properties)
//   POST ?job=db-backup       the nightly copy into Google Drive: passed on to
//                   Apps Script (run_database_backup) with the same secret
//
// Deployed with verify_jwt off: the backend authenticates every request
// itself (session tokens, Telegram initData, the webhook secret), exactly as
// it does on Apps Script.

import './lib/sha256.js';
import './lib/zoned-date.js';
import './lib/gas-shims.js';
import './lib/executor.js';
import './lib/routing.js';
import './runtime.js';

// deno-lint-ignore no-explicit-any
type Any = any;

const G = globalThis as Any;
const Executor = G.MBMExecutor;
const Shims = G.MBMGasShims;
const Routing = G.MBMRouting;
const createRuntime = G.MBMRuntime;

const SUPABASE_URL = String(Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
const SECRET_KEY = readSecretKey();
const FUNCTION_URL = SUPABASE_URL + '/functions/v1/api';
const REGION = Deno.env.get('SB_REGION') || '';

/** How long one isolate trusts the switches it read (EDGE_NATIVE_ACTIONS, the ready marker). */
const CONFIG_TTL_MS = Number(Deno.env.get('MBM_CONFIG_TTL_MS') || 15000);
/** A database or Telegram call that has not answered by now is treated as failed, as UrlFetchApp does. */
const FETCH_TIMEOUT_MS = 30000;
/** Apps Script can take a while to start; it is still the right answer for what it serves. */
const FORWARD_TIMEOUT_MS = 120000;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  // The browser falls back to Apps Script only for an answer that did not come
  // from this code (the platform's own error pages carry no such header), or
  // that says nothing was done ('unconfigured': no Apps Script address yet).
  'Access-Control-Expose-Headers': 'X-MBM-Runtime',
  'Access-Control-Max-Age': '86400'
};

/** The project's secret key: a named one we were given, else the platform's default. */
function readSecretKey(): string {
  const own = Deno.env.get('MBM_SUPABASE_SECRET_KEY');
  if (own) return own;
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (keys) {
    try {
      const parsed = JSON.parse(keys);
      if (parsed && parsed['default']) return String(parsed['default']);
      const first = Object.values(parsed || {})[0];
      if (first) return String(first);
    } catch (_error) {
      // fall through to the legacy key
    }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
}

function dbHeaders(): Record<string, string> {
  const headers: Record<string, string> = { apikey: SECRET_KEY, Accept: 'application/json' };
  if (/^eyJ/.test(SECRET_KEY)) headers.Authorization = 'Bearer ' + SECRET_KEY;
  return headers;
}

/**
 * An error's text, safe to log or to hand back: a failed fetch names its URL,
 * which can carry the bot token or the webhook secret (Executor.redact).
 */
function errorText(error: unknown): string {
  return Executor.redact(String((error as Error)?.message || error));
}

// ------------------------------------------------------------- switches

type Config = { ready: boolean; allow: string; appsScriptUrl: string; cronSecret: string; at: number; ok: boolean };

let cachedConfig: Config | null = null;
let loadingConfig: Promise<Config> | null = null;

async function readConfig(): Promise<Config> {
  if (cachedConfig && Date.now() - cachedConfig.at < (cachedConfig.ok ? CONFIG_TTL_MS : Math.min(CONFIG_TTL_MS, 2000))) return cachedConfig;
  if (!loadingConfig) {
    loadingConfig = loadConfig().finally(() => { loadingConfig = null; });
  }
  return await loadingConfig;
}

async function loadConfig(): Promise<Config> {
  const keys = [Routing.READY_KEY, Routing.ALLOW_KEY, 'EDGE_APPS_SCRIPT_URL', 'EDGE_CRON_SECRET'];
  const list = keys.map((key: string) => '"' + key + '"').join(',');
  const fallbackUrl = Deno.env.get('APPS_SCRIPT_URL') || '';
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/app_properties?select=key,value&key=in.(' + encodeURIComponent(list) + ')', {
      headers: dbHeaders(),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) throw new Error('app_properties answered HTTP ' + res.status);
    const rows = await res.json() as Array<{ key: string; value: string }>;
    const map: Record<string, string> = {};
    rows.forEach(row => { map[row.key] = row.value; });
    cachedConfig = {
      ready: !!map[Routing.READY_KEY],
      allow: map[Routing.ALLOW_KEY] || '',
      appsScriptUrl: map.EDGE_APPS_SCRIPT_URL || fallbackUrl,
      cronSecret: map.EDGE_CRON_SECRET || '',
      at: Date.now(),
      ok: true
    };
  } catch (error) {
    // The database cannot say what is allowed: serve nothing here. Apps
    // Script answers -- or fails the same way, since it uses the same database.
    console.error('config:', errorText(error));
    cachedConfig = { ready: false, allow: '', appsScriptUrl: fallbackUrl, cronSecret: '', at: Date.now(), ok: false };
  }
  return cachedConfig;
}

// ------------------------------------------------------------- the I/O

type Answer = { code?: number; text?: string; headers?: Record<string, string>; transportError?: string };
type Work = { kind: 'fetch'; request: Any } | { kind: 'fetchAll'; requests: Any[] };

/** One request the backend asked for, done for real. Never throws: a failure is part of the answer. */
async function doFetch(request: Any): Promise<Answer> {
  try {
    const res = await fetch(request.url, {
      method: String(request.method || 'get').toUpperCase(),
      headers: request.headers || {},
      body: request.body === null || request.body === undefined ? undefined : request.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => { headers[name] = value; });
    return { code: res.status, text, headers };
  } catch (error) {
    const host = (() => { try { return new URL(request.url).host; } catch (_e) { return 'the server'; } })();
    return { transportError: 'Exception: ' + errorText(error) + ' (' + host + ')' };
  }
}

function perform(work: Work): Promise<Answer | Answer[]> {
  if (work.kind === 'fetchAll') return Promise.all(work.requests.map(doFetch));
  return doFetch(work.request);
}

/** Runs one backend entry point to completion. */
async function runNative(entry: string, event: unknown) {
  const tape = Executor.createTape();
  const env = { supabaseUrl: SUPABASE_URL, supabaseKey: SECRET_KEY, publicUrl: FUNCTION_URL, console };
  try {
    return await Executor.run({
      tape,
      makeGlobals: (ctx: Any) => Shims.createEdgeGlobals(ctx, env),
      invoke: (globals: Any) => createRuntime(globals)[entry](event),
      perform,
      // One after another, as Apps Script sent them: a put and a remove of the
      // same cache key must not land in the other order.
      performDeferred: async (requests: Work[]) => {
        for (const request of requests) await perform(request);
      }
    });
  } finally {
    // A run that failed between taking the lock and releasing it must not
    // make everybody else wait for the lease to expire.
    for (const owner of Executor.leasesLeftHeld(tape)) {
      await doFetch({
        url: SUPABASE_URL + '/rest/v1/rpc/mbm_unlock', method: 'post',
        headers: Object.assign({ 'Content-Type': 'application/json' }, dbHeaders()),
        body: JSON.stringify({ p_owner: owner })
      });
    }
  }
}

// ------------------------------------------------------------- HTTP

function json(body: unknown, status = 200, runtime = 'edge'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'X-MBM-Runtime': runtime }, CORS)
  });
}

/** ContentService / HtmlService output as an HTTP response. */
function fromOutput(output: Any): Response {
  if (output && typeof output.__text === 'string') {
    const isJson = output.__mime === 'application/json';
    return new Response(output.__text, {
      status: 200,
      headers: Object.assign({
        'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
        'X-MBM-Runtime': 'edge'
      }, CORS)
    });
  }
  // HtmlService: only ever "OK" for Telegram. Served as text, not HTML.
  const text = output && typeof output.__html === 'string' ? output.__html : '';
  return new Response(text, { status: 200, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'X-MBM-Runtime': 'edge' }, CORS) });
}

function eventFor(url: URL, bodyText: string, contentType: string) {
  const parameter: Record<string, string> = {};
  const parameters: Record<string, string[]> = {};
  url.searchParams.forEach((value, name) => {
    if (!(name in parameter)) parameter[name] = value;
    (parameters[name] = parameters[name] || []).push(value);
  });
  return {
    parameter,
    parameters,
    queryString: url.search.replace(/^\?/, ''),
    contentLength: bodyText.length,
    postData: { contents: bodyText, length: bodyText.length, type: contentType, name: 'postData' }
  };
}

async function forward(method: string, url: URL, bodyText: string, config: Config): Promise<Response> {
  if (!config.appsScriptUrl) {
    // Nothing was done: the browser may send this one to Apps Script itself.
    return json({ status: 'error', message: 'Apps Script manzili sozlanmagan (EDGE_APPS_SCRIPT_URL).' }, 503, 'unconfigured');
  }
  const target = new URL(config.appsScriptUrl);
  url.searchParams.forEach((value, name) => {
    if (name !== 'forceFunctionRegion') target.searchParams.append(name, value);
  });
  const res = await fetch(target, {
    method,
    body: method === 'POST' ? bodyText : undefined,
    headers: method === 'POST' ? { 'Content-Type': 'text/plain;charset=utf-8' } : undefined,
    redirect: 'follow',
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS)
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: Object.assign({
      'Content-Type': res.headers.get('content-type') || 'application/json; charset=utf-8',
      'X-MBM-Runtime': 'apps-script'
    }, CORS)
  });
}

function sameSecret(given: string, expected: string): boolean {
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function handleJob(req: Request, url: URL): Promise<Response> {
  const config = await readConfig();
  if (!sameSecret(req.headers.get('x-mbm-cron') || '', config.cronSecret)) {
    return json({ status: 'error', message: 'forbidden' }, 403);
  }
  const job = url.searchParams.get('job');
  if (job === 'db-backup') {
    // The nightly copy into Google Drive is Apps Script's to write; this only
    // passes pg_cron's call on, with the same secret as its proof.
    const started = Date.now();
    try {
      const res = await forward('POST', new URL('http://job.local/'),
        JSON.stringify({ action: 'run_database_backup', cronSecret: config.cronSecret }), config);
      console.log(JSON.stringify({ job, runtime: 'apps-script', status: res.status, ms: Date.now() - started }));
      return res;
    } catch (error) {
      console.error(JSON.stringify({ job, ms: Date.now() - started, fatal: errorText(error) }));
      return json({ status: 'error', message: 'Apps Script javob bermadi.' }, 502, 'apps-script');
    }
  }
  if (job !== 'telegram-jobs') return json({ status: 'error', message: 'unknown job' }, 404);
  if (!Routing.jobsRunHere(config)) return json({ status: 'skipped', reason: 'the jobs run in Apps Script' });
  const started = Date.now();
  const out = await runNative('runTimedJobs_', undefined);
  console.log(JSON.stringify({ job: 'telegram-jobs', runs: out.runs, ios: out.ios, ms: Date.now() - started, error: out.error ? errorText(out.error) : undefined }));
  if (out.error) return json({ status: 'error', message: errorText(out.error) }, 500);
  return json({ status: 'success', result: out.result === undefined ? null : out.result, runs: out.runs, ios: out.ios });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (req.method === 'GET') {
    if (url.searchParams.get('probe') === '1') {
      const config = await readConfig();
      return json({
        runtime: 'edge', region: REGION, ready: config.ready, allow: config.allow,
        forwardsTo: config.appsScriptUrl ? new URL(config.appsScriptUrl).host : '', configRead: config.ok,
        version: Deno.env.get('DENO_DEPLOYMENT_ID') || ''
      });
    }
    const out = await runNative('doGet', eventFor(url, '', ''));
    return out.error ? json({ status: 'error', message: errorText(out.error) }, 500) : fromOutput(out.result);
  }

  if (req.method !== 'POST') return json({ status: 'error', message: 'Method not allowed' }, 405);
  if (url.searchParams.has('job')) return await handleJob(req, url);

  const bodyText = await req.text();
  const config = await readConfig();
  const request = Routing.describe(bodyText);
  const label = request.telegram ? 'telegram' : (request.action || '(none)');
  const started = Date.now();

  if (Routing.routePost(bodyText, config) !== 'edge') {
    try {
      const forwarded = await forward('POST', url, bodyText, config);
      console.log(JSON.stringify({ action: label, runtime: 'apps-script', status: forwarded.status, ms: Date.now() - started }));
      return forwarded;
    } catch (error) {
      // Apps Script may have done the work and only the answer was lost, so
      // this is a refusal the browser shows, not a failure it retries.
      console.error(JSON.stringify({ action: label, runtime: 'apps-script', ms: Date.now() - started, fatal: errorText(error) }));
      if (request.telegram) return fromOutput({ __html: 'OK' });
      return json({ status: 'error', message: "Apps Script javob bermadi. Bir ozdan keyin qayta urinib ko'ring." }, 200, 'apps-script');
    }
  }

  try {
    const out = await runNative('doPost', eventFor(url, bodyText, req.headers.get('content-type') || 'text/plain'));
    console.log(JSON.stringify({ action: label, runtime: 'edge', runs: out.runs, ios: out.ios, ms: Date.now() - started, error: out.error ? errorText(out.error) : undefined }));
    if (out.error) {
      // doPost answers its own failures; reaching here is a fault of the runtime.
      if (request.telegram) return fromOutput({ __html: 'OK' });
      return json({ status: 'error', message: 'Edge: ' + errorText(out.error) });
    }
    return fromOutput(out.result);
  } catch (error) {
    // The executor itself gave up (a divergence, too many runs). Answered as a
    // refusal, not a 5xx, so the browser does not repeat the request on Apps
    // Script after part of it may have been done here.
    console.error(JSON.stringify({ action: label, runtime: 'edge', ms: Date.now() - started, fatal: errorText(error) }));
    if (request.telegram) return fromOutput({ __html: 'OK' });
    return json({ status: 'error', message: 'Edge: ' + errorText(error) });
  }
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (error) {
    console.error('unhandled:', errorText(error));
    return json({ status: 'error', message: 'Edge: ' + errorText(error) }, 500);
  }
});
