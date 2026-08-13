// ============================================================
// Revision counters and the summary cache
// ------------------------------------------------------------
// Google Sheets stays the only source of truth. Nothing here decides anything:
// it stores a copy of an answer that was already derived from the sheets, and
// throws that copy away the moment the underlying data is written.
//
// Two rules make this safe to reason about:
//
//   1. **Only read-only display summaries are cached.** Pricing, stock checks,
//      the ledger, task state and every write path read the sheets directly.
//      A stale cache entry can make a *screen* a minute out of date; it can
//      never make a sale, a balance or an occurrence wrong.
//   2. **Every entry is keyed by a revision counter.** A write bumps the
//      counter, which changes the key, which means the old entry is
//      unreachable rather than merely expiring later. The TTL is the backstop
//      for a write path that forgets to bump, not the primary mechanism.
//
// If the cache disappears entirely — eviction, a quota, an Apps Script
// incident — every caller falls back to computing the answer from the sheets.
// That is the normal path with an extra sheet read, never an error.
// ============================================================

/** Script Property prefix for the revision counters. */
var CACHE_REV_PROP_PREFIX = "OMAD_REV_";

/** Accounting data: transactions, tenants, rates, planned expenses. */
var CACHE_SCOPE_OMAD = "OMAD";

/** Café data: inventory, recipes, categories, settings, sales, closings. */
var CACHE_SCOPE_CAFE = "CAFE";

/** Tasks and occurrences. */
var CACHE_SCOPE_TASKS = "TASKS";

/**
 * Apps Script refuses a cache value over 100 KB. Anything near that is not a
 * summary any more, so it is simply not stored rather than throwing.
 */
var CACHE_MAX_VALUE_LENGTH = 90000;

/** Which System_Config keys belong to which scope, matched by prefix. */
var CACHE_CONFIG_KEY_SCOPES = [
  { prefix: "Omad_", scope: CACHE_SCOPE_OMAD },
  { prefix: "Cafe_", scope: CACHE_SCOPE_CAFE }
];

/**
 * Keys that are *derived from* a scope rather than part of it.
 *
 * The Omad read model is a summary of the ledger, stored in System_Config and
 * keyed by the ledger's own revision. Bumping that revision when the summary is
 * written would make every summary stale the instant it was stored — a rebuild
 * on every single read, for ever. Nothing else derives what it is a copy of, so
 * this list has exactly one entry and adding a second one deserves a reason.
 */
var CACHE_DERIVED_CONFIG_KEYS = {
  Omad_Read_Model: true
};

/**
 * The current revision of one scope.
 *
 * A Script Property read, not a sheet pass — this is consulted on every cached
 * read, so it has to be cheaper than the work it is avoiding.
 */
function dataRevision_(scope) {
  try {
    return String(scriptProperties_().getProperty(CACHE_REV_PROP_PREFIX + scope) || "0");
  } catch (error) {
    // No properties service means no cache key we can trust. "" makes every
    // lookup miss, which degrades to computing the answer.
    return "";
  }
}

/**
 * Marks a scope as changed, so every cached summary derived from it becomes
 * unreachable on the next request.
 *
 * Wrapped: a write that has already stored a financial record must never fail
 * because a counter could not be bumped. A missed bump costs at most the TTL.
 */
function bumpDataRevision_(scope) {
  try {
    var current = Number(dataRevision_(scope)) || 0;
    scriptProperties_().setProperty(CACHE_REV_PROP_PREFIX + scope, String(current + 1));
  } catch (error) {}
}

// The read-modify-write above is deliberately not locked. Two writes landing
// together can produce the same next value, which leaves one stale summary
// readable until its TTL. Taking the script lock for a counter would put every
// write behind the same lock the *financial* writes use, to protect a cache —
// a much worse trade than a minute of staleness on a display figure.

/** Bumps whichever scope a System_Config key belongs to, if any. */
function bumpScopeForConfigKey_(key) {
  var name = String(key || "");
  if (CACHE_DERIVED_CONFIG_KEYS[name]) return;
  for (var i = 0; i < CACHE_CONFIG_KEY_SCOPES.length; i++) {
    if (name.indexOf(CACHE_CONFIG_KEY_SCOPES[i].prefix) === 0) {
      bumpDataRevision_(CACHE_CONFIG_KEY_SCOPES[i].scope);
      return;
    }
  }
}

/**
 * A cached read-only summary.
 *
 * `producer` is called on a miss and its result is stored under a key that
 * includes the scope's current revision. Every failure mode — no cache, a
 * corrupt entry, a value too large to store — falls through to `producer`.
 *
 * The returned object is whatever `producer` returned or a JSON round trip of
 * it, so callers must not rely on object identity or on mutating it.
 */
function cachedSummary_(name, scope, ttlSeconds, producer) {
  var revision = dataRevision_(scope);
  if (!revision) return producer();

  var key = "sum_" + name + "_" + scope + "_" + revision;
  var cache = null;
  try {
    cache = CacheService.getScriptCache();
  } catch (error) {
    cache = null;
  }

  if (cache) {
    var stored = null;
    try { stored = cache.get(key); } catch (error) { stored = null; }
    if (stored) {
      var parsed = safeParseJSON_(stored, null);
      if (parsed !== null) return parsed;
    }
  }

  var fresh = producer();
  if (cache && fresh !== null && fresh !== undefined) {
    try {
      var body = JSON.stringify(fresh);
      if (body.length <= CACHE_MAX_VALUE_LENGTH) cache.put(key, body, ttlSeconds);
    } catch (error) {
      // An unstorable summary is still a correct summary.
    }
  }
  return fresh;
}
