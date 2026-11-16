'use strict';

/**
 * Wraps the Apps Script bundle (script.gs) as the backend factory the Supabase
 * Edge function runs: supabase/functions/api/runtime.js.
 *
 * The backend is not translated, rewritten or tree-shaken: the factory's body
 * IS script.gs, byte for byte. What the wrapper adds is
 *
 *   - one line naming the Apps Script services as parameters of the factory,
 *     so every call gets its own copies (lib/gas-shims.js builds them per run)
 *     and nothing a request leaves in a global reaches the next one;
 *   - strict mode, so an assignment to an undeclared name fails loudly instead
 *     of creating a global shared by every request in the isolate;
 *   - a return of the entry points Apps Script itself calls.
 *
 * runtime.js is generated (npm run build) and not committed: it is script.gs a
 * second time. CI builds it before testing and deploying the function.
 */

/** The Apps Script services the backend uses, as the factory's locals. */
const SERVICES = [
  'Date', 'Math', 'console', 'Logger', 'Utilities', 'Session', 'UrlFetchApp', 'CacheService',
  'PropertiesService', 'LockService', 'ContentService', 'HtmlService', 'ScriptApp', 'SpreadsheetApp'
];

/**
 * What Apps Script calls (the web app's two handlers and the time-driven
 * jobs), and runTimedJobs_, the cycle the Edge function's own job runs.
 */
const ENTRY_POINTS = ['doPost', 'doGet', 'processPendingTelegramJobs', 'processTaskSchedules', 'runTimedJobs_'];

const BANNER = [
  '// =============================================================================',
  '// GENERATED FILE - DO NOT EDIT.',
  '//',
  '// The backend (script.gs, itself built from apps-script/*.gs) as a factory for',
  '// the Supabase Edge function. Built by scripts/build-apps-script.js; see',
  '// scripts/edge-runtime.js for what the wrapper adds and why.',
  '// ============================================================================='
].join('\n');

function buildRuntimeSource(bundle) {
  for (const name of ENTRY_POINTS) {
    if (!new RegExp('^function ' + name + '\\(', 'm').test(bundle)) {
      throw new Error('edge runtime: script.gs has no top-level function ' + name);
    }
  }
  const locals = SERVICES.map(name => name + ' = G.' + name).join(',\n  ');
  const entries = ENTRY_POINTS.map(name => '  ' + name + ': ' + name).join(',\n');
  return [
    BANNER,
    '(function (root, factory) {',
    "  if (typeof module === 'object' && module && module.exports) module.exports = factory;",
    '  root.MBMRuntime = factory;',
    "})(typeof globalThis !== 'undefined' ? globalThis : this, function createRuntime(G) {",
    "'use strict';",
    'var ' + locals + ';',
    '',
    bundle.replace(/\s+$/, ''),
    '',
    'return {',
    entries,
    '};',
    '});',
    ''
  ].join('\n');
}

module.exports = { buildRuntimeSource, SERVICES, ENTRY_POINTS };
