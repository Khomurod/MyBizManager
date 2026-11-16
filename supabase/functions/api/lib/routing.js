// Which runtime answers a request: the Edge function itself, or Apps Script.
//
// The Edge function is the front door for every request once the frontend
// points at it, but it only answers *itself* what it has been allowed to:
//
//   - nothing at all until the settings have been moved into the database
//     (the __PROPERTIES_READY row, written last by move_properties_to_database
//     and deleted first by the move back): before that, Apps Script holds the
//     only copy of the users, the session secret and the bot token;
//   - then the actions named in the EDGE_NATIVE_ACTIONS setting, a comma list
//     ("*" for all, "telegram" for the bot's webhook, "jobs" for the timed
//     jobs), so the switch can be made one group at a time and undone by
//     editing one row;
//   - never the actions below, which need Apps Script itself: the spreadsheet
//     (the move between stores, the ledger migration), its Script Properties
//     (where the settings live) or its triggers and deployment (the health
//     check).
//
// Everything else is forwarded to Apps Script unchanged, so a request is
// always answered by one of the two, and by the same code.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MBMRouting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var APPS_SCRIPT_ONLY = [
    // 25_supabase_import.gs, 26_property_store.gs
    'get_storage_status', 'preview_supabase_import', 'apply_supabase_import', 'verify_supabase_import',
    'rollback_supabase_storage', 'move_properties_to_database', 'move_properties_to_script',
    // 13_migration.gs (the V2 ledger migration)
    'get_migration_status', 'preview_omad_migration', 'apply_omad_migration', 'verify_omad_migration',
    'cutover_omad_migration', 'rollback_omad_migration',
    // 23_health.gs: reads the project's triggers and its own deployment URL
    'get_health'
  ];

  var READY_KEY = '__PROPERTIES_READY';
  var ALLOW_KEY = 'EDGE_NATIVE_ACTIONS';

  /** What a request body asks for: { action, telegram, valid }. */
  function describe(bodyText) {
    var payload;
    try {
      payload = JSON.parse(bodyText || '{}');
    } catch (error) {
      return { action: '', telegram: false, valid: false };
    }
    if (!payload || typeof payload !== 'object') return { action: '', telegram: false, valid: false };
    var action = typeof payload.action === 'string' ? payload.action : '';
    return {
      action: action,
      telegram: !action && !!(payload.message || payload.callback_query),
      valid: true
    };
  }

  /** The allow list as a lookup; '*' allows everything not reserved above. */
  function parseAllowList(text) {
    var names = {};
    String(text || '').split(',').forEach(function (part) {
      var name = part.trim();
      if (name) names[name] = true;
    });
    return names;
  }

  function isAppsScriptOnly(action) {
    return APPS_SCRIPT_ONLY.indexOf(action) !== -1;
  }

  /**
   * 'edge' or 'apps-script' for one POST.
   *
   * config: { ready: boolean, allow: string } -- read from app_properties.
   */
  function routePost(bodyText, config) {
    if (!config || !config.ready) return 'apps-script';
    var request = describe(bodyText);
    if (!request.valid) return 'apps-script';
    var allowed = parseAllowList(config.allow);
    if (request.telegram) return allowed['*'] || allowed.telegram ? 'edge' : 'apps-script';
    if (!request.action || isAppsScriptOnly(request.action)) return 'apps-script';
    return allowed['*'] || allowed[request.action] ? 'edge' : 'apps-script';
  }

  /** Whether the timed jobs run here (pg_cron calls the function either way). */
  function jobsRunHere(config) {
    if (!config || !config.ready) return false;
    var allowed = parseAllowList(config.allow);
    return !!(allowed['*'] || allowed.jobs);
  }

  return {
    APPS_SCRIPT_ONLY: APPS_SCRIPT_ONLY.slice(),
    READY_KEY: READY_KEY,
    ALLOW_KEY: ALLOW_KEY,
    describe: describe,
    parseAllowList: parseAllowList,
    isAppsScriptOnly: isAppsScriptOnly,
    routePost: routePost,
    jobsRunHere: jobsRunHere
  };
});
