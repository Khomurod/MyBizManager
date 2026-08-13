// =============================================================================
// GENERATED FILE - DO NOT EDIT.
//
// Built from apps-script/*.gs by scripts/build-apps-script.js.
// Edit the modules under apps-script/ and run `npm run build`.
//
// Apps Script files share a single global scope, so this bundle behaves
// identically to keeping the modules as separate files in the editor.
// =============================================================================

// ----- apps-script/01_shared_utils.gs ------------------------------------------

// ============================================================
// Shared utilities
// ------------------------------------------------------------
// Tiny helpers with no business meaning of their own.
// ============================================================

function safeParseJSON_(value, fallback) {
  try {
    if (value === null || value === undefined || value === "") return fallback;
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function jsonOutput_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function okHtmlOutput_() {
  return HtmlService.createHtmlOutput("OK");
}

// ------------------------------------------------------------ config reads
//
// Every System_Config lookup is a full pass over the sheet to pull one cell
// out, and the hot ones are asked for repeatedly while answering a single
// request: which sheet the ledger lives in, the fallback year, the rate table.
// One Mini App request with sixteen tenants was making thirty-odd of those
// passes, all returning the same bytes.
//
// So the *read* is memoised, never the decision made from it -- callers still
// re-derive whatever they derive. The memo lasts one request: Apps Script
// gives each execution a fresh global scope, `doPost`/`doGet` clear it anyway
// so the guarantee does not depend on that, and `setConfig` drops the entry it
// overwrites so a handler that changes a value and then reads it back sees the
// new one. Nothing writes System_Config except `setConfig`, which is what makes
// that last part sufficient.

var CONFIG_MEMO_ = {};

/**
 * Drops every request-scoped memo. Called at the top of each entry point.
 *
 * Nothing is cached across requests, so no screen can ever show a figure
 * derived from a value someone else has since changed.
 */
function resetRequestMemos_() {
  CONFIG_MEMO_ = {};
}

function invalidateConfigMemo_(key) {
  delete CONFIG_MEMO_[key];
}

/**
 * `getConfig`, read at most once per key per request.
 *
 * Only for keys whose value cannot change between two reads within a request
 * except through `setConfig`. Anything else should call `getConfig` directly.
 */
function getConfigOnce_(sheet, key) {
  if (Object.prototype.hasOwnProperty.call(CONFIG_MEMO_, key)) return CONFIG_MEMO_[key];
  var value = getConfig(sheet, key);
  CONFIG_MEMO_[key] = value;
  return value;
}

function setConfig(sheet, key, value) {
  // Hooking the single writer means a memo cannot be added elsewhere and then
  // forgotten here.
  invalidateConfigMemo_(key);
  // ...and the same argument applies to the cross-request summary cache: every
  // stored Omad_*/Cafe_* value reaches the sheet through here, so bumping the
  // revision here is what makes "a write invalidates the summaries derived
  // from it" a property of the code rather than of remembering.
  bumpScopeForConfigKey_(key);

  var data = sheet.getDataRange().getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function getConfig(sheet, key) {
  var data = sheet.getDataRange().getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === key) return data[i][1];
  }
  return null;
}

function escapeMarkdown_(value) {
  return String(value || "").replace(/([_*`\[])/g, "\\$1");
}

function escapeTelegramHtml_(value) {
  return String(value === null || value === undefined ? "" : value)
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;");
}

function formatUZS_(amount) {
  return Math.round(Number(amount) || 0).toLocaleString();
}

/** ISO timestamp -> "dd.MM.yyyy HH:mm" in the script's timezone. */
function formatCloseDayStamp_(value) {
  var raw = String(value || "");
  if (!raw) return "";
  try {
    var parsed = new Date(raw);
    if (isNaN(parsed.getTime())) return raw;
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm");
  } catch (error) {
    return raw;
  }
}

/** Constant-time-ish comparison; avoids leaking the secret length via timing. */
function secretsMatch_(a, b) {
  var left = String(a || "");
  var right = String(b || "");
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  var diff = 0;
  for (var i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

// ----- apps-script/01a_periods.gs ----------------------------------------------

// ============================================================
// Year-month periods
// ------------------------------------------------------------
// The canonical period is "YYYY-MM" ("2026-01"). Month-only values such as
// "Yanvar" are legacy: two Januaries collide, and sorting is meaningless.
//
// Friendly Uzbek labels ("Yanvar 2026") are a *presentation* concern and are
// produced from the canonical value, never stored.
// ============================================================

var UZBEK_MONTHS = [
  "Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun",
  "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"
];

var UZBEK_MONTHS_SHORT = [
  "Yan", "Fev", "Mar", "Apr", "May", "Iyn",
  "Iyl", "Avg", "Sen", "Okt", "Noy", "Dek"
];

var CANONICAL_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
var ALL_PERIODS_LABEL = "Jami Davr";

/** Config key holding the year to use for rows whose year cannot be derived. */
var OMAD_FALLBACK_YEAR_KEY = "Omad_Migration_Fallback_Year";

function isCanonicalPeriod_(value) {
  return CANONICAL_PERIOD_PATTERN.test(String(value || ""));
}

/** year + 1-based month -> "YYYY-MM". */
function buildPeriod_(year, month) {
  var y = Number(year);
  var m = Number(month);
  if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) return "";
  return String(y) + "-" + (m < 10 ? "0" + m : String(m));
}

function periodYear_(period) {
  return isCanonicalPeriod_(period) ? Number(String(period).slice(0, 4)) : 0;
}

/** 1-based month number. */
function periodMonth_(period) {
  return isCanonicalPeriod_(period) ? Number(String(period).slice(5, 7)) : 0;
}

/** "2026-01" -> "Yanvar 2026". Anything else is passed through unchanged. */
function formatPeriodLabel_(period) {
  if (!isCanonicalPeriod_(period)) return String(period || "");
  return UZBEK_MONTHS[periodMonth_(period) - 1] + " " + periodYear_(period);
}

function periodFromDate_(date) {
  if (!date || isNaN(date.getTime())) return "";
  return buildPeriod_(date.getFullYear(), date.getMonth() + 1);
}

/**
 * The period held by a Month cell that the spreadsheet turned into a date.
 *
 * The Month column stores "2026-08". A spreadsheet whose column is not text
 * formatted reads that as a date and keeps 1 August instead, which loses the
 * canonical string. The year and month of that date are exactly the period
 * that was intended, so it is recovered rather than discarded - existing rows
 * heal themselves without anyone editing the sheet.
 *
 * Returns "" for month names and anything else that is not a date.
 */
function periodFromDateCell_(value) {
  var date = null;
  if (value && typeof value === "object" && typeof value.getFullYear === "function") {
    date = value;
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(String(value === null || value === undefined ? "" : value))) {
    date = new Date(String(value));
  }
  return date ? periodFromDate_(date) : "";
}

/**
 * Normalises whatever the Month column produced back into a storable value:
 * a canonical period stays as it is, a date cell becomes its period, and a
 * legacy month name is passed through untouched. Never stringifies a date.
 */
function normalizeMonthValue_(value) {
  if (isCanonicalPeriod_(value)) return String(value);
  var recovered = periodFromDateCell_(value);
  if (recovered) return recovered;
  return String(value === null || value === undefined ? "" : value).trim();
}

function currentPeriod_() {
  return periodFromDate_(new Date());
}

/** Shifts a period by whole months, forwards or backwards, across year ends. */
function addMonthsToPeriod_(period, delta) {
  if (!isCanonicalPeriod_(period)) return "";
  var index = periodYear_(period) * 12 + (periodMonth_(period) - 1) + Number(delta || 0);
  return buildPeriod_(Math.floor(index / 12), (index % 12) + 1);
}

/** -1 / 0 / 1. Canonical periods sort correctly as plain strings. */
function comparePeriods_(a, b) {
  var left = String(a || "");
  var right = String(b || "");
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** "Yanvar" / "yanvar" / "01" / "1" -> 1-based month number, or 0. */
function parseUzbekMonth_(value) {
  var text = String(value === null || value === undefined ? "" : value).trim();
  if (!text) return 0;

  for (var i = 0; i < UZBEK_MONTHS.length; i++) {
    if (UZBEK_MONTHS[i].toLowerCase() === text.toLowerCase()) return i + 1;
    if (UZBEK_MONTHS_SHORT[i].toLowerCase() === text.toLowerCase()) return i + 1;
  }

  if (/^\d{1,2}$/.test(text)) {
    var numeric = Number(text);
    if (numeric >= 1 && numeric <= 12) return numeric;
  }
  return 0;
}

/**
 * Reads a year and month out of a stored transaction date.
 *
 * Accepted, in order of preference:
 *   - a real Date value (Sheets returns these for date-formatted cells)
 *   - "dd/MM/yyyy" (what the app writes)
 *   - "yyyy-MM-dd" / ISO 8601
 *
 * Returns null when the value is absent, unparseable or ambiguous. A
 * two-digit year is treated as ambiguous on purpose: guessing the century is
 * exactly the kind of silent damage this migration exists to avoid.
 */
function parseTransactionDate_(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "object" && typeof value.getFullYear === "function") {
    if (isNaN(value.getTime())) return null;
    return { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() };
  }

  var text = String(value).trim();
  if (!text) return null;

  var dmy = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(text);
  if (dmy) {
    var day = Number(dmy[1]);
    var monthDmy = Number(dmy[2]);
    if (monthDmy < 1 || monthDmy > 12) return null;
    if (day < 1 || day > daysInMonth_(Number(dmy[3]), monthDmy)) return null;
    return { year: Number(dmy[3]), month: monthDmy, day: day };
  }

  var iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    // A full timestamp is an instant, not a calendar date. Reading it in the
    // script's timezone is what makes a value that came back from the sheet
    // round-trip to the same day instead of slipping to the one before.
    if (text.indexOf("T") > 0) {
      var instant = new Date(text);
      if (!isNaN(instant.getTime())) {
        return {
          year: instant.getFullYear(),
          month: instant.getMonth() + 1,
          day: instant.getDate()
        };
      }
    }
    var monthIso = Number(iso[2]);
    if (monthIso < 1 || monthIso > 12) return null;
    if (Number(iso[3]) < 1 || Number(iso[3]) > daysInMonth_(Number(iso[1]), monthIso)) return null;
    return { year: Number(iso[1]), month: monthIso, day: Number(iso[3]) };
  }

  return null;
}

/** Leap years included - 2024-02-29 is valid, 2026-02-29 is not. */
function daysInMonth_(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolves a transaction's canonical period.
 *
 * Precedence, and why:
 *   1. an already-canonical `month` - nothing to guess;
 *   2. a legacy month name plus a valid date whose month agrees - the date
 *      supplies the year;
 *   3. a valid date alone;
 *   4. a legacy month name plus the explicitly configured fallback year;
 *   5. unresolved.
 *
 * Case 2 deliberately requires the months to agree. A row saying "Dekabr"
 * with a January date is a real December-to-January edit and must be flagged,
 * not silently reassigned.
 */
function resolveTransactionPeriod_(transaction, fallbackYear) {
  var raw = transaction || {};
  var monthValue = raw.month;

  if (isCanonicalPeriod_(monthValue)) {
    return { period: String(monthValue), source: "canonical", confident: true };
  }

  // A canonical period the spreadsheet stored as a date. It still says exactly
  // which month was meant, and it is more trustworthy than the Date column,
  // so it is honoured before anything is inferred from the date.
  var periodCell = periodFromDateCell_(monthValue);
  if (periodCell) {
    return { period: periodCell, source: "canonical_date_cell", confident: true };
  }

  var parsedDate = parseTransactionDate_(raw.date);
  var namedMonth = parseUzbekMonth_(monthValue);

  if (namedMonth && parsedDate) {
    if (parsedDate.month === namedMonth) {
      return { period: buildPeriod_(parsedDate.year, namedMonth), source: "date", confident: true };
    }
    // The stored month and the stored date disagree. The month label is what
    // the operator chose, so keep it, but take the year from the date only
    // when the disagreement is the ordinary December/January boundary.
    var yearGuess = disagreementYear_(parsedDate, namedMonth);
    if (yearGuess !== null) {
      return {
        period: buildPeriod_(yearGuess, namedMonth),
        source: "date_boundary",
        confident: true
      };
    }
    return {
      period: fallbackYear ? buildPeriod_(fallbackYear, namedMonth) : "",
      source: "conflict",
      confident: false,
      detail: "month '" + monthValue + "' disagrees with date '" + raw.date + "'"
    };
  }

  if (parsedDate) {
    return {
      period: buildPeriod_(parsedDate.year, parsedDate.month),
      source: "date_only",
      confident: true
    };
  }

  if (namedMonth) {
    if (!fallbackYear) {
      return { period: "", source: "needs_fallback_year", confident: false,
               detail: "month '" + monthValue + "' has no usable date" };
    }
    return { period: buildPeriod_(fallbackYear, namedMonth), source: "fallback", confident: false };
  }

  return { period: "", source: "unresolved", confident: false,
           detail: "no usable month or date" };
}

/**
 * A December row dated in early January (or a January row dated in late
 * December) is a normal late entry: the period belongs to the labelled month
 * of the adjacent year. Any other disagreement is not something to guess at.
 */
function disagreementYear_(parsedDate, namedMonth) {
  if (namedMonth === 12 && parsedDate.month === 1) return parsedDate.year - 1;
  if (namedMonth === 1 && parsedDate.month === 12) return parsedDate.year + 1;
  return null;
}

/** The configured fallback year, or 0 when the operator has not chosen one. */
function getFallbackYear_(configSheet) {
  if (!configSheet) return 0;
  var stored = Number(getConfigOnce_(configSheet, OMAD_FALLBACK_YEAR_KEY));
  return isFinite(stored) && stored >= 1970 && stored <= 2999 ? stored : 0;
}

function setFallbackYear_(configSheet, year) {
  setConfig(configSheet, OMAD_FALLBACK_YEAR_KEY, String(Number(year) || ""));
}

/**
 * Normalises any stored period-ish value to canonical form where possible.
 * Used for rates, planned expenses and tenant schedules, which carry a month
 * but no date of their own.
 */
function normalizePeriodValue_(value, fallbackYear) {
  if (isCanonicalPeriod_(value)) return String(value);
  var month = parseUzbekMonth_(value);
  if (month && fallbackYear) return buildPeriod_(fallbackYear, month);
  return "";
}

// ----- apps-script/01c_cache.gs ------------------------------------------------

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

// ----- apps-script/02_validation.gs --------------------------------------------

// ============================================================
// Validation & rate limiting
// ------------------------------------------------------------
// Every externally supplied value is checked here before it reaches business code.
// ============================================================

// 5b. RATE LIMITING & INPUT-LENGTH VALIDATION
// ------------------------------------------
// There is no generic "send this text to Telegram" endpoint any more. The
// endpoints that must stay externally reachable (settings, webhook) are
// throttled and length-checked so they cannot be abused as an amplifier.
// ==========================================
var TELEGRAM_RATE_WINDOW_SECONDS = 60;

var TELEGRAM_ADMIN_RATE_LIMIT = 10;

var TELEGRAM_WEBHOOK_RATE_LIMIT = 120;

var TELEGRAM_MAX_TEXT_LENGTH = 3500;

var TELEGRAM_MAX_FIELD_LENGTH = 512;

var RATE_LIMIT_MESSAGE = "Juda ko'p so'rov yuborildi. Iltimos, biroz kutib qayta urinib ko'ring.";

/** The fixed one-minute window a bucket is currently counting in. */
function rateLimitKey_(bucketKey, windowSeconds) {
  return "rl_" + bucketKey + "_" + Math.floor(new Date().getTime() / (windowSeconds * 1000));
}

/**
 * Fixed-window counter in the script cache. Returns "" when the call is
 * allowed, or a user-facing error message when the window is exhausted.
 * Cache failures fail open on purpose - throttling must never take the app
 * down, it only has to blunt abuse.
 *
 * `bucketKey` must never contain a credential: cache keys are not a place to
 * put a secret, and one is never needed - an identity (a username) or the name
 * of the gate is what a bucket is actually about.
 */
function enforceRateLimit_(bucketKey, maxCalls, windowSeconds) {
  try {
    var cache = CacheService.getScriptCache();
    var key = rateLimitKey_(bucketKey, windowSeconds);
    var used = Number(cache.get(key)) || 0;
    if (used >= maxCalls) return RATE_LIMIT_MESSAGE;
    cache.put(key, String(used + 1), windowSeconds + 5);
    return "";
  } catch (error) {
    return "";
  }
}

/**
 * Whether a bucket is already exhausted, without consuming from it.
 *
 * Splitting the check from the increment is what lets a failure allowance be
 * charged only to failures. Checking and consuming together would mean every
 * legitimate sign-in spent from the same budget as every wrong guess, which is
 * how a shared bucket ends up locking out the people it is protecting.
 */
function peekRateLimit_(bucketKey, maxCalls) {
  try {
    var used = Number(CacheService.getScriptCache().get(
      rateLimitKey_(bucketKey, TELEGRAM_RATE_WINDOW_SECONDS))) || 0;
    return used >= maxCalls ? RATE_LIMIT_MESSAGE : "";
  } catch (error) {
    return "";
  }
}

/** Charges one unit to a bucket. Used on failure paths only. */
function consumeRateLimit_(bucketKey) {
  try {
    var cache = CacheService.getScriptCache();
    var key = rateLimitKey_(bucketKey, TELEGRAM_RATE_WINDOW_SECONDS);
    var used = Number(cache.get(key)) || 0;
    cache.put(key, String(used + 1), TELEGRAM_RATE_WINDOW_SECONDS + 5);
  } catch (error) {}
}

function validateTelegramPayloadLengths_(payload) {
  var fields = ["adminKey", "botToken", "authorizedUserId", "groupChatId", "tasksGroupChatId", "webhookUrl"];
  for (var i = 0; i < fields.length; i++) {
    var value = payload && payload[fields[i]];
    if (value !== undefined && value !== null && String(value).length > TELEGRAM_MAX_FIELD_LENGTH) {
      return "Maydon juda uzun: " + fields[i];
    }
  }
  return "";
}

function validateTelegramToken_(token) {
  var value = String(token || "").trim();
  if (!value) return "Bot token bo'sh bo'lishi mumkin emas.";
  if (!TELEGRAM_TOKEN_PATTERN.test(value)) {
    return "Bot token formati noto'g'ri. Namuna: 123456789:AA...";
  }
  return "";
}

function validateTelegramUserId_(userId) {
  var value = String(userId || "").trim();
  if (!value) return "Telegram foydalanuvchi ID kiritilmagan.";
  if (!/^\d{1,20}$/.test(value)) return "Telegram foydalanuvchi ID faqat musbat raqam bo'lishi kerak.";
  return "";
}

function validateTelegramChatId_(chatId) {
  var value = String(chatId || "").trim();
  if (!value) return "Guruh ID kiritilmagan.";
  if (/^@[A-Za-z0-9_]{4,}$/.test(value)) return "";
  if (!/^-?\d{1,20}$/.test(value)) return "Guruh ID raqam (masalan -1001234567890) yoki @username bo'lishi kerak.";
  return "";
}

/** Like validateTelegramChatId_ but an empty value is allowed (clears it). */
function validateOptionalTelegramChatId_(chatId) {
  var value = String(chatId || "").trim();
  if (!value) return "";
  return validateTelegramChatId_(value);
}

/**
 * The Tasks group id must be the numeric chat id.
 *
 * Unlike the reporting group - which is only ever a send target - the Tasks
 * group is also compared against `chat.id` on every incoming callback and
 * photo, and Telegram only ever sends the number. An @username would send
 * fine and then silently match nothing.
 */
function validateTasksGroupChatId_(chatId) {
  var value = String(chatId || "").trim();
  if (!value) return "Vazifalar guruhi ID kiritilmagan.";
  if (!/^-?\d{1,20}$/.test(value)) {
    return "Vazifalar guruhi ID raqam bo'lishi kerak (masalan -1001234567890). @username qo'llab-quvvatlanmaydi.";
  }
  return "";
}

/** Like validateTasksGroupChatId_ but empty is allowed (clears it). */
function validateOptionalTasksGroupChatId_(chatId) {
  var value = String(chatId || "").trim();
  return value ? validateTasksGroupChatId_(value) : "";
}

// 5e. BUSINESS REPORT JOBS
// ------------------------------------------
// The browser submits a business operation. The message text is composed here,
// on the server, from data the server already stored.
// ==========================================
var OMAD_REPORT_OPERATIONS = { transaction_upsert: true, transaction_delete: true };

function validateOmadTelegramReport_(report) {
  if (report === undefined || report === null) return "";
  if (typeof report !== "object") return "telegramReport noto'g'ri formatda.";
  if (!OMAD_REPORT_OPERATIONS[String(report.operation || "")]) {
    return "telegramReport.operation noto'g'ri.";
  }
  if (String(report.baseId || "").length > 64) return "telegramReport.baseId juda uzun.";
  if (String(report.groupId || "").length > 128) return "telegramReport.groupId juda uzun.";
  if (report.messageId !== undefined && report.messageId !== null && report.messageId !== "" &&
      !/^\d{1,20}$/.test(String(report.messageId))) {
    return "telegramReport.messageId noto'g'ri.";
  }
  return "";
}

// ----- apps-script/02a_auth.gs -------------------------------------------------

// ============================================================
// Web authentication: users, passwords, sessions and roles
// ------------------------------------------------------------
// The login page used to hold three username/password pairs in plain page
// source and then ask for OMAD_ADMIN_KEY as the thing the server actually
// checked. So the passwords were decoration, the real credential was typed by
// hand into a phone at every sign-in, and every signed-in browser held the one
// key that also unlocks migration and maintenance.
//
// This module replaces all of that:
//
//   * Credentials live in the OMAD_USERS Script Property, as a salted,
//     iterated hash per user. No password, and nothing derived from one that
//     could be replayed, is ever sent to a browser or committed to the repo.
//   * A successful login mints a signed, expiring session token. It is a MAC
//     over the claims, so verifying one is a hash rather than a sheet read and
//     losing the cache or restarting the project cannot sign anybody out.
//   * Every action names the roles that may perform it. A café seller editing
//     localStorage, or opening omad_admin.html directly, still cannot read the
//     ledger — the refusal is on the server, where the browser cannot reach it.
//
// OMAD_ADMIN_KEY survives as an internal break-glass credential for
// maintenance and migration, and is accepted as omad_admin wherever a session
// would be. Nobody has to know it to use the application.
// ============================================================

/** Salted password hashes, as JSON: { username: { role, salt, hash, pwv } }. */
var OMAD_PROP_USERS = "OMAD_USERS";

/** HMAC key the session tokens are signed with. Generated on first use. */
var OMAD_PROP_SESSION_SECRET = "OMAD_SESSION_SECRET";

var AUTH_ROLE_OMAD_ADMIN = "omad_admin";
var AUTH_ROLE_CAFE_ADMIN = "cafe_admin";
var AUTH_ROLE_CAFE_SELLER = "cafe_seller";

/** The only roles that exist. A stored record naming anything else is ignored. */
var AUTH_VALID_ROLES = {
  omad_admin: true,
  cafe_admin: true,
  cafe_seller: true
};

/** Which page each role signs in to. The server decides, not the page. */
var AUTH_ROLE_HOME = {
  omad_admin: "omad_admin.html",
  cafe_admin: "cafe_admin.html",
  cafe_seller: "cafe_pos.html"
};

/**
 * Password hashing: HMAC-SHA256 chained over a per-user salt.
 *
 * Apps Script has no PBKDF2, and `Utilities.computeHmacSha256Signature` is the
 * only primitive available in both the runtime and the test harness. Chaining
 * it is a plain iterated KDF: it makes an offline guess cost the same as a
 * login instead of a single hash, which is the property that matters when the
 * stored value is a Script Property only the project owner can read.
 *
 * The count is a compromise. Sign-in happens once per session and a session
 * lasts a month, so a few hundred milliseconds there is invisible; the same
 * cost is charged to every wrong guess, on top of the throttle below.
 */
var AUTH_HASH_ITERATIONS = 200;

/** A month. Long enough that nobody is asked to sign in repeatedly. */
var AUTH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Usernames are part of the token's own delimiter-separated format. */
var AUTH_USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;

var AUTH_MIN_PASSWORD_LENGTH = 8;

var AUTH_MAX_PASSWORD_LENGTH = 200;

var AUTH_TOKEN_VERSION = "v1";

// ---------------------------------------------------------------- throttling
//
// Three buckets, deliberately not one:
//
//   * per username, strict — the only thing that stops somebody working
//     through a password list against a known account, and it can only be
//     filled by failures *against that account*;
//   * all failed logins, generous — blunts spraying across many usernames
//     without letting one attacker lock out the whole business at ten
//     attempts;
//   * failed authentication on ordinary requests, strict — a wrong or missing
//     admin key, or a forged token.
//
// A *successful* request never touches any of them. That is the fix for the
// incident this replaced: the café till shared one 40-per-minute bucket with
// every failed attempt in the world, so a second tab could throttle the shop.

var LOGIN_FAILURE_LIMIT_PER_USER = 8;

var LOGIN_FAILURE_LIMIT_GLOBAL = 100;

var AUTH_FAILURE_LIMIT = 10;

/**
 * Per-signed-in-user request allowance.
 *
 * Keyed by username — which is not a secret, so no credential ever appears in
 * a cache key — so one busy till cannot throttle the office, and neither can
 * an anonymous stranger throttle either of them.
 */
var AUTHENTICATED_REQUEST_LIMIT = 120;

// --------------------------------------------------------------- user records

function readAuthUsers_() {
  var stored = safeParseJSON_(getTelegramSetting_(OMAD_PROP_USERS), null);
  return stored && typeof stored === "object" ? stored : {};
}

function writeAuthUsers_(users) {
  setTelegramSetting_(OMAD_PROP_USERS, JSON.stringify(users || {}));
}

/**
 * True once the owner's own account has a password.
 *
 * This, not "any user exists", is what ends the bootstrap: setting the café
 * passwords is the first thing the bootstrap session is *for*, so it must not
 * be the thing that invalidates it half way through.
 */
function omadAdminAccountConfigured_() {
  return !!readAuthUsers_()[AUTH_ROLE_OMAD_ADMIN];
}

function normalizeUsername_(value) {
  return String(value === null || value === undefined ? "" : value).trim().toLowerCase();
}

/** 64 hex characters of salt, from two UUIDs. */
function newAuthSalt_() {
  return (Utilities.getUuid() + Utilities.getUuid()).split("-").join("");
}

/**
 * The stored form of one password.
 *
 * Returns hex. The first round takes the password as the message so the salt
 * is the key; every later round feeds the digest back as the message, so the
 * whole chain has to be walked to check one guess.
 */
function hashPassword_(password, salt) {
  var saltBytes = Utilities.newBlob(String(salt)).getBytes();
  var digest = Utilities.computeHmacSha256Signature(String(password), String(salt));
  for (var i = 1; i < AUTH_HASH_ITERATIONS; i++) {
    digest = Utilities.computeHmacSha256Signature(digest, saltBytes);
  }
  return bytesToHex_(digest);
}

function validatePasswordStrength_(password) {
  var value = String(password === null || password === undefined ? "" : password);
  if (value.length < AUTH_MIN_PASSWORD_LENGTH) {
    return "Parol kamida " + AUTH_MIN_PASSWORD_LENGTH + " ta belgidan iborat bo'lishi kerak.";
  }
  if (value.length > AUTH_MAX_PASSWORD_LENGTH) return "Parol juda uzun.";
  return "";
}

/**
 * Creates or replaces one user's credential.
 *
 * `pwv` is a password version carried inside every token. Changing a password
 * bumps it, which invalidates every session that user already had — the only
 * revocation mechanism a stateless token needs, and the one thing a change of
 * password is expected to do.
 */
function setUserCredential_(username, password, role) {
  var name = normalizeUsername_(username);
  if (!AUTH_USERNAME_PATTERN.test(name)) {
    return { status: "error", message: "Foydalanuvchi nomi faqat kichik harf, raqam va _ bo'lishi mumkin (3-32 belgi)." };
  }

  var users = readAuthUsers_();
  var existing = users[name] || null;
  var nextRole = role === undefined || role === null || role === "" ? (existing && existing.role) : String(role);
  if (!AUTH_VALID_ROLES[nextRole]) {
    return { status: "error", message: "Rol noto'g'ri. Ruxsat etilgan rollar: omad_admin, cafe_admin, cafe_seller." };
  }

  var weak = validatePasswordStrength_(password);
  if (weak) return { status: "error", message: weak };

  var salt = newAuthSalt_();
  users[name] = {
    role: nextRole,
    salt: salt,
    hash: hashPassword_(password, salt),
    pwv: (Number(existing && existing.pwv) || 0) + 1,
    updatedAt: new Date().toISOString()
  };
  writeAuthUsers_(users);

  return { status: "success", username: name, role: nextRole, created: !existing };
}

/**
 * Checks a username and password against the stored record.
 *
 * A missing user and a wrong password answer identically, so the endpoint
 * cannot be used to find out which accounts exist.
 */
function verifyUserPassword_(username, password) {
  var name = normalizeUsername_(username);
  var users = readAuthUsers_();
  var record = users[name];
  if (!record || !record.salt || !record.hash || !AUTH_VALID_ROLES[record.role]) return { ok: false };

  var candidate = hashPassword_(password, record.salt);
  if (!hexDigestsMatch_(candidate, String(record.hash))) return { ok: false };

  return { ok: true, username: name, role: record.role, pwv: Number(record.pwv) || 0 };
}

// -------------------------------------------------------------- session tokens

function sessionSecret_() {
  var existing = getTelegramSetting_(OMAD_PROP_SESSION_SECRET);
  if (existing) return existing;
  var generated = (Utilities.getUuid() + Utilities.getUuid()).split("-").join("");
  setTelegramSetting_(OMAD_PROP_SESSION_SECRET, generated);
  return generated;
}

function signSessionClaims_(claims) {
  return bytesToHex_(Utilities.computeHmacSha256Signature(claims, sessionSecret_()));
}

/**
 * A session token: `v1.<username>.<role>.<expiry>.<pwv>.<nonce>.<signature>`.
 *
 * Deliberately not JSON-in-base64. Usernames are restricted to `[a-z0-9_]` and
 * roles to a fixed list, so no field can contain the separator and the format
 * needs neither an encoder nor a parser that could disagree with each other.
 *
 * Nothing here is secret — the claims are readable by whoever holds the token,
 * which is the person they describe. The signature is what makes them true.
 */
function issueSessionToken_(username, role, pwv, nowMs) {
  var now = nowMs === undefined ? Date.now() : nowMs;
  var expiry = Math.floor(now / 1000) + AUTH_SESSION_TTL_SECONDS;
  var nonce = Utilities.getUuid().split("-").join("");
  var claims = [AUTH_TOKEN_VERSION, username, role, String(expiry), String(pwv), nonce].join(".");
  return {
    token: claims + "." + signSessionClaims_(claims),
    expiresAt: expiry * 1000
  };
}

/**
 * Verifies one token. Returns `{ ok, username, role, reason }`.
 *
 * `reason` is a short code and never depends on a secret: `expired` is the one
 * the client acts on, by sending the user back to the login page instead of
 * showing an error over their data.
 */
function verifySessionToken_(token, nowMs) {
  var text = String(token === null || token === undefined ? "" : token);
  if (!text) return { ok: false, reason: "missing" };
  if (text.length > 512) return { ok: false, reason: "malformed" };

  var parts = text.split(".");
  if (parts.length !== 7 || parts[0] !== AUTH_TOKEN_VERSION) return { ok: false, reason: "malformed" };

  var username = parts[1];
  var role = parts[2];
  var expiry = Number(parts[3]);
  var pwv = Number(parts[4]);
  if (!AUTH_USERNAME_PATTERN.test(username) || !AUTH_VALID_ROLES[role] || !isFinite(expiry)) {
    return { ok: false, reason: "malformed" };
  }

  var claims = parts.slice(0, 6).join(".");
  if (!hexDigestsMatch_(signSessionClaims_(claims), parts[6])) return { ok: false, reason: "bad_signature" };

  var nowSeconds = Math.floor((nowMs === undefined ? Date.now() : nowMs) / 1000);
  if (nowSeconds >= expiry) return { ok: false, reason: "expired" };

  // The signature proves the claims were minted here; the stored record decides
  // whether they are still true. A changed password, a changed role or a
  // deleted user takes effect on the next request rather than in a month.
  var users = readAuthUsers_();
  var record = users[username];
  if (!record) {
    // The bootstrap session, which exists before the owner's account does and
    // stops existing the moment it is created. Nothing else can be minted
    // without a stored record, and this one still had to present the
    // maintenance key to be issued at all.
    if (username === AUTH_ROLE_OMAD_ADMIN && role === AUTH_ROLE_OMAD_ADMIN && pwv === 0 &&
        !omadAdminAccountConfigured_()) {
      return { ok: true, username: username, role: role, bootstrap: true };
    }
    return { ok: false, reason: "revoked" };
  }
  if (String(record.role) !== role) return { ok: false, reason: "revoked" };
  if ((Number(record.pwv) || 0) !== pwv) return { ok: false, reason: "revoked" };

  return { ok: true, username: username, role: role };
}

// --------------------------------------------------------------------- login

/**
 * Throttles a login attempt before the password is checked.
 *
 * Both buckets are consumed only by `recordLoginFailure_`, so somebody typing
 * their own password correctly is never held back by their own history, and a
 * signed-in user is never affected at all.
 */
function loginThrottleMessage_(username) {
  var perUser = peekRateLimit_("login_u_" + username, LOGIN_FAILURE_LIMIT_PER_USER);
  if (perUser) return "Juda ko'p urinish. Bir daqiqa kutib qayta urinib ko'ring.";
  var global = peekRateLimit_("login_all", LOGIN_FAILURE_LIMIT_GLOBAL);
  if (global) return "Juda ko'p urinish. Bir daqiqa kutib qayta urinib ko'ring.";
  return "";
}

function recordLoginFailure_(username) {
  consumeRateLimit_("login_u_" + username);
  consumeRateLimit_("login_all");
}

/**
 * Signs a user in.
 *
 * The answer is deliberately the same sentence for an unknown user, a wrong
 * password and a throttled attempt beyond the throttle's own message, so the
 * page cannot be used to enumerate accounts.
 */
function loginAction_(payload) {
  var username = normalizeUsername_(payload && payload.username);
  var password = String((payload && payload.password) || "");

  if (!AUTH_USERNAME_PATTERN.test(username) || !password) {
    return { status: "error", code: "invalid_credentials", message: "Login yoki parol noto'g'ri." };
  }
  if (password.length > AUTH_MAX_PASSWORD_LENGTH) {
    return { status: "error", code: "invalid_credentials", message: "Login yoki parol noto'g'ri." };
  }

  var throttled = loginThrottleMessage_(username);
  if (throttled) return { status: "error", code: "throttled", message: throttled };

  var verified = verifyUserPassword_(username, password);

  // Bootstrap. Until the owner has set the first password there is no user
  // store to check against, so the maintenance key stands in for exactly one
  // account: the one that can then create the others. It stops working the
  // moment any password is set, and the response says so.
  var bootstrap = false;
  if (!verified.ok && !omadAdminAccountConfigured_() && username === AUTH_ROLE_OMAD_ADMIN) {
    var keyError = checkAdminKey_({ adminKey: password });
    if (!keyError) {
      verified = { ok: true, username: username, role: AUTH_ROLE_OMAD_ADMIN, pwv: 0 };
      bootstrap = true;
    }
  }

  if (!verified.ok) {
    recordLoginFailure_(username);
    return { status: "error", code: "invalid_credentials", message: "Login yoki parol noto'g'ri." };
  }

  var issued = issueSessionToken_(verified.username, verified.role, verified.pwv);
  return {
    status: "success",
    token: issued.token,
    expiresAt: issued.expiresAt,
    username: verified.username,
    role: verified.role,
    home: AUTH_ROLE_HOME[verified.role] || "login.html",
    bootstrap: bootstrap
  };
}

/** Lets a signed-in user replace their own password. */
function changePasswordAction_(auth, payload) {
  var current = String((payload && payload.currentPassword) || "");
  var next = String((payload && payload.newPassword) || "");

  if (auth.bootstrap) {
    // There is nothing to check the current password against yet, so this is
    // the first password rather than a change of one.
    var created = setUserCredential_(auth.username, next, auth.role);
    if (created.status !== "success") return created;
    var firstToken = issueSessionToken_(created.username, created.role, 1);
    return { status: "success", token: firstToken.token, expiresAt: firstToken.expiresAt, role: created.role };
  }

  var throttled = loginThrottleMessage_(auth.username);
  if (throttled) return { status: "error", code: "throttled", message: throttled };

  var verified = verifyUserPassword_(auth.username, current);
  if (!verified.ok) {
    recordLoginFailure_(auth.username);
    return { status: "error", code: "invalid_credentials", message: "Joriy parol noto'g'ri." };
  }

  var result = setUserCredential_(auth.username, next, verified.role);
  if (result.status !== "success") return result;

  // The old sessions — including this browser's — are invalid now, so a fresh
  // one is issued rather than silently signing the user out mid-task.
  var reissued = issueSessionToken_(result.username, result.role, (Number(verified.pwv) || 0) + 1);
  return { status: "success", token: reissued.token, expiresAt: reissued.expiresAt, role: result.role };
}

/** omad_admin creating or resetting an account, including the café ones. */
function setUserPasswordAction_(payload) {
  var result = setUserCredential_(payload && payload.username, (payload && payload.password) || "", payload && payload.role);
  if (result.status !== "success") return result;
  return {
    status: "success",
    username: result.username,
    role: result.role,
    created: result.created,
    users: listAuthUsers_()
  };
}

/** Who exists and what they may do. Never any salt, hash or password. */
function listAuthUsers_() {
  var users = readAuthUsers_();
  var rows = [];
  Object.keys(users).sort().forEach(function (name) {
    rows.push({
      username: name,
      role: String(users[name].role || ""),
      updatedAt: String(users[name].updatedAt || "")
    });
  });
  return rows;
}

// ------------------------------------------------------------- request gating

/**
 * Authorizes one web-app request against the roles an action allows.
 *
 * Order matters:
 *
 *   1. A session token is verified first, by signature. Forging one means
 *      forging an HMAC, so a failure here is a stale or absent session rather
 *      than evidence of guessing — which is why a valid session never consumes
 *      a failure allowance and can never be throttled by somebody else's.
 *   2. The admin key is compared only after its own strict rate limit, which
 *      is the property the endpoint has always had: it must not be usable to
 *      guess the key.
 *   3. Anything else is a failure, and failures share one strict bucket.
 *
 * Returns `{ ok, role, username }` or `{ ok: false, message, code }`, where
 * `code` is `auth` when the client should return to the login page and
 * `throttled` when it should simply try again shortly.
 */
function authorizeWebRequest_(payload, allowedRoles) {
  var token = payload && payload.sessionToken;

  if (token) {
    var session = verifySessionToken_(token);
    if (session.ok) {
      var throttled = enforceRateLimit_(
        "user_" + session.username, AUTHENTICATED_REQUEST_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
      if (throttled) return { ok: false, code: "throttled", message: throttled };
      if (!roleAllowed_(session.role, allowedRoles)) {
        return { ok: false, code: "forbidden", message: "Bu amal uchun ruxsat yo'q." };
      }
      return { ok: true, role: session.role, username: session.username, bootstrap: !!session.bootstrap };
    }

    var expired = session.reason === "expired" || session.reason === "revoked";
    var failure = enforceRateLimit_("auth_fail", AUTH_FAILURE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
    if (failure && !expired) return { ok: false, code: "throttled", message: failure };
    return {
      ok: false,
      code: "auth",
      message: expired
        ? "Sessiya muddati tugadi. Qaytadan kiring."
        : "Kirish tasdiqlanmadi. Qaytadan kiring."
    };
  }

  if (payload && payload.adminKey) {
    var keyThrottled = enforceRateLimit_("auth_key", AUTH_FAILURE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
    if (keyThrottled) return { ok: false, code: "throttled", message: keyThrottled };

    var keyError = checkAdminKey_(payload);
    if (keyError) return { ok: false, code: "auth", message: keyError };
    if (!roleAllowed_(AUTH_ROLE_OMAD_ADMIN, allowedRoles)) {
      return { ok: false, code: "forbidden", message: "Bu amal uchun ruxsat yo'q." };
    }
    return { ok: true, role: AUTH_ROLE_OMAD_ADMIN, username: AUTH_ROLE_OMAD_ADMIN, viaAdminKey: true };
  }

  var anonymous = enforceRateLimit_("auth_fail", AUTH_FAILURE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  if (anonymous) return { ok: false, code: "throttled", message: anonymous };
  return { ok: false, code: "auth", message: "Kirish tasdiqlanmadi. Qaytadan kiring." };
}

function roleAllowed_(role, allowedRoles) {
  if (!allowedRoles || allowedRoles.length === 0) return role === AUTH_ROLE_OMAD_ADMIN;
  for (var i = 0; i < allowedRoles.length; i++) {
    if (allowedRoles[i] === role) return true;
  }
  return false;
}

/** The refusal shape every gated handler returns, so clients can branch on it. */
function authRefusal_(auth) {
  return jsonOutput_({
    status: "error",
    code: auth.code || "auth",
    // The café screens sign out on this and only on this. A throttle or a
    // network fault must never look like an expired session, or a busy minute
    // empties the till's stock list and asks the cashier to log in again.
    authExpired: auth.code === "auth",
    message: auth.message
  });
}

/**
 * Run once from the Apps Script editor to create or reset an account.
 *
 * Exists so the first password can be set without a password already existing,
 * and without one ever being typed into a browser address bar or committed.
 * Nothing calls it; it is an operator tool.
 */
function setUserPassword(username, password, role) {
  var result = setUserCredential_(username, password, role);
  if (result.status !== "success") throw new Error(result.message);
  return result.username + " -> " + result.role;
}

// ----- apps-script/03_settings.gs ----------------------------------------------

// ============================================================
// Settings & secrets
// ------------------------------------------------------------
// Secrets live ONLY in Script Properties. They are never hardcoded, never
// returned to the browser and never written to logs.
// ============================================================

// 5. TELEGRAM CREDENTIALS & SETTINGS
// ------------------------------------------
// Secrets live ONLY in Apps Script Script Properties. They are never
// hardcoded, never returned to the browser and never written to logs.
// ==========================================
var TELEGRAM_PROP_BOT_TOKEN = "TELEGRAM_BOT_TOKEN";

var TELEGRAM_PROP_AUTHORIZED_USER_ID = "TELEGRAM_AUTHORIZED_USER_ID";

var TELEGRAM_PROP_GROUP_CHAT_ID = "TELEGRAM_GROUP_CHAT_ID";

// The Tasks group is stored alongside the reporting group, but is a distinct
// destination: task cards, reminders and completions go here and never mix
// with the accounting reports.
var TELEGRAM_PROP_TASKS_GROUP_CHAT_ID = "TELEGRAM_TASKS_GROUP_CHAT_ID";

var TELEGRAM_PROP_WEBHOOK_URL = "TELEGRAM_WEBHOOK_URL";

var TELEGRAM_PROP_WEBHOOK_STATUS = "TELEGRAM_WEBHOOK_STATUS";

var TELEGRAM_PROP_LAST_SUCCESS = "TELEGRAM_LAST_SUCCESS";

var TELEGRAM_PROP_LAST_ERROR = "TELEGRAM_LAST_ERROR";

var OMAD_PROP_ADMIN_KEY = "OMAD_ADMIN_KEY";

// 5c. WEBHOOK VERIFICATION
// ------------------------------------------
// Apps Script web apps cannot read request headers, so Telegram's
// X-Telegram-Bot-Api-Secret-Token header is not observable. The strongest
// mechanism that IS available is a secret embedded in the webhook URL: only
// Telegram is ever told the URL, and setWebhook additionally sends the same
// value as secret_token for defence in depth.
// ==========================================
var TELEGRAM_PROP_WEBHOOK_SECRET = "TELEGRAM_WEBHOOK_SECRET";

var TELEGRAM_WEBHOOK_SECRET_PARAM = "wh";

var TELEGRAM_TOKEN_PATTERN = /^\d{6,16}:[A-Za-z0-9_-]{30,}$/;

var TELEGRAM_TOKEN_LIKE_PATTERN = /\d{6,16}:[A-Za-z0-9_-]{30,}/g;

function scriptProperties_() {
  return PropertiesService.getScriptProperties();
}

function getTelegramSetting_(key) {
  try {
    return scriptProperties_().getProperty(key) || "";
  } catch (error) {
    return "";
  }
}

function setTelegramSetting_(key, value) {
  if (value === null || value === undefined || value === "") {
    scriptProperties_().deleteProperty(key);
    return;
  }
  scriptProperties_().setProperty(key, String(value));
}

function getBotToken_() {
  return getTelegramSetting_(TELEGRAM_PROP_BOT_TOKEN);
}

function getAuthorizedTelegramUserId_() {
  return getTelegramSetting_(TELEGRAM_PROP_AUTHORIZED_USER_ID);
}

function getOmadGroupChatId_() {
  return getTelegramSetting_(TELEGRAM_PROP_GROUP_CHAT_ID);
}

/**
 * The group task cards, reminders and completions are posted to, in the one
 * form everything can agree on: the numeric chat id. A legacy or hand-edited
 * non-numeric value reads as "not configured" rather than half-working - the
 * settings page still shows what is stored so it can be corrected. "" disables.
 */
function getTasksGroupChatId_() {
  var value = String(getTelegramSetting_(TELEGRAM_PROP_TASKS_GROUP_CHAT_ID) || "").trim();
  return /^-?\d{1,20}$/.test(value) ? value : "";
}

function getOrCreateWebhookSecret_() {
  var existing = getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET);
  if (existing) return existing;
  var generated = Utilities.getUuid().split("-").join("") + Utilities.getUuid().split("-").join("");
  setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET, generated);
  return generated;
}

/**
 * Every stored value that must never reach a log, a sheet cell or a client.
 * Read defensively: redaction runs inside error paths, where a missing
 * property must not itself throw.
 */
function storedSecretValues_() {
  var names = [
    TELEGRAM_PROP_BOT_TOKEN,
    TELEGRAM_PROP_WEBHOOK_SECRET,
    // The outgoing secret during a rotation is still a secret.
    TELEGRAM_PROP_WEBHOOK_SECRET_PREVIOUS,
    OMAD_PROP_ADMIN_KEY
  ];
  var values = [];
  for (var i = 0; i < names.length; i++) {
    var value = "";
    try { value = getTelegramSetting_(names[i]); } catch (error) { value = ""; }
    // One-character values would blank out ordinary text.
    if (value && String(value).length >= 8) values.push(String(value));
  }
  return values;
}

/**
 * Removes every credential from a string before it is logged or returned.
 *
 * Covers the configured bot token, the webhook verification secret and the
 * admin key by value, and - because a value can be rotated while an old log
 * line is still being written - anything *shaped* like one of them: a bot
 * token, a `wh=` webhook parameter, a `secret_token` field, or an
 * Authorization header.
 */
function redactSecrets_(value) {
  var text = value === null || value === undefined ? "" : String(value && value.message ? value.message : value);

  var secrets = storedSecretValues_();
  for (var i = 0; i < secrets.length; i++) {
    text = text.split(secrets[i]).join("[REDACTED]");
  }

  var token = "";
  try { token = getBotToken_(); } catch (error) { token = ""; }
  if (token) {
    var tokenId = token.split(":")[0];
    if (tokenId) text = text.split("bot" + tokenId).join("bot[REDACTED]");
  }

  return text
    .replace(TELEGRAM_TOKEN_LIKE_PATTERN, "[REDACTED]")
    // ...wh=<secret> in a URL or query string, however it is quoted.
    .replace(/([?&]wh=)[^&"'\s\\]+/gi, "$1[REDACTED]")
    // ..."secret_token":"<secret>" / secret_token=<secret>
    .replace(/("?secret_token"?\s*[:=]\s*"?)[^",&}\s]+/gi, "$1[REDACTED]")
    // ...Authorization: Bearer <value>
    .replace(/("?authorization"?\s*[:=]\s*"?)(bearer\s+)?[^",&}\s]+/gi, "$1[REDACTED]")
    // ...adminKey carried in a payload that gets logged.
    .replace(/("?adminKey"?\s*[:=]\s*"?)[^",&}\s]+/gi, "$1[REDACTED]");
}

function recordTelegramSuccess_(action) {
  try {
    setTelegramSetting_(TELEGRAM_PROP_LAST_SUCCESS, JSON.stringify({
      action: String(action || ""),
      at: new Date().toISOString()
    }));
  } catch (error) {}
}

function recordTelegramError_(action, error) {
  try {
    setTelegramSetting_(TELEGRAM_PROP_LAST_ERROR, JSON.stringify({
      action: String(action || ""),
      message: redactSecrets_(error).slice(0, 500),
      at: new Date().toISOString()
    }));
  } catch (ignored) {}
}

/**
 * Public-safe view of the Telegram configuration.
 * The token itself is NEVER included - only whether one is configured.
 */
function buildTelegramSettingsView_() {
  return {
    tokenConfigured: !!getBotToken_(),
    authorizedUserId: getTelegramSetting_(TELEGRAM_PROP_AUTHORIZED_USER_ID),
    groupChatId: getTelegramSetting_(TELEGRAM_PROP_GROUP_CHAT_ID),
    // The raw stored value, so a bad legacy one stays visible and fixable...
    tasksGroupChatId: getTelegramSetting_(TELEGRAM_PROP_TASKS_GROUP_CHAT_ID),
    // ...alongside whether anything will actually use it.
    tasksGroupChatIdUsable: !!getTasksGroupChatId_(),
    webhookUrl: getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL),
    webhookStatus: safeParseJSON_(getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_STATUS), null),
    lastSuccess: safeParseJSON_(getTelegramSetting_(TELEGRAM_PROP_LAST_SUCCESS), null),
    lastError: safeParseJSON_(getTelegramSetting_(TELEGRAM_PROP_LAST_ERROR), null),
    adminKeyConfigured: !!getTelegramSetting_(OMAD_PROP_ADMIN_KEY),
    // Whether a webhook verification secret exists - never the secret itself.
    webhookSecretConfigured: !!getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET),
    webhookSecretRotatedAt: getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_ROTATED_AT),
    // Not a secret: the Mini App URL is in the bot's menu for anyone to see.
    miniAppUrl: getTelegramSetting_(TELEGRAM_PROP_MINI_APP_URL),
    miniAppStatus: safeParseJSON_(getTelegramSetting_(TELEGRAM_PROP_MINI_APP_STATUS), null)
  };
}

/**
 * Settings mutations require an admin key stored in Script Properties.
 * Returns "" when authorized, or an error message.
 */
function checkAdminKey_(payload) {
  var expected = getTelegramSetting_(OMAD_PROP_ADMIN_KEY);
  if (!expected) {
    return "OMAD_ADMIN_KEY Script Property o'rnatilmagan. Apps Script → Project Settings → Script Properties orqali qo'shing.";
  }
  var provided = String((payload && payload.adminKey) || "");
  // Compared the way every other secret here is: without letting the answer's
  // timing say how much of the key was right.
  if (!secretsMatch_(provided, expected)) return "Admin kaliti noto'g'ri.";
  return "";
}

function saveTelegramSettings_(payload) {
  var errors = [];
  var updated = [];
  var hasToken = Object.prototype.hasOwnProperty.call(payload, "botToken") && String(payload.botToken || "").trim() !== "";

  if (hasToken) {
    var tokenError = validateTelegramToken_(payload.botToken);
    if (tokenError) errors.push(tokenError);
  }

  var userError = validateTelegramUserId_(payload.authorizedUserId);
  if (userError) errors.push(userError);

  var chatError = validateTelegramChatId_(payload.groupChatId);
  if (chatError) errors.push(chatError);

  // The Tasks group is optional and only validated/stored when supplied, so a
  // legacy client that does not know about it leaves it untouched.
  var hasTasksGroup = Object.prototype.hasOwnProperty.call(payload, "tasksGroupChatId");
  if (hasTasksGroup) {
    var tasksChatError = validateOptionalTasksGroupChatId_(payload.tasksGroupChatId);
    if (tasksChatError) errors.push(tasksChatError);
  }

  if (errors.length > 0) return { status: "error", message: errors.join(" ") };

  if (hasToken) {
    setTelegramSetting_(TELEGRAM_PROP_BOT_TOKEN, String(payload.botToken).trim());
    updated.push("botToken");
  }
  setTelegramSetting_(TELEGRAM_PROP_AUTHORIZED_USER_ID, String(payload.authorizedUserId).trim());
  setTelegramSetting_(TELEGRAM_PROP_GROUP_CHAT_ID, String(payload.groupChatId).trim());
  updated.push("authorizedUserId", "groupChatId");
  if (hasTasksGroup) {
    // An empty value clears it, disabling the task Telegram integration.
    setTelegramSetting_(TELEGRAM_PROP_TASKS_GROUP_CHAT_ID, String(payload.tasksGroupChatId || "").trim());
    updated.push("tasksGroupChatId");
  }

  auditTelegramSettingsChange_(updated);
  return { status: "success", settings: buildTelegramSettingsView_() };
}

function testTelegramConnection_() {
  if (!getBotToken_()) return { status: "error", message: "Bot token o'rnatilmagan." };
  try {
    var response = telegramFetch_("getMe", {});
    var data = safeParseJSON_(response.getContentText(), {});
    var bot = (data && data.result) || {};
    return {
      status: "success",
      bot: { id: bot.id || "", username: bot.username || "", firstName: bot.first_name || "" },
      settings: buildTelegramSettingsView_()
    };
  } catch (error) {
    return { status: "error", message: redactSecrets_(error), settings: buildTelegramSettingsView_() };
  }
}

function sendTelegramTestMessage_() {
  var chatId = getOmadGroupChatId_();
  if (!chatId) return { status: "error", message: "Guruh ID o'rnatilmagan." };
  try {
    sendTelegramMessage_(chatId, "✅ MyBizManager: Telegram sozlamalari tekshiruvi muvaffaqiyatli.");
    return { status: "success", settings: buildTelegramSettingsView_() };
  } catch (error) {
    return { status: "error", message: redactSecrets_(error), settings: buildTelegramSettingsView_() };
  }
}

/** Strips any previously appended webhook secret from an operator-entered URL. */
function stripWebhookSecret_(url) {
  var base = String(url || "").trim();
  var cut = base.indexOf("?" + TELEGRAM_WEBHOOK_SECRET_PARAM + "=");
  if (cut !== -1) return base.slice(0, cut);
  cut = base.indexOf("&" + TELEGRAM_WEBHOOK_SECRET_PARAM + "=");
  if (cut !== -1) return base.slice(0, cut);
  return base;
}

function configureTelegramWebhook_(payload) {
  var webhookUrl = stripWebhookSecret_(
    (payload && payload.webhookUrl) || getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL) || ""
  );
  if (!/^https:\/\/[^\s]+$/.test(webhookUrl)) {
    return { status: "error", message: "Webhook manzili https:// bilan boshlanishi kerak." };
  }
  try {
    // The secret is never returned to the browser. It only ever travels to
    // Telegram inside the setWebhook call, and comes back on each update.
    var secret = getOrCreateWebhookSecret_();
    var separator = webhookUrl.indexOf("?") === -1 ? "?" : "&";
    var callbackUrl = webhookUrl + separator + TELEGRAM_WEBHOOK_SECRET_PARAM + "=" + secret;

    telegramFetch_("setWebhook", {
      url: callbackUrl,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"]
    });
    var info = safeParseJSON_(telegramFetch_("getWebhookInfo", {}).getContentText(), {});
    var result = (info && info.result) || {};
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL, webhookUrl);
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_STATUS, JSON.stringify({
      configured: !!result.url,
      verified: true,
      pendingUpdateCount: result.pending_update_count || 0,
      lastErrorMessage: redactSecrets_(result.last_error_message || ""),
      checkedAt: new Date().toISOString()
    }));
    return { status: "success", settings: buildTelegramSettingsView_() };
  } catch (error) {
    return { status: "error", message: redactSecrets_(error), settings: buildTelegramSettingsView_() };
  }
}

/**
 * Run once from the Apps Script editor to grant the UrlFetch scope.
 * Uses the configured token; nothing is hardcoded.
 */
function authorizeTelegramAccess() {
  if (!getBotToken_()) throw new Error("Set TELEGRAM_BOT_TOKEN in Script Properties first.");
  telegramFetch_("getMe", {});
}

// ----- apps-script/04_audit_history.gs -----------------------------------------

// ============================================================
// Audit history & backups
// ------------------------------------------------------------
// Nothing is ever silently overwritten: every Omad write is preceded by a full
// snapshot, and changed rows are archived.
// ============================================================

function backupOmadState_(doc, configSheet, reason) {
  var backupSheet = doc.getSheetByName("Omad_Backups") || doc.insertSheet("Omad_Backups");
  if (backupSheet.getLastRow() === 0) backupSheet.appendRow(["Timestamp", "Reason", "Snapshot_JSON"]);

  var snapshot = {
    transactions: readOmadTransactions_(doc),
    tenants: safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), []),
    rates: safeParseJSON_(getConfig(configSheet, "Omad_Rates"), {}),
    templateExpenses: safeParseJSON_(getConfig(configSheet, "Omad_Template_Expenses"), [])
  };

  backupSheet.appendRow([new Date().toISOString(), reason || "omad_write", JSON.stringify(snapshot)]);
}

function archiveChangedOmadTransactions_(doc, existingTransactions, incomingTransactions) {
  var archiveRows = [];
  var incomingById = {};
  for (var i = 0; i < incomingTransactions.length; i++) {
    incomingById[String(incomingTransactions[i].id || "")] = incomingTransactions[i];
  }

  for (var j = 0; j < existingTransactions.length; j++) {
    var existing = normalizeTransaction_(existingTransactions[j]);
    var incoming = incomingById[String(existing.id || "")];
    if (!incoming) {
      archiveRows.push([new Date().toISOString(), "omitted_from_active_payload", existing.id, JSON.stringify(existing)]);
    } else if (JSON.stringify(transactionToRow_(existing)) !== JSON.stringify(transactionToRow_(incoming))) {
      archiveRows.push([new Date().toISOString(), "before_update", existing.id, JSON.stringify(existing)]);
    }
  }

  if (archiveRows.length === 0) return;

  var archiveSheet = doc.getSheetByName("Omad_Transaction_Archive") || doc.insertSheet("Omad_Transaction_Archive");
  if (archiveSheet.getLastRow() === 0) archiveSheet.appendRow(["Timestamp", "Reason", "Transaction_ID", "Transaction_JSON"]);
  archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, archiveRows.length, archiveRows[0].length).setValues(archiveRows);
}

function auditTelegramSettingsChange_(updatedFields) {
  try {
    var doc = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = doc.getSheetByName("Omad_Audit_Log") || doc.insertSheet("Omad_Audit_Log");
    if (sheet.getLastRow() === 0) sheet.appendRow(["Timestamp", "Event", "Details"]);
    // Only field NAMES are stored - never values, never the token.
    sheet.appendRow([new Date().toISOString(), "telegram_settings_changed", (updatedFields || []).join(",")]);
  } catch (error) {}
}

function debugLog_(doc, eventName, details) {
  try {
    var sheet = doc.getSheetByName("Telegram_Debug_Log") || doc.insertSheet("Telegram_Debug_Log");
    if (sheet.getLastRow() === 0) sheet.appendRow(["Timestamp", "Event", "Details"]);
    sheet.appendRow([new Date().toISOString(), eventName, redactSecrets_(details).slice(0, 45000)]);
  } catch (error) {}
}

/** Appends one row to the append-only audit trail. Never throws. */
function appendAuditRow_(doc, event, details) {
  try {
    var sheet = doc.getSheetByName("Omad_Audit_Log") || doc.insertSheet("Omad_Audit_Log");
    if (sheet.getLastRow() === 0) sheet.appendRow(["Timestamp", "Event", "Details"]);
    sheet.appendRow([new Date().toISOString(), String(event), redactSecrets_(details).slice(0, 45000)]);
  } catch (error) {}
}

// ----- apps-script/05_exchange_rates.gs ----------------------------------------

// ============================================================
// Exchange rates
// ------------------------------------------------------------
// USD -> UZS conversion and the balances derived from it.
//
// Rates are keyed by canonical period ("2026-01"). A legacy month-name key
// ("Fevral") is still honoured on read so the app keeps working before the
// migration runs, but nothing writes one any more.
// ============================================================

var DEFAULT_RATE_UZS = 12500;

/**
 * The rate table.
 *
 * Called from inside the money loops -- once per tenant in the balance
 * calculation, once per transaction in the projection -- so it reads through
 * the per-request memo rather than passing over System_Config each time.
 */
function getOmadRates_() {
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  var configSheet = doc.getSheetByName("System_Config");
  if (!configSheet) return {};
  return safeParseJSON_(getConfigOnce_(configSheet, "Omad_Rates"), {});
}

function normalizeRateEntry_(rawRate) {
  if (typeof rawRate === "number") {
    return { buy: rawRate || DEFAULT_RATE_UZS, sell: rawRate || DEFAULT_RATE_UZS };
  }
  if (rawRate && typeof rawRate === "object") {
    var buy = Number(rawRate.buy || rawRate.sell || rawRate.rate) || DEFAULT_RATE_UZS;
    var sell = Number(rawRate.sell || rawRate.buy || rawRate.rate) || DEFAULT_RATE_UZS;
    return { buy: buy, sell: sell };
  }
  return { buy: DEFAULT_RATE_UZS, sell: DEFAULT_RATE_UZS };
}

/**
 * Looks a rate up by canonical period, falling back to the legacy month-name
 * key for the same month. Returns null when the period has no rate at all, so
 * callers can tell "no rate configured" from "the rate happens to be 12500".
 */
function findRateEntry_(rates, period) {
  if (!rates || typeof rates !== "object") return null;

  var key = String(period || "");
  if (Object.prototype.hasOwnProperty.call(rates, key)) return normalizeRateEntry_(rates[key]);

  if (isCanonicalPeriod_(key)) {
    var legacyKey = UZBEK_MONTHS[periodMonth_(key) - 1];
    if (Object.prototype.hasOwnProperty.call(rates, legacyKey)) {
      return normalizeRateEntry_(rates[legacyKey]);
    }
  }
  return null;
}

function getPeriodRate_(rates, period) {
  return findRateEntry_(rates, period) || { buy: DEFAULT_RATE_UZS, sell: DEFAULT_RATE_UZS };
}

function getPeriodRateByType_(rates, period, rateType) {
  var entry = getPeriodRate_(rates, period);
  return rateType === "buy" ? entry.buy : entry.sell;
}

function toUZS_(amount, currency, period, rates, rateType) {
  var numericAmount = Number(amount) || 0;
  if (currency !== "USD") return numericAmount;
  return numericAmount * getPeriodRateByType_(rates, period, rateType || "sell");
}

/** The period a transaction belongs to, whichever field carries it. */
function transactionPeriod_(transaction) {
  var t = transaction || {};
  return String(t.period || t.month || "");
}

/**
 * The two figures the Telegram report quotes. Uses the value frozen on each
 * transaction where there is one, so a later rate edit cannot move a report
 * that has already been sent.
 */
function calculateBalancesFromTransactions_(transactions, targetPeriod) {
  var rates = getOmadRates_();
  var monthBalance = 0;
  var allTimeBalance = 0;
  var list = Array.isArray(transactions) ? transactions : [];

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!isCountableTransaction_(t)) continue;
    var period = transactionPeriod_(t);
    var signed = signedTransactionUZS_(t, rates);
    allTimeBalance += signed;
    if (period === String(targetPeriod || "")) monthBalance += signed;
  }

  return { monthBalance: Math.round(monthBalance), allTimeBalance: Math.round(allTimeBalance) };
}

/**
 * Converts every legacy month-name key to a canonical period using the
 * configured fallback year. Keys that are already canonical are kept as-is.
 */
function migrateRatesMap_(rates, fallbackYear) {
  var source = rates && typeof rates === "object" ? rates : {};
  var migrated = {};
  var unresolved = [];

  Object.keys(source).forEach(function (key) {
    if (isCanonicalPeriod_(key)) {
      migrated[key] = normalizeRateEntry_(source[key]);
      return;
    }
    var period = normalizePeriodValue_(key, fallbackYear);
    if (!period) {
      unresolved.push(key);
      return;
    }
    // An explicit canonical entry always wins over a converted legacy one.
    if (!Object.prototype.hasOwnProperty.call(migrated, period)) {
      migrated[period] = normalizeRateEntry_(source[key]);
    }
  });

  return { rates: migrated, unresolved: unresolved };
}

// ----- apps-script/05a_calculations.gs -----------------------------------------

// ============================================================
// Shared money calculations
// ------------------------------------------------------------
// One implementation of every monetary rule, mirrored by
// assets/omad/02b-calc.js. The two must agree, so the rules are stated once,
// here, and both sides are tested against the same expectations.
//
// THE RATE RULE
// -------------
// Every UZS figure the business acts on - income, expenses, cash, bank, total
// balance, tenant payments, tenant debt, reports - uses the **sell** rate.
//
// Projections use the sell rate too. Mixing buy for expected income with sell
// for actual income made debt figures wrong by the spread: a tenant who paid
// exactly their rent could still show a balance. The buy rate is recorded on
// every transaction for history and is never used in a calculation.
// ============================================================

var RATE_TYPE_ACTUAL = "sell";
var RATE_TYPE_PROJECTION = "sell";

/**
 * The UZS value of one transaction.
 *
 * A ledger row carries the value frozen at write time, so editing a rate later
 * cannot move it. Legacy rows have no frozen value and are converted live -
 * which is exactly the drift the ledger removes.
 */
function transactionUZS_(transaction, rates) {
  var t = transaction || {};
  if (t.amountUZS !== undefined && t.amountUZS !== null && t.amountUZS !== "") {
    return Number(t.amountUZS) || 0;
  }
  return toUZS_(t.amount, t.currency, transactionPeriod_(t), rates || getOmadRates_(), RATE_TYPE_ACTUAL);
}

function signedTransactionUZS_(transaction, rates) {
  var value = transactionUZS_(transaction, rates);
  return transaction && transaction.type === "Expense" ? -value : value;
}

/** True when a transaction should be counted. Cancelled and corrected are not. */
function isCountableTransaction_(transaction) {
  var status = (transaction && transaction.status) || TX_STATUS_ACTIVE;
  return status === TX_STATUS_ACTIVE;
}

/**
 * Income, expense, net, and the cash/bank/total balances.
 *
 * `period` scopes income/expense/net. Balances are always all-time: money in
 * the safe does not reset when you change the reporting month.
 */
function calculateActuals_(transactions, period) {
  var rates = getOmadRates_();
  var result = { income: 0, expense: 0, net: 0, cash: 0, bank: 0, total: 0 };
  var list = Array.isArray(transactions) ? transactions : [];

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!isCountableTransaction_(t)) continue;

    var value = transactionUZS_(t, rates);
    var signed = t.type === "Expense" ? -value : value;

    if (t.method === "Bank") result.bank += signed; else result.cash += signed;

    if (!period || period === ALL_PERIODS_LABEL || transactionPeriod_(t) === period) {
      if (t.type === "Expense") result.expense += value; else result.income += value;
    }
  }

  result.net = result.income - result.expense;
  result.total = result.cash + result.bank;

  return roundMoneyFields_(result);
}

function roundMoneyFields_(values) {
  var rounded = {};
  Object.keys(values).forEach(function (key) { rounded[key] = Math.round(values[key]); });
  return rounded;
}

/** What a tenant actually paid in a period, at the sell rate. */
function calculateTenantPaid_(transactions, tenantName, period) {
  var rates = getOmadRates_();
  var key = String(tenantName || "").trim();
  var total = 0;
  var list = Array.isArray(transactions) ? transactions : [];

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!isCountableTransaction_(t)) continue;
    if (t.type !== "Income") continue;
    if (String(t.tenant || "").trim() !== key) continue;
    if (period && period !== ALL_PERIODS_LABEL && transactionPeriod_(t) !== period) continue;
    total += transactionUZS_(t, rates);
  }
  return Math.round(total);
}

/**
 * What every tenant paid in a period, from one pass over the ledger.
 *
 * `calculateTenantPaid_` walks the whole ledger to answer for one tenant, so
 * asking about sixteen tenants walked it sixteen times. The filter is per
 * tenant but the pass is not, so the pass is done once and the results are
 * bucketed by name. Same rules, same rounding, same answer -- see the test
 * that asserts the two agree tenant by tenant.
 *
 * Keys are the trimmed tenant name, exactly as `calculateTenantPaid_` matches.
 */
function tenantPaidTotals_(transactions, period) {
  var rates = getOmadRates_();
  var totals = {};
  var list = Array.isArray(transactions) ? transactions : [];

  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!isCountableTransaction_(t)) continue;
    if (t.type !== "Income") continue;
    if (period && period !== ALL_PERIODS_LABEL && transactionPeriod_(t) !== period) continue;
    var key = String(t.tenant || "").trim();
    totals[key] = (totals[key] || 0) + transactionUZS_(t, rates);
  }

  Object.keys(totals).forEach(function (key) { totals[key] = Math.round(totals[key]); });
  return totals;
}

/**
 * The rent expected from a tenant in a period, at the sell rate.
 * The amount comes from the tenant's effective-dated schedule, so a month with
 * an exception, a no-rent month, or a month outside the agreement all resolve
 * correctly - and a historical month keeps the rent that applied then.
 */
function tenantExpectedRentUZS_(tenant, period) {
  var t = tenant || {};
  var rent = effectiveTenantRent_(t, period);
  if (rent <= 0) return 0;
  return Math.round(toUZS_(rent, t.currency, period, getOmadRates_(), RATE_TYPE_PROJECTION));
}

/**
 * A tenant's position for a period.
 * Negative `difference` is debt; positive is an overpayment.
 *
 * `paidTotals` is optional: pass the map from `tenantPaidTotals_` when asking
 * about several tenants over the same rows, and the ledger is walked once for
 * all of them instead of once each. Omit it and the single-tenant path runs,
 * which is what every existing caller does.
 */
function calculateTenantBalance_(transactions, tenant, period, paidTotals) {
  var expected = tenantExpectedRentUZS_(tenant, period);
  var name = String((tenant && tenant.name) || "").trim();
  var paid = paidTotals
    ? (paidTotals[name] || 0)
    : calculateTenantPaid_(transactions, tenant && tenant.name, period);
  return { expected: expected, paid: paid, difference: paid - expected };
}

/**
 * Expected income and planned expenses for a period.
 *
 * Projections are a plan, not money that moved: a planned expense is never
 * counted as paid. Compare it with `calculateActuals_` rather than adding the
 * two together - see `comparePlanToActual_`.
 */
function calculateProjection_(tenants, plannedExpenses, period) {
  var rates = getOmadRates_();
  var expectedIncome = 0;
  var plannedExpense = 0;

  var tenantList = Array.isArray(tenants) ? tenants : [];
  for (var i = 0; i < tenantList.length; i++) {
    expectedIncome += tenantExpectedRentUZS_(tenantList[i], period);
  }


  // Recurrence decides which expenses fall due, not a stored month. Callers
  // may pass raw records, so they are normalised here.
  var due = plannedExpensesForPeriod_(normalizeTemplateExpenses_(plannedExpenses), period);
  for (var j = 0; j < due.length; j++) {
    plannedExpense += toUZS_(due[j].expense.amount, due[j].expense.currency, period, rates, RATE_TYPE_PROJECTION);
  }

  return roundMoneyFields_({
    expectedIncome: expectedIncome,
    plannedExpense: plannedExpense,
    net: expectedIncome - plannedExpense
  });
}

/**
 * Plan against reality for one period, side by side.
 *
 * `plannedExpense` is what was scheduled; `actualExpense` is what actually
 * left. They are deliberately never summed: a planned expense that has been
 * paid appears in both, and adding them would double-count it. `outstanding`
 * is what is still expected to leave, floored at zero.
 */
function comparePlanToActual_(transactions, tenants, plannedExpenses, period) {
  var projection = calculateProjection_(tenants, plannedExpenses, period);
  var actuals = calculateActuals_(transactions, period);

  return {
    period: period,
    expectedIncome: projection.expectedIncome,
    actualIncome: actuals.income,
    plannedExpense: projection.plannedExpense,
    actualExpense: actuals.expense,
    // What is still expected, not a total.
    outstandingIncome: Math.max(0, projection.expectedIncome - actuals.income),
    outstandingExpense: Math.max(0, projection.plannedExpense - actuals.expense),
    projectedNet: projection.net,
    actualNet: actuals.net
  };
}

// ----- apps-script/06_tenants.gs -----------------------------------------------

// ============================================================
// Tenants & rent schedules
// ------------------------------------------------------------
// A tenant's rent is effective-dated, not a single number.
//
//   defaultRent   what the agreement says
//   startPeriod   when the agreement begins ("" = always has)
//   endPeriod     when it ends ("" = open-ended)
//   rentChanges   [{ fromPeriod, amount }] - a new default from a period on
//   exceptions    [{ period, amount }] - one month at a different amount
//   noRentPeriods ["2026-12"] - one month with no rent at all
//   active        an inactive tenant is owed nothing, and can be reactivated
//
// Resolution order is deliberate: a no-rent month beats an exception, an
// exception beats a scheduled change, and a scheduled change beats the
// default. Anything outside start/end is zero regardless.
//
// Legacy tenants stored `{ name, rent, currency, disabledMonths }`. Those are
// still honoured: `rent` becomes the default and `disabledMonths` keeps
// working as month names that repeat every year.
// ============================================================

function normalizeTenantList_(tenants) {
  var source = Array.isArray(tenants) ? tenants : [];
  var normalized = [];
  for (var i = 0; i < source.length; i++) {
    var item = source[i];
    var tenant = typeof item === "string" ? { name: item } : (item || {});
    var name = String(tenant.name || "").trim();
    if (!name) continue;
    normalized.push(normalizeTenant_(tenant, name));
  }
  return normalized;
}

function normalizeTenant_(tenant, name) {
  var defaultRent = tenant.defaultRent !== undefined
    ? (Number(tenant.defaultRent) || 0)
    : (Number(tenant.rent) || 0);

  return {
    name: name,
    // `rent` is kept in step with `defaultRent` so older readers still work.
    rent: defaultRent,
    defaultRent: defaultRent,
    currency: tenant.currency === "UZS" ? "UZS" : "USD",
    active: tenant.active === undefined ? true : tenant.active !== false,
    startPeriod: isCanonicalPeriod_(tenant.startPeriod) ? tenant.startPeriod : "",
    endPeriod: isCanonicalPeriod_(tenant.endPeriod) ? tenant.endPeriod : "",
    rentChanges: normalizeRentChanges_(tenant.rentChanges),
    exceptions: normalizeRentExceptions_(tenant.exceptions),
    noRentPeriods: normalizePeriodList_(tenant.noRentPeriods),
    disabledMonths: Array.isArray(tenant.disabledMonths) ? tenant.disabledMonths : []
  };
}

/** Scheduled default-rent changes, earliest first, one per period. */
function normalizeRentChanges_(changes) {
  var source = Array.isArray(changes) ? changes : [];
  var byPeriod = {};
  for (var i = 0; i < source.length; i++) {
    var change = source[i] || {};
    if (!isCanonicalPeriod_(change.fromPeriod)) continue;
    var amount = Number(change.amount);
    if (!isFinite(amount) || amount < 0) continue;
    byPeriod[change.fromPeriod] = amount;
  }
  return Object.keys(byPeriod).sort().map(function (period) {
    return { fromPeriod: period, amount: byPeriod[period] };
  });
}

/** One-month overrides, earliest first, one per period. */
function normalizeRentExceptions_(exceptions) {
  var source = Array.isArray(exceptions) ? exceptions : [];
  var byPeriod = {};
  for (var i = 0; i < source.length; i++) {
    var exception = source[i] || {};
    if (!isCanonicalPeriod_(exception.period)) continue;
    var amount = Number(exception.amount);
    if (!isFinite(amount) || amount < 0) continue;
    byPeriod[exception.period] = amount;
  }
  return Object.keys(byPeriod).sort().map(function (period) {
    return { period: period, amount: byPeriod[period] };
  });
}

function normalizePeriodList_(periods) {
  var source = Array.isArray(periods) ? periods : [];
  var seen = {};
  for (var i = 0; i < source.length; i++) {
    if (isCanonicalPeriod_(source[i])) seen[source[i]] = true;
  }
  return Object.keys(seen).sort();
}

/** True when the agreement covers this period at all. */
function isTenantInScheduleForPeriod_(tenant, period) {
  var t = tenant || {};
  if (t.active === false) return false;
  if (!isCanonicalPeriod_(period)) return false;
  if (t.startPeriod && comparePeriods_(period, t.startPeriod) < 0) return false;
  if (t.endPeriod && comparePeriods_(period, t.endPeriod) > 0) return false;
  return true;
}

/**
 * Legacy month-name switches. A disabled month repeats every year, which is
 * exactly why the schedule fields replace it; it stays honoured so existing
 * tenant records keep behaving as their operator set them up.
 */
function isTenantDisabledForPeriod_(tenant, period) {
  var disabled = (tenant && Array.isArray(tenant.disabledMonths)) ? tenant.disabledMonths : [];
  if (disabled.length === 0) return false;
  if (disabled.indexOf(period) !== -1) return true;
  var month = periodMonth_(period);
  return month > 0 && disabled.indexOf(UZBEK_MONTHS[month - 1]) !== -1;
}

/**
 * The rent actually due from a tenant in one period, in the tenant's own
 * currency. Zero means nothing is owed - which is different from "no rent
 * configured", and both are legitimate.
 */
function effectiveTenantRent_(tenant, period) {
  var t = tenant || {};
  if (!isTenantInScheduleForPeriod_(t, period)) return 0;
  if (isTenantDisabledForPeriod_(t, period)) return 0;

  var noRent = Array.isArray(t.noRentPeriods) ? t.noRentPeriods : [];
  if (noRent.indexOf(period) !== -1) return 0;

  var exceptions = Array.isArray(t.exceptions) ? t.exceptions : [];
  for (var i = 0; i < exceptions.length; i++) {
    if (exceptions[i].period === period) return Number(exceptions[i].amount) || 0;
  }

  // The latest scheduled change that has already taken effect wins.
  var amount = t.defaultRent !== undefined ? Number(t.defaultRent) || 0 : Number(t.rent) || 0;
  var changes = Array.isArray(t.rentChanges) ? t.rentChanges : [];
  for (var j = 0; j < changes.length; j++) {
    if (comparePeriods_(changes[j].fromPeriod, period) <= 0) amount = Number(changes[j].amount) || 0;
  }
  return amount;
}

/** Why a period resolved the way it did - shown in the schedule editor. */
function tenantRentSource_(tenant, period) {
  var t = tenant || {};
  if (t.active === false) return "inactive";
  if (t.startPeriod && comparePeriods_(period, t.startPeriod) < 0) return "before_start";
  if (t.endPeriod && comparePeriods_(period, t.endPeriod) > 0) return "after_end";
  if (isTenantDisabledForPeriod_(t, period)) return "disabled_month";

  var noRent = Array.isArray(t.noRentPeriods) ? t.noRentPeriods : [];
  if (noRent.indexOf(period) !== -1) return "no_rent";

  var exceptions = Array.isArray(t.exceptions) ? t.exceptions : [];
  for (var i = 0; i < exceptions.length; i++) {
    if (exceptions[i].period === period) return "exception";
  }

  var changes = Array.isArray(t.rentChanges) ? t.rentChanges : [];
  for (var j = changes.length - 1; j >= 0; j--) {
    if (comparePeriods_(changes[j].fromPeriod, period) <= 0) return "scheduled_change";
  }
  return "default";
}

/** The whole year at a glance, for the schedule editor. */
function tenantScheduleForYear_(tenant, year) {
  var rows = [];
  for (var month = 1; month <= 12; month++) {
    var period = buildPeriod_(year, month);
    rows.push({
      period: period,
      label: formatPeriodLabel_(period),
      rent: effectiveTenantRent_(tenant, period),
      currency: (tenant && tenant.currency) || "USD",
      source: tenantRentSource_(tenant, period)
    });
  }
  return rows;
}

function mergeTenantsByName_(existingTenants, incomingTenants) {
  var merged = [];
  var indexByName = {};
  for (var i = 0; i < existingTenants.length; i++) {
    merged.push(existingTenants[i]);
    indexByName[existingTenants[i].name] = i;
  }
  for (var j = 0; j < incomingTenants.length; j++) {
    var incoming = incomingTenants[j];
    if (indexByName[incoming.name] === undefined) {
      indexByName[incoming.name] = merged.length;
      merged.push(incoming);
    } else {
      var existing = merged[indexByName[incoming.name]];
      // An incoming record replaces the stored one, except that a legacy
      // client which does not know about `disabledMonths` must not wipe them.
      merged[indexByName[incoming.name]] = Object.assign({}, incoming, {
        disabledMonths: Array.isArray(incoming.disabledMonths) && incoming.disabledMonths.length > 0
          ? incoming.disabledMonths
          : (incoming.disabledMonths || existing.disabledMonths || [])
      });
    }
  }
  return merged;
}

/** Tenants whose agreement is live right now - what the Telegram bot offers. */
function getActiveTenantNames_(configSheet) {
  var tenants = normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), []));
  var period = currentPeriod_();
  var names = [];
  for (var i = 0; i < tenants.length; i++) {
    if (tenants[i].active === false) continue;
    if (tenants[i].endPeriod && comparePeriods_(period, tenants[i].endPeriod) > 0) continue;
    names.push(tenants[i].name);
  }
  return names;
}

// ----- apps-script/07_planned_expenses.gs --------------------------------------

// ============================================================
// Planned expenses
// ------------------------------------------------------------
// A planned expense is a *plan*: it says money is expected to leave in given
// periods. It is never money that moved. Nothing here is ever counted as paid
// - only a real expense transaction is - so projected and actual figures are
// reported side by side and never summed.
//
// Frequencies: once, monthly, every 2/3/6/12 months, selected months of the
// year, or a custom interval.
// Ending rules: never, until a period, or after a number of occurrences.
//
// Legacy `{ id, month, name, amount, currency }` records are read as one-time
// expenses in that month, so nothing needs migrating.
// ============================================================

var EXPENSE_FREQ_ONCE = "once";
var EXPENSE_FREQ_MONTHLY = "monthly";
var EXPENSE_FREQ_SELECTED = "selected_months";
var EXPENSE_FREQ_CUSTOM = "custom_interval";

/** Frequency -> the interval in months. 0 means "not interval-based". */
var EXPENSE_FREQUENCY_INTERVALS = {
  once: 0,
  monthly: 1,
  every_2_months: 2,
  every_3_months: 3,
  every_6_months: 6,
  every_12_months: 12,
  selected_months: 0,
  custom_interval: 0
};

var EXPENSE_END_NEVER = "never";
var EXPENSE_END_UNTIL = "until_period";
var EXPENSE_END_COUNT = "after_occurrences";

/** A generous bound so a malformed record can never loop forever. */
var EXPENSE_MAX_LOOKBACK_MONTHS = 1200;

function normalizeTemplateExpenses_(expenses) {
  var source = Array.isArray(expenses) ? expenses : [];
  var normalized = [];
  for (var i = 0; i < source.length; i++) {
    var item = normalizePlannedExpense_(source[i], i);
    if (item) normalized.push(item);
  }
  return normalized;
}

function normalizePlannedExpense_(rawExpense, index) {
  var expense = rawExpense && typeof rawExpense === "object" ? rawExpense : {};
  var name = String(expense.name || "").trim();
  if (!name) return null;

  // Legacy records carry `month` and nothing else; they are one-time expenses.
  var startPeriod = isCanonicalPeriod_(expense.startPeriod) ? expense.startPeriod
    : (isCanonicalPeriod_(expense.month) ? expense.month
    : (isCanonicalPeriod_(expense.period) ? expense.period : ""));

  var frequency = EXPENSE_FREQUENCY_INTERVALS[expense.frequency] !== undefined
    ? expense.frequency
    : EXPENSE_FREQ_ONCE;

  var intervalMonths = Math.floor(Number(expense.intervalMonths) || 0);
  if (frequency === EXPENSE_FREQ_CUSTOM && (intervalMonths < 1 || intervalMonths > 120)) {
    // An unusable custom interval degrades to monthly rather than vanishing.
    frequency = EXPENSE_FREQ_MONTHLY;
    intervalMonths = 0;
  }

  return {
    id: String(expense.id || (new Date().getTime() + "_" + index)),
    name: name,
    amount: Number(expense.amount) || 0,
    currency: expense.currency === "USD" ? "USD" : "UZS",
    startPeriod: startPeriod,
    // `month` mirrors the start so older readers keep working.
    month: startPeriod,
    frequency: frequency,
    intervalMonths: frequency === EXPENSE_FREQ_CUSTOM ? intervalMonths : 0,
    selectedMonths: normalizeSelectedMonths_(expense.selectedMonths),
    ending: normalizeExpenseEnding_(expense.ending),
    active: expense.active === undefined ? true : expense.active !== false,
    description: String(expense.description || "").slice(0, 500)
  };
}

function normalizeSelectedMonths_(months) {
  var source = Array.isArray(months) ? months : [];
  var seen = {};
  for (var i = 0; i < source.length; i++) {
    var month = Math.floor(Number(source[i]));
    if (month >= 1 && month <= 12) seen[month] = true;
  }
  return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
}

function normalizeExpenseEnding_(ending) {
  var value = ending && typeof ending === "object" ? ending : {};

  if (value.type === EXPENSE_END_UNTIL && isCanonicalPeriod_(value.untilPeriod)) {
    return { type: EXPENSE_END_UNTIL, untilPeriod: value.untilPeriod, occurrences: 0 };
  }
  if (value.type === EXPENSE_END_COUNT) {
    var occurrences = Math.floor(Number(value.occurrences) || 0);
    if (occurrences >= 1) return { type: EXPENSE_END_COUNT, untilPeriod: "", occurrences: occurrences };
  }
  return { type: EXPENSE_END_NEVER, untilPeriod: "", occurrences: 0 };
}

/** Whole months between two canonical periods; negative when `to` precedes `from`. */
function monthsBetweenPeriods_(fromPeriod, toPeriod) {
  return (periodYear_(toPeriod) * 12 + periodMonth_(toPeriod)) -
         (periodYear_(fromPeriod) * 12 + periodMonth_(fromPeriod));
}

/** True when the frequency alone puts an occurrence in this period. */
function matchesExpenseFrequency_(expense, period) {
  var offset = monthsBetweenPeriods_(expense.startPeriod, period);
  if (offset < 0) return false;

  if (expense.frequency === EXPENSE_FREQ_ONCE) return offset === 0;
  if (expense.frequency === EXPENSE_FREQ_SELECTED) {
    return expense.selectedMonths.indexOf(periodMonth_(period)) !== -1;
  }
  if (expense.frequency === EXPENSE_FREQ_CUSTOM) {
    return expense.intervalMonths > 0 && offset % expense.intervalMonths === 0;
  }

  var interval = EXPENSE_FREQUENCY_INTERVALS[expense.frequency] || 1;
  return offset % interval === 0;
}

/**
 * The 1-based occurrence number for a period, or 0 when the expense does not
 * fall due then. Needed by the "end after N occurrences" rule, and useful in
 * the UI ("3 of 12").
 */
function plannedExpenseOccurrence_(expense, period) {
  var e = expense || {};
  if (e.active === false) return 0;
  if (!isCanonicalPeriod_(period) || !isCanonicalPeriod_(e.startPeriod)) return 0;
  if (!matchesExpenseFrequency_(e, period)) return 0;

  var ending = e.ending || { type: EXPENSE_END_NEVER };
  if (ending.type === EXPENSE_END_UNTIL && comparePeriods_(period, ending.untilPeriod) > 0) return 0;

  var offset = monthsBetweenPeriods_(e.startPeriod, period);
  if (offset > EXPENSE_MAX_LOOKBACK_MONTHS) return 0;

  // Count the occurrences from the start up to and including this period.
  var occurrence = 0;
  for (var step = 0; step <= offset; step++) {
    if (matchesExpenseFrequency_(e, addMonthsToPeriod_(e.startPeriod, step))) occurrence++;
  }

  if (ending.type === EXPENSE_END_COUNT && occurrence > ending.occurrences) return 0;
  return occurrence;
}

function plannedExpenseAppliesTo_(expense, period) {
  return plannedExpenseOccurrence_(expense, period) > 0;
}

/** Every planned expense that falls due in a period, with its occurrence number. */
function plannedExpensesForPeriod_(expenses, period) {
  var list = Array.isArray(expenses) ? expenses : [];
  var due = [];
  for (var i = 0; i < list.length; i++) {
    var occurrence = plannedExpenseOccurrence_(list[i], period);
    if (occurrence > 0) due.push({ expense: list[i], occurrence: occurrence });
  }
  return due;
}

/**
 * A human-readable summary of when an expense falls due. Kept here so both
 * sides describe a schedule identically.
 */
function describePlannedExpense_(expense) {
  var e = expense || {};
  var labels = {
    once: "Bir marta",
    monthly: "Har oy",
    every_2_months: "Har 2 oyda",
    every_3_months: "Har 3 oyda",
    every_6_months: "Har 6 oyda",
    every_12_months: "Har yili"
  };

  var frequency = labels[e.frequency];
  if (e.frequency === EXPENSE_FREQ_SELECTED) {
    var names = (e.selectedMonths || []).map(function (month) { return UZBEK_MONTHS_SHORT[month - 1]; });
    frequency = names.length ? names.join(", ") : "Oylar tanlanmagan";
  } else if (e.frequency === EXPENSE_FREQ_CUSTOM) {
    frequency = "Har " + e.intervalMonths + " oyda";
  }

  var rule = e.ending || {};
  var ending = "";
  if (rule.type === EXPENSE_END_UNTIL) ending = formatPeriodLabel_(rule.untilPeriod) + " gacha";
  else if (rule.type === EXPENSE_END_COUNT) ending = rule.occurrences + " marta";

  var parts = [formatPeriodLabel_(e.startPeriod) + " dan", frequency];
  if (ending) parts.push(ending);
  return parts.join(" • ");
}

// ----- apps-script/08_omad_transactions.gs -------------------------------------

// ============================================================
// Omad transactions
// ------------------------------------------------------------
// The financial ledger: read, normalise, append and rewrite.
//
// Reads are period-aware: every transaction comes back with a canonical
// `period` ("2026-01") resolved from its stored month and date, whether or not
// the sheet itself has been migrated yet. Reads also follow the cutover flag,
// so pointing the app at the migrated V2 sheet is a one-line config change and
// pointing it back is the rollback.
// ============================================================

var OMAD_TRANSACTIONS_SHEET = "Omad_Transactions";
var OMAD_TRANSACTIONS_V2_SHEET = "Omad_Transactions_V2";
/** System_Config key naming the sheet reads and writes go to. */
var OMAD_ACTIVE_TX_SHEET_KEY = "Omad_Active_Transactions_Sheet";

var OMAD_TRANSACTION_HEADER = [
  "ID", "Tenant", "Month", "Type", "Amount", "Currency", "Method", "Date", "Comment",
  "Telegram_Msg_ID", "Request_ID", "Entry_Group_ID", "Entry_Kind"
];

/** Column 12. One business action's rows all carry the same value. */
var OMAD_GROUP_ID_COLUMN = 12;

/**
 * Column 13. *What* business action the group is.
 *
 * "" is an ordinary entry — one or more lines of a single income or expense.
 * A named kind says the group has a shape the reader must respect: the
 * tenant-paid pair is one income and one expense that only make sense
 * together, and reporting and history both need to know that without having
 * to guess it back from the rows.
 */
var OMAD_ENTRY_KIND_COLUMN = 13;

var ENTRY_KIND_ORDINARY = "";
var ENTRY_KIND_TENANT_PAID = "tenant_paid_expense";

var ENTRY_KINDS = {};
ENTRY_KINDS[ENTRY_KIND_TENANT_PAID] = true;

function normalizeEntryKind_(value) {
  var kind = String(value === null || value === undefined ? "" : value).trim();
  return ENTRY_KINDS[kind] ? kind : ENTRY_KIND_ORDINARY;
}

function ensureOmadTransactionHeader_(sheet) {
  var header = OMAD_TRANSACTION_HEADER;
  // Never stamp the thirteen-column legacy header onto the twenty-four column
  // ledger. The check below compares the first and last legacy columns, and on
  // a ledger sheet the last one is Rate_Sell -- so it would "repair" the
  // header by destroying it.
  if (sheet && sheet.getName && sheet.getName() === OMAD_TRANSACTIONS_V2_SHEET) return;
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(header);
    return;
  }
  var firstRow = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  // Upgrades a legacy 10- or 11-column header in place; existing rows keep
  // their data and simply carry an empty Request_ID / Entry_Group_ID.
  if (firstRow[0] !== "ID" || firstRow[header.length - 1] !== header[header.length - 1]) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

/**
 * The value written into the Date column.
 *
 * Text like "05/08/2026" is read back through the spreadsheet's own locale,
 * which is how 5 August became 8 May. A real date carries no ordering to
 * misread, so anything that can be understood is written as one. Text that
 * cannot be interpreted is left exactly as it is rather than guessed at.
 */
function toSheetDateValue_(value) {
  if (value && typeof value === "object" && typeof value.getFullYear === "function") {
    return isNaN(value.getTime()) ? "" : value;
  }
  var parsed = parseTransactionDate_(value);
  if (!parsed) return value === null || value === undefined ? "" : value;
  return new Date(parsed.year, parsed.month - 1, parsed.day || 1);
}

/**
 * Stops the spreadsheet reinterpreting what is written.
 *
 * The Month column holds "2026-08"; formatted as text it stays that way
 * instead of collapsing into 1 August. The Date column is given an explicit
 * day/month format so it also reads back the way it was written.
 *
 * These column numbers are the legacy layout's. The ledger has its own shape
 * and its own helper, so callers pass its name to opt out.
 */
function applyTransactionColumnFormats_(sheet, startRow, numRows, sheetName) {
  if (sheetName === OMAD_TRANSACTIONS_V2_SHEET) return;
  if (!sheet || numRows < 1 || typeof sheet.getRange !== "function") return;
  var monthRange = sheet.getRange(startRow, 3, numRows, 1);
  if (typeof monthRange.setNumberFormat !== "function") return;
  monthRange.setNumberFormat("@");
  sheet.getRange(startRow, 8, numRows, 1).setNumberFormat("dd/MM/yyyy");
}

// ------------------------------------------------------------- entry groups
//
// A business action can be several accounting rows: two currencies on one
// payment, or the tenant-paid-on-our-behalf pair that is one income and one
// expense. Every row keeps its own transaction id; the rows that belong
// together share one immutable Entry_Group_ID.
//
// The group id is *stored*, never inferred. Timestamps collide, and the
// "<epochMillis>_<n>" id prefix cannot express a group whose rows were written
// at different times or under different ids. The only exception is the
// deterministic backfill below, which exists solely to give rows written before
// the column existed a stable identity.

var OMAD_GROUP_ID_PREFIX = "grp_";
var OMAD_LEGACY_GROUP_ID_PREFIX = "grp_legacy_";

/** A fresh, immutable group id for one new business action. */
function newEntryGroupId_() {
  return OMAD_GROUP_ID_PREFIX + Utilities.getUuid().split("-").join("");
}

/**
 * The group id for a row that predates the column.
 *
 * Deterministic, so running the backfill twice — or backfilling a row that a
 * report job already resolved in memory — always produces the same value. The
 * base of "<epochMillis>_<n>" is what the whole-list save has always used to
 * keep the lines of one entry together, so this preserves exactly the grouping
 * the data already had, without ever being consulted for a row that carries a
 * real stored group id.
 */
function legacyEntryGroupId_(transactionId) {
  var base = String(transactionId === null || transactionId === undefined ? "" : transactionId).split("_")[0];
  if (!base) return "";
  return OMAD_LEGACY_GROUP_ID_PREFIX + base;
}

/** The stored group id, or the deterministic backfill when there is none. */
function resolveEntryGroupId_(transaction) {
  var stored = String((transaction && transaction.groupId) || "").trim();
  if (stored) return stored;
  return legacyEntryGroupId_(transaction && transaction.id);
}

function transactionToRow_(t) {
  return [
    t.id, t.tenant, t.month, t.type, t.amount, t.currency, t.method,
    toSheetDateValue_(t.date),
    t.comment || "", t.msgId || "", t.requestId || "", t.groupId || "", t.entryKind || ""
  ];
}

function normalizeTransactions_(transactions) {
  var safeTransactions = Array.isArray(transactions) ? transactions : [];
  var normalized = [];
  for (var i = 0; i < safeTransactions.length; i++) normalized.push(normalizeTransaction_(safeTransactions[i]));
  return normalized;
}

function normalizeTransaction_(raw) {
  var t = raw && typeof raw === "object" ? raw : {};
  // `month` holds the canonical period for anything written from now on.
  // Legacy month names are preserved verbatim rather than guessed at; the
  // migration is where they get a year, under operator control.
  return {
    id: String(t.id || (Date.now() + "_0")),
    tenant: String(t.tenant || "").trim(),
    // normalizeMonthValue_ keeps a period a period: a Month cell the
    // spreadsheet turned into a date becomes "2026-08" again rather than
    // being stringified into "Sat Aug 01 2026 ...".
    month: normalizeMonthValue_(t.month || t.period || currentPeriod_()),
    type: t.type === "Expense" ? "Expense" : "Income",
    amount: Number(t.amount) || 0,
    currency: t.currency === "USD" ? "USD" : "UZS",
    method: t.method === "Bank" ? "Bank" : "Naqd",
    date: t.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy"),
    comment: t.comment || "",
    msgId: t.msgId || "",
    requestId: String(t.requestId || ""),
    // Preserved when the caller supplies one, derived deterministically when it
    // does not, so a row written before the column existed still resolves to a
    // stable group instead of to "".
    groupId: resolveEntryGroupId_(t),
    entryKind: normalizeEntryKind_(t.entryKind)
  };
}

/** The sheet reads and writes go to: the migrated V2 sheet after cutover. */
function activeTransactionSheetName_(doc) {
  var configSheet = doc.getSheetByName("System_Config");
  if (!configSheet) return OMAD_TRANSACTIONS_SHEET;
  var configured = String(getConfigOnce_(configSheet, OMAD_ACTIVE_TX_SHEET_KEY) || "").trim();
  if (configured && doc.getSheetByName(configured)) return configured;
  return OMAD_TRANSACTIONS_SHEET;
}

/**
 * Active transactions in the shape the rest of the app expects.
 *
 * After cutover this reads the append-only ledger and returns only Active
 * rows; before cutover it reads the legacy sheet and resolves periods in
 * memory. Callers do not need to know which.
 */
function readOmadTransactions_(doc) {
  if (isLedgerActive_(doc)) return listActiveTransactions_(doc, {});
  return readTransactionsFromSheet_(doc, OMAD_TRANSACTIONS_SHEET);
}

/**
 * Reads a transaction sheet and attaches the resolved canonical period to
 * every row. Used by both normal reads and the migration preview, so the
 * preview shows exactly what the app would compute.
 */
function readTransactionsFromSheet_(doc, sheetName) {
  var txSheet = doc.getSheetByName(sheetName);
  var transactions = [];
  if (!txSheet || txSheet.getLastRow() < 2) return transactions;

  var configSheet = doc.getSheetByName("System_Config");
  var fallbackYear = getFallbackYear_(configSheet);
  var data = txSheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === "" || data[i][0] === null || data[i][0] === undefined) continue;
    var transaction = {
      id: data[i][0], tenant: data[i][1], month: data[i][2], type: data[i][3],
      amount: data[i][4], currency: data[i][5], method: data[i][6],
      date: data[i][7], comment: data[i][8], msgId: data[i][9],
      // Legacy 10-column rows simply have no request id.
      requestId: data[i].length > 10 ? data[i][10] : ""
    };
    // Rows written before the column existed resolve to their deterministic
    // group id in memory, so every reader sees a group whether or not the
    // backfill has been run against the sheet.
    transaction.groupId = String((data[i].length > 11 ? data[i][11] : "") || "").trim() ||
      legacyEntryGroupId_(transaction.id);
    transaction.entryKind = normalizeEntryKind_(data[i].length > 12 ? data[i][12] : "");
    var resolved = resolveTransactionPeriod_(transaction, fallbackYear);
    transaction.period = resolved.period;
    transaction.periodSource = resolved.source;
    transaction.periodLabel = formatPeriodLabel_(resolved.period);
    transactions.push(transaction);
  }
  return transactions;
}

/** Returns the existing transaction for a request id, or null. */
function findTransactionByRequestId_(doc, requestId) {
  if (!requestId) return null;
  var all = readOmadTransactions_(doc);
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].requestId || "") === String(requestId)) return all[i];
  }
  return null;
}

/**
 * Every row of one business action, found by its stored group id.
 *
 * This is the grouping reporting, editing, cancellation and history use. It
 * asks the data what belongs together rather than deducing it from an id
 * shape, which is what lets one entry span two transaction types.
 */
function findTransactionsByGroupId_(doc, groupId) {
  var wanted = String(groupId || "").trim();
  if (!wanted) return [];
  var all = readOmadTransactions_(doc);
  var group = [];
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].groupId || "") === wanted) group.push(all[i]);
  }
  return group;
}

/**
 * Transactions whose id is "<baseId>" or "<baseId>_<n>".
 *
 * Kept for queued jobs written before group ids existed: a job sitting on
 * Omad_Job_Queue across the deploy carries only a baseId, and must still find
 * its rows. New work goes through findTransactionsByGroupId_.
 */
function findTransactionGroup_(doc, baseId) {
  var all = readOmadTransactions_(doc);
  var group = [];
  var prefix = String(baseId) + "_";
  for (var i = 0; i < all.length; i++) {
    var id = String(all[i].id || "");
    if (id === String(baseId) || id.indexOf(prefix) === 0) group.push(all[i]);
  }
  return group;
}

/**
 * Appends several rows of one business action in a single write.
 *
 * One setValues call is one spreadsheet operation: either every row of the
 * group lands or none of them does. That is what makes a two-entry action —
 * the tenant-paid-on-our-behalf pair — impossible to half-create.
 */
function appendOmadTransactionGroup_(doc, transactions) {
  var rows = Array.isArray(transactions) ? transactions : [];
  if (rows.length === 0) return [];

  // The ledger has its own writer for a group -- writeTenantPaidToLedger_ --
  // because a ledger row carries a frozen rate this function has no way to
  // produce. Every caller already branches on isLedgerActive_; refusing is
  // how the next one finds out rather than discovering it in the sheet.
  if (isLedgerActive_(doc)) {
    throw new Error("appendOmadTransactionGroup_ legacy varaq uchun. Ledger uchun writeTenantPaidToLedger_ ishlating.");
  }

  var sheetName = activeTransactionSheetName_(doc);
  var txSheet = doc.getSheetByName(sheetName) || doc.insertSheet(sheetName);
  ensureOmadTransactionHeader_(txSheet);

  var normalized = [];
  var values = [];
  for (var i = 0; i < rows.length; i++) {
    var transaction = normalizeTransaction_(rows[i]);
    normalized.push(transaction);
    values.push(transactionToRow_(transaction));
  }

  var startRow = txSheet.getLastRow() + 1;
  applyTransactionColumnFormats_(txSheet, startRow, values.length, sheetName);
  txSheet.getRange(startRow, 1, values.length, OMAD_TRANSACTION_HEADER.length).setValues(values);
  bumpDataRevision_(CACHE_SCOPE_OMAD);
  return normalized;
}

/**
 * Writes the deterministic group id onto rows that predate the column.
 *
 * Idempotent: a row that already carries a group id is left exactly as it is,
 * so this can be run repeatedly and can never re-group anything.
 */
function backfillEntryGroupIds_(doc) {
  var sheetName = activeTransactionSheetName_(doc);
  if (sheetName === OMAD_TRANSACTIONS_V2_SHEET) return backfillLedgerEntryGroupIds_(doc);

  var txSheet = doc.getSheetByName(sheetName);
  if (!txSheet || txSheet.getLastRow() < 2) return { status: "success", filled: 0, alreadySet: 0 };

  ensureOmadTransactionHeader_(txSheet);
  var data = txSheet.getDataRange().getValues();
  var filled = 0;
  var alreadySet = 0;

  for (var i = 1; i < data.length; i++) {
    var id = data[i][0];
    if (id === "" || id === null || id === undefined) continue;
    var current = String((data[i].length > 11 ? data[i][11] : "") || "").trim();
    if (current) { alreadySet++; continue; }
    var derived = legacyEntryGroupId_(id);
    if (!derived) continue;
    txSheet.getRange(i + 1, OMAD_GROUP_ID_COLUMN).setValue(derived);
    filled++;
  }

  if (filled > 0) appendAuditRow_(doc, "entry_group_ids_backfilled", String(filled));
  return { status: "success", filled: filled, alreadySet: alreadySet };
}

function safeRewriteOmadTransactions_(doc, incomingTransactions) {
  var sheetName = activeTransactionSheetName_(doc);
  var txSheet = doc.getSheetByName(sheetName) || doc.insertSheet(sheetName);
  ensureOmadTransactionHeader_(txSheet);

  var lastRow = txSheet.getLastRow();
  if (lastRow > 1) {
    txSheet.getRange(2, 1, lastRow - 1, OMAD_TRANSACTION_HEADER.length).clearContent();
  }

  var rows = [];
  for (var i = 0; i < incomingTransactions.length; i++) {
    rows.push(transactionToRow_(incomingTransactions[i]));
  }
  if (rows.length > 0) {
    applyTransactionColumnFormats_(txSheet, 2, rows.length, sheetName);
    txSheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
  bumpDataRevision_(CACHE_SCOPE_OMAD);
}

/**
 * Appends one transaction to whichever schema is live.
 *
 * The legacy row is thirteen columns and the ledger row is twenty-four, so
 * writing the legacy shape into the ledger does not merely misfile a value --
 * `ensureOmadTransactionHeader_` would first overwrite the ledger's header
 * with the legacy one, and the row would then land with Tenant in Request_ID
 * and Month in Created_At. One Telegram entry after a cutover was enough to
 * corrupt the sheet structurally.
 *
 * Callers that already branch on `isLedgerActive_` never reach the legacy path
 * below. This exists for the ones that do not: the /yangi conversation is the
 * live example, and any future caller inherits the same protection rather than
 * having to remember.
 */
function appendOmadTransaction_(doc, transaction) {
  if (isLedgerActive_(doc)) {
    var normalized = normalizeTransaction_(transaction);
    var snapshot = buildRateSnapshot_(
      transactionPeriod_(normalized), normalized.currency, transaction.rateType);
    var now = new Date().toISOString();

    appendLedgerRows_(ledgerSheet_(doc), [transactionToLedgerRow_({
      id: normalized.id,
      requestId: normalized.requestId,
      createdAt: now,
      updatedAt: "",
      createdBy: String(transaction.createdBy || "").slice(0, 120),
      source: TX_SOURCES[transaction.source] ? transaction.source : TX_SOURCE_TELEGRAM,
      period: transactionPeriod_(normalized),
      tenant: normalized.tenant,
      type: normalized.type,
      amount: normalized.amount,
      currency: normalized.currency,
      rateBuy: snapshot.rateBuy,
      rateSell: snapshot.rateSell,
      rateUsed: snapshot.rateUsed,
      rateType: snapshot.rateType,
      amountUZS: Math.round(normalized.currency === "USD"
        ? normalized.amount * snapshot.rateUsed : normalized.amount),
      method: normalized.method,
      comment: normalized.comment,
      status: TX_STATUS_ACTIVE,
      relatedId: "",
      msgId: normalized.msgId,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      groupId: normalized.groupId,
      entryKind: normalized.entryKind
    })]);
    return;
  }

  var sheetName = activeTransactionSheetName_(doc);
  var txSheet = doc.getSheetByName(sheetName) || doc.insertSheet(sheetName);
  ensureOmadTransactionHeader_(txSheet);

  // Written through a range rather than appendRow so the column formats are
  // in place before the values land - afterwards would be too late.
  var row = txSheet.getLastRow() + 1;
  applyTransactionColumnFormats_(txSheet, row, 1, sheetName);
  txSheet.getRange(row, 1, 1, OMAD_TRANSACTION_HEADER.length)
    .setValues([transactionToRow_(normalizeTransaction_(transaction))]);
  bumpDataRevision_(CACHE_SCOPE_OMAD);
}

/**
 * Writes the group message id back onto a transaction. The column differs
 * between the two schemas, so it is chosen from whichever sheet is live -
 * column 10 in the legacy layout, column 21 in the ledger.
 */
function updateOmadTransactionMsgId_(doc, transactionId, msgId) {
  if (!msgId) return;
  var sheetName = activeTransactionSheetName_(doc);
  var txSheet = doc.getSheetByName(sheetName);
  if (!txSheet || txSheet.getLastRow() < 2) return;

  var column = sheetName === OMAD_TRANSACTIONS_V2_SHEET ? 21 : 10;
  var data = txSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(transactionId)) {
      txSheet.getRange(i + 1, column).setValue(msgId);
      return;
    }
  }
}

function safeSaveOmad_(doc, configSheet, payload) {
  // Whole-list rewrites are exactly what the append-only ledger exists to
  // prevent. Once V2 is live, transactions change only through
  // create/correct/cancel.
  if (isLedgerActive_(doc)) {
    return saveOmadSettingsOnly_(doc, configSheet, payload);
  }

  var incomingTransactions = normalizeTransactions_(payload.transactions || []);
  var existingTransactions = readOmadTransactions_(doc);
  if (existingTransactions.length > 0 && incomingTransactions.length === 0 && payload.allowEmptyOmadTransactions !== true) {
    throw new Error("Refusing to overwrite Omad transactions with an empty payload without allowEmptyOmadTransactions=true");
  }
  archiveChangedOmadTransactions_(doc, existingTransactions, incomingTransactions);
  safeRewriteOmadTransactions_(doc, incomingTransactions);
  setConfig(configSheet, "Omad_Tenants", JSON.stringify(mergeTenantsByName_(
    normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), [])),
    normalizeTenantList_(payload.tenants || [])
  )));
  setConfig(configSheet, "Omad_Rates", JSON.stringify(payload.rates || {}));
  setConfig(configSheet, "Omad_Template_Expenses", JSON.stringify(normalizeTemplateExpenses_(payload.templateExpenses || [])));
}

/**
 * The non-transaction half of a save. Used once the ledger is live, where
 * tenants, rates and planned expenses are still whole-object settings but
 * transactions are not.
 */
function saveOmadSettingsOnly_(doc, configSheet, payload) {
  if (payload.tenants !== undefined) {
    setConfig(configSheet, "Omad_Tenants", JSON.stringify(mergeTenantsByName_(
      normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), [])),
      normalizeTenantList_(payload.tenants || [])
    )));
  }
  if (payload.rates !== undefined) {
    setConfig(configSheet, "Omad_Rates", JSON.stringify(payload.rates || {}));
  }
  if (payload.templateExpenses !== undefined) {
    setConfig(configSheet, "Omad_Template_Expenses",
      JSON.stringify(normalizeTemplateExpenses_(payload.templateExpenses || [])));
  }
}

// ----- apps-script/08a_tenant_paid.gs ------------------------------------------

// ============================================================
// Tenant-paid-on-our-behalf expenses
// ------------------------------------------------------------
// A tenant sometimes settles one of our bills directly — the electrician, say
// — and the amount comes off what they owe us.
//
// That is two accounting facts, and it always was: the tenant paid us
// (income), and the bill was paid (expense). Entering them as two separate
// transactions worked, but nothing recorded that they were the same event, so
// either half could be edited or deleted on its own, the group received two
// unrelated reports, and history showed two rows the reader had to pair up
// mentally.
//
// This is one operation that writes both rows, under one Entry_Group_ID, in a
// single spreadsheet write. Either both exist or neither does.
// ============================================================

/**
 * The expense source that makes the cash impact net to zero.
 *
 * No money passed through our safe or our account: the tenant paid the
 * supplier. Booking the expense against the same method the credit was
 * recorded under leaves cash and bank exactly where they were, which is the
 * whole point — the tenant's balance moves, our cash does not.
 */
function tenantPaidExpenseSource_(method) {
  return method === "Bank" ? "Umumiy Bankdan" : "Umumiy Naqd Puldan";
}

/** The tenant list as configured, through the same reader the app uses. */
function configuredTenants_(doc) {
  var configSheet = doc.getSheetByName("System_Config");
  if (!configSheet) return [];
  return normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), []));
}

/** The two source names that are expense buckets rather than tenants. */
function isExpenseSourceName_(name) {
  var text = String(name || "").trim();
  return text === "Umumiy Naqd Puldan" || text === "Umumiy Bankdan";
}

/**
 * The configured tenant of that name, or null.
 *
 * Matched on the trimmed name, which is the identity the whole app already
 * uses: the ledger stores the name, `Omad_Tenants` is keyed by it, and the
 * balance is computed by grouping rows on it. Anything that does not match one
 * of those names has no balance to credit, whatever it is.
 */
function findConfiguredTenant_(tenants, name) {
  var wanted = String(name || "").trim();
  var list = Array.isArray(tenants) ? tenants : [];
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].name || "").trim() === wanted) return list[i];
  }
  return null;
}

/**
 * Whether the tenant's agreement covers this period.
 *
 * Deliberately *not* `isTenantInScheduleForPeriod_`: that also refuses a
 * tenant whose record is marked inactive, which is right for "what should this
 * tenant be billed now" and wrong here. A tenant who moved out in March still
 * legitimately paid a February bill on our behalf, and recording it late — or
 * correcting it a year later — has to stay possible. The agreement window is
 * the honest boundary; the active flag is about today, not about history.
 *
 * A tenant with no window configured is covered for every period, which is how
 * every existing tenant record behaves.
 */
function tenantAgreementCoversPeriod_(tenant, period) {
  var t = tenant || {};
  if (!isCanonicalPeriod_(period)) return false;
  if (t.startPeriod && comparePeriods_(period, t.startPeriod) < 0) return false;
  if (t.endPeriod && comparePeriods_(period, t.endPeriod) > 0) return false;
  return true;
}

/**
 * @param {object} input     the request
 * @param {Array}  tenants   the configured tenant list, normalized
 */
function validateTenantPaidInput_(input, tenants) {
  var payload = input || {};

  if (!isCanonicalPeriod_(payload.period)) return "Davr noto'g'ri (masalan 2026-01).";

  var tenant = String(payload.tenant || "").trim();
  if (!tenant) return "Ijarachi tanlanmagan.";
  if (tenant.length > 200) return "Ijarachi nomi juda uzun.";
  // The income half has to land on a tenant's balance. An expense bucket has
  // no balance to credit, and choosing one would silently produce an entry
  // that cancels itself out and means nothing.
  if (isExpenseSourceName_(tenant)) return "Ijarachi tanlang — umumiy kassa bo'lmaydi.";

  // A non-empty string is not a tenant. Until now any text at all was accepted
  // and credited, which invents a balance nobody owes and quietly corrupts the
  // debt figure the whole app is for.
  var configured = findConfiguredTenant_(tenants, tenant);
  if (!configured) return "Bunday ijarachi ro'yxatda yo'q: " + tenant;

  // Backdating is legitimate; backdating outside the agreement is not.
  if (!tenantAgreementCoversPeriod_(configured, payload.period)) {
    return "Bu davr ijarachining shartnomasiga kirmaydi: " + tenant + " (" + payload.period + ").";
  }

  var amount = Number(payload.amount);
  if (!isFinite(amount) || amount <= 0) return "Summa musbat raqam bo'lishi kerak.";
  if (amount > 1e15) return "Summa juda katta.";

  if (payload.currency !== "UZS" && payload.currency !== "USD") return "Valyuta noto'g'ri.";
  if (payload.method !== "Naqd" && payload.method !== "Bank") return "To'lov usuli noto'g'ri.";

  // The purpose is what makes the expense half readable a year from now, so it
  // is required here even though an ordinary entry's comment is optional.
  var purpose = String(payload.comment || "").trim();
  if (!purpose) return "Chiqim maqsadini kiriting.";
  if (purpose.length > 2000) return "Izoh juda uzun.";

  var requestId = String(payload.requestId || "").trim();
  if (!requestId) return "requestId talab qilinadi.";
  if (requestId.length > 128) return "requestId juda uzun.";

  var groupId = String(payload.groupId || "").trim();
  if (groupId.length > 128) return "groupId juda uzun.";

  return "";
}

/** The comment stored on each half, so either row reads correctly alone. */
function tenantPaidComment_(half, tenant, purpose) {
  if (half === "income") return "Ijarachi bizning nomimizdan to'ladi: " + purpose;
  return purpose + " (to'lovchi: " + tenant + ")";
}

/**
 * Creates the linked income/expense pair for one tenant-paid expense.
 *
 * Idempotent on the group id: a double click, a retried request or a
 * redelivered Telegram update all resolve to the pair the first call created,
 * because the client mints the group id once and keeps it. Returns the pair
 * either way, so the caller cannot tell a retry from the original except by
 * the `duplicate` flag.
 */
function createTenantPaidExpense_(doc, input) {
  var validationError = validateTenantPaidInput_(input, configuredTenants_(doc));
  if (validationError) return { status: "error", message: validationError };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var replaceGroupId = String((input && input.replaceGroupId) || "").trim();
    if (replaceGroupId) return replaceTenantPaidExpense_(doc, input, replaceGroupId);

    var groupId = String(input.groupId || "").trim() || newEntryGroupId_();
    var ledgerLive = isLedgerActive_(doc);

    var existing = ledgerLive
      ? findLedgerRowsByGroupId_(doc, groupId).map(ledgerToLegacyShape_)
      : findTransactionsByGroupId_(doc, groupId);
    if (existing.length > 0) {
      return { status: "success", duplicate: true, groupId: groupId, transactions: existing };
    }

    var written = ledgerLive
      ? writeTenantPaidToLedger_(doc, input, groupId)
      : writeTenantPaidToLegacySheet_(doc, input, groupId);

    appendAuditRow_(doc, "tenant_paid_expense_created", JSON.stringify({
      groupId: groupId, tenant: String(input.tenant).trim(),
      amount: Number(input.amount), currency: input.currency, period: String(input.period)
    }));

    return { status: "success", duplicate: false, groupId: groupId, transactions: written };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Rewrites an existing pair, as a pair.
 *
 * Both halves go together or neither does — editing one side of a
 * tenant-paid expense is never a coherent thing to want, so the whole group is
 * replaced under the same group id. Keeping the id also keeps the group's
 * Telegram message, so the report is edited in place rather than a second one
 * appearing next to a stale first.
 *
 * Called with the script lock already held.
 */
function replaceTenantPaidExpense_(doc, input, groupId) {
  var ledgerLive = isLedgerActive_(doc);
  var existing = ledgerLive
    ? findLedgerRowsByGroupId_(doc, groupId)
    : findTransactionsByGroupId_(doc, groupId);

  if (existing.length === 0) return { status: "error", message: "O'zgartiriladigan yozuv topilmadi." };
  if (!isTenantPaidGroup_(existing)) {
    return { status: "error", message: "Bu yozuv ijarachi to'lovi emas." };
  }

  var msgId = "";
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].msgId) { msgId = String(existing[i].msgId); break; }
  }

  var replacement;
  if (ledgerLive) {
    // Append-only: the old rows are cancelled, never rewritten.
    for (var c = 0; c < existing.length; c++) {
      if (existing[c].status !== TX_STATUS_ACTIVE) continue;
      setLedgerStatus_(ledgerSheet_(doc), existing[c].rowNumber, TX_STATUS_CANCELLED, new Date().toISOString());
    }
    replacement = writeTenantPaidToLedger_(doc, input, groupId);
  } else {
    var keep = [];
    var all = readOmadTransactions_(doc);
    for (var k = 0; k < all.length; k++) {
      if (String(all[k].groupId || "") !== groupId) keep.push(all[k]);
    }
    replacement = buildLegacyTenantPaidRows_(input, groupId, msgId);
    archiveChangedOmadTransactions_(doc, all, keep.concat(replacement));
    safeRewriteOmadTransactions_(doc, normalizeTransactions_(keep.concat(replacement)));
    replacement = normalizeTransactions_(replacement);
  }

  appendAuditRow_(doc, "tenant_paid_expense_replaced", JSON.stringify({
    groupId: groupId, tenant: String(input.tenant).trim(),
    amount: Number(input.amount), currency: input.currency, period: String(input.period)
  }));

  return {
    status: "success", duplicate: false, replaced: true,
    groupId: groupId, messageId: msgId, transactions: replacement
  };
}

/** The two legacy rows of one pair, not yet written anywhere. */
function buildLegacyTenantPaidRows_(input, groupId, msgId) {
  var tenant = String(input.tenant).trim();
  var purpose = String(input.comment).trim();
  var requestId = String(input.requestId).trim();
  var baseId = String(new Date().getTime());

  var common = {
    month: String(input.period),
    amount: Number(input.amount),
    currency: input.currency,
    method: input.method,
    date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy"),
    msgId: msgId || "",
    groupId: groupId,
    entryKind: ENTRY_KIND_TENANT_PAID
  };

  return [
    Object.assign({}, common, {
      id: baseId + "_0",
      tenant: tenant,
      type: "Income",
      comment: tenantPaidComment_("income", tenant, purpose),
      requestId: requestId + "_0"
    }),
    Object.assign({}, common, {
      id: baseId + "_1",
      tenant: tenantPaidExpenseSource_(input.method),
      type: "Expense",
      comment: tenantPaidComment_("expense", tenant, purpose),
      requestId: requestId + "_1"
    })
  ];
}

/** The pair as two legacy rows, appended in one write. */
function writeTenantPaidToLegacySheet_(doc, input, groupId) {
  return appendOmadTransactionGroup_(doc, buildLegacyTenantPaidRows_(input, groupId, ""));
}

/** The same pair as two ledger rows, also appended in one write. */
function writeTenantPaidToLedger_(doc, input, groupId) {
  var tenant = String(input.tenant).trim();
  var purpose = String(input.comment).trim();
  var amount = Number(input.amount);
  var requestId = String(input.requestId).trim();
  var period = String(input.period);
  var now = new Date().toISOString();
  var snapshot = buildRateSnapshot_(period, input.currency, input.rateType);
  var baseId = String(new Date().getTime());

  var common = {
    createdAt: now,
    updatedAt: "",
    createdBy: String(input.createdBy || "").slice(0, 120),
    source: TX_SOURCES[input.source] ? input.source : TX_SOURCE_WEB,
    period: period,
    amount: amount,
    currency: input.currency,
    rateBuy: snapshot.rateBuy,
    rateSell: snapshot.rateSell,
    rateUsed: snapshot.rateUsed,
    rateType: snapshot.rateType,
    // Both halves freeze the same converted value, so the pair nets to exactly
    // zero however the rate moves afterwards.
    amountUZS: Math.round(input.currency === "USD" ? amount * snapshot.rateUsed : amount),
    method: input.method,
    status: TX_STATUS_ACTIVE,
    relatedId: "",
    msgId: "",
    schemaVersion: LEDGER_SCHEMA_VERSION,
    groupId: groupId,
    entryKind: ENTRY_KIND_TENANT_PAID
  };

  var pair = [
    Object.assign({}, common, {
      id: baseId + "_0",
      requestId: requestId + "_0",
      tenant: tenant,
      type: "Income",
      comment: tenantPaidComment_("income", tenant, purpose)
    }),
    Object.assign({}, common, {
      id: baseId + "_1",
      requestId: requestId + "_1",
      tenant: tenantPaidExpenseSource_(input.method),
      type: "Expense",
      comment: tenantPaidComment_("expense", tenant, purpose)
    })
  ];

  appendLedgerRows_(ledgerSheet_(doc), pair.map(transactionToLedgerRow_));
  return pair.map(ledgerToLegacyShape_);
}

// ------------------------------------------------------------------ reporting

/** True when a group is the linked pair rather than an ordinary entry. */
function isTenantPaidGroup_(group) {
  if (!group || group.length === 0) return false;
  for (var i = 0; i < group.length; i++) {
    if (normalizeEntryKind_(group[i].entryKind) !== ENTRY_KIND_TENANT_PAID) return false;
  }
  return true;
}

/**
 * One report for the pair, not two.
 *
 * Two separate reports were the actual complaint: the group saw an income and
 * an unrelated expense minutes apart and had to work out that they were the
 * same event. This says what happened once, and states the cash impact
 * explicitly, because "we recorded an expense and our cash did not move" is
 * the part that looks wrong until it is spelled out.
 */
function buildTenantPaidReportMessage_(group, balances) {
  var rates = getOmadRates_();
  var income = null;
  var expense = null;
  for (var i = 0; i < group.length; i++) {
    if (group[i].type === "Income") income = group[i];
    else expense = group[i];
  }
  var primary = income || group[0];

  var period = transactionPeriod_(primary);
  var periodText = formatPeriodLabel_(period) || "Noma'lum";
  var valueUZS = transactionUZS_(primary, rates);
  var amountText = Number(primary.amount || 0).toLocaleString() + " " + primary.currency;

  var lines = [
    "🔄 IJARACHI BIZNING NOMIMIZDAN TO'LADI",
    "",
    "🏢 Ijarachi: " + (String(primary.tenant || "").trim() || "Noma'lum"),
    "📅 Davr: " + periodText,
    "💵 Summa: " + amountText,
    "💳 Usul: " + String(primary.method || ""),
    "📝 Maqsad: " + (String((expense && expense.comment) || primary.comment || "").trim() || "Kiritilmagan"),
    "",
    "🟢 Ijarachiga hisoblandi: +" + formatUZS_(valueUZS) + " UZS",
    "🔴 Chiqim yozildi: −" + formatUZS_(valueUZS) + " UZS",
    "⚖️ Kassaga ta'siri: 0 UZS",
    "",
    "📊 HISOBOT:",
    "🔹 " + periodText + " qoldig'i: " + formatUZS_(balances.monthBalance) + " UZS",
    "🏦 Umumiy balans: " + formatUZS_(balances.allTimeBalance) + " UZS"
  ];

  return lines.join("\n").slice(0, TELEGRAM_MAX_TEXT_LENGTH);
}

// ----- apps-script/09_telegram_service.gs --------------------------------------

// ============================================================
// Telegram service
// ------------------------------------------------------------
// Everything that talks to api.telegram.org, plus the /yangi conversation.
// There is no generic "send this text" entry point.
// ============================================================

/**
 * A chat id reduced to something recognisable but not reusable: the sign and
 * the last four digits. Enough to tell the group from a private chat in a log.
 */
function maskChatId_(chatId) {
  var text = String(chatId === null || chatId === undefined ? "" : chatId);
  if (!text) return "";
  var negative = text.charAt(0) === "-";
  var digits = text.replace(/[^0-9]/g, "");
  if (digits.length <= 4) return (negative ? "-" : "") + digits;
  return (negative ? "-" : "") + "..." + digits.slice(-4);
}

/** The `description` Telegram returns on failure, redacted, or "". */
function telegramErrorDescription_(responseText) {
  var parsed = safeParseJSON_(responseText, null);
  if (!parsed || parsed.ok) return "";
  return redactSecrets_(String(parsed.description || "")).slice(0, 300);
}

/**
 * True when Telegram is telling us the thing we asked to change is already in
 * the state we wanted. Deleting a message that is already gone is the desired
 * outcome, not a failure to retry.
 */
function isAlreadyDoneTelegramError_(responseText) {
  var parsed = safeParseJSON_(responseText, null);
  if (!parsed || parsed.ok) return false;
  var description = String(parsed.description || "").toLowerCase();
  return description.indexOf("message to delete not found") >= 0 ||
         description.indexOf("message can't be deleted") >= 0 ||
         description.indexOf("message identifier is not specified") >= 0 ||
         description.indexOf("message to edit not found") >= 0;
}

function telegramFetch_(method, body) {
  var token = getBotToken_();
  if (!token) throw new Error("Telegram bot token is not configured. Set it in Sozlamalar → Telegram.");

  var response;
  try {
    response = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
  } catch (transportError) {
    recordTelegramError_(method, transportError);
    throw new Error("Telegram API " + method + " unreachable: " + redactSecrets_(transportError));
  }

  var responseText = response.getContentText();
  var responseCode = response.getResponseCode();

  // Only facts that cannot carry a credential. The request body is never
  // logged: setWebhook carries the verification secret in both the URL and
  // secret_token, and that is exactly how it reached the debug sheet before.
  debugLog_(SpreadsheetApp.getActiveSpreadsheet(), "telegram_api_" + method, JSON.stringify({
    code: responseCode,
    chat: maskChatId_(body && body.chat_id),
    messageId: (body && body.message_id) || "",
    ok: responseCode >= 200 && responseCode < 300,
    description: telegramErrorDescription_(responseText)
  }));

  if (responseCode < 200 || responseCode >= 300) {
    var failure = "Telegram API " + method + " failed (HTTP " + responseCode + "): " + responseText;
    recordTelegramError_(method, failure);
    throw new Error(redactSecrets_(failure));
  }

  recordTelegramSuccess_(method);
  return response;
}

function sendTelegramMessage_(chatId, text, replyMarkup, parseMode, options) {
  var body = { chat_id: chatId, text: text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (parseMode) body.parse_mode = parseMode;
  if (options && options.replyToMessageId) {
    body.reply_to_message_id = Number(options.replyToMessageId) || options.replyToMessageId;
    // The card can have been deleted; a prompt that cannot attach itself is
    // still better than no prompt at all.
    body.allow_sending_without_reply = true;
  }
  return telegramFetch_("sendMessage", body);
}

function editTelegramMessage_(chatId, messageId, text, replyMarkup, parseMode) {
  var body = { chat_id: chatId, message_id: messageId, text: text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (parseMode) body.parse_mode = parseMode;
  return telegramFetch_("editMessageText", body);
}

/**
 * Deletes a group message, treating "it is already gone" as success.
 *
 * Telegram answers HTTP 400 both for a message that never existed and for one
 * already deleted, and neither can be fixed by trying again. Any other failure
 * still throws, so a genuine outage is retried.
 */
function deleteTelegramMessageIfPresent_(chatId, messageId) {
  var token = getBotToken_();
  if (!token) throw new Error("Telegram bot token is not configured. Set it in Sozlamalar → Telegram.");

  var response;
  try {
    response = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/deleteMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      muteHttpExceptions: true
    });
  } catch (transportError) {
    recordTelegramError_("deleteMessage", transportError);
    throw new Error("Telegram API deleteMessage unreachable: " + redactSecrets_(transportError));
  }

  var responseText = response.getContentText();
  var responseCode = response.getResponseCode();

  debugLog_(SpreadsheetApp.getActiveSpreadsheet(), "telegram_api_deleteMessage", JSON.stringify({
    code: responseCode,
    chat: maskChatId_(chatId),
    messageId: String(messageId),
    ok: responseCode >= 200 && responseCode < 300,
    description: telegramErrorDescription_(responseText)
  }));

  if (responseCode >= 200 && responseCode < 300) {
    recordTelegramSuccess_("deleteMessage");
    return { status: "deleted" };
  }

  if (isAlreadyDoneTelegramError_(responseText)) {
    // The end state is what was asked for, so the job is complete.
    recordTelegramSuccess_("deleteMessage");
    return { status: "already_gone" };
  }

  var failure = "Telegram API deleteMessage failed (HTTP " + responseCode + "): " + responseText;
  recordTelegramError_("deleteMessage", failure);
  throw new Error(redactSecrets_(failure));
}

function answerCallbackQuery_(callbackQueryId, text) {
  var body = { callback_query_id: callbackQueryId };
  if (text) body.text = text;
  telegramFetch_("answerCallbackQuery", body);
}

function extractTelegramMessageId_(response) {
  try {
    var data = JSON.parse(response.getContentText() || "{}");
    return data && data.ok && data.result ? data.result.message_id : "";
  } catch (error) {
    return "";
  }
}

function isVerifiedTelegramWebhookRequest_(e) {
  var expected = getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET);
  // No secret configured yet: accept, so an existing deployment keeps working
  // until the operator re-runs "Webhook" in Sozlamalar. buildTelegramSettingsView_
  // surfaces this as an unverified webhook.
  if (!expected) return true;

  var provided = e && e.parameter ? e.parameter[TELEGRAM_WEBHOOK_SECRET_PARAM] : "";
  // During a rotation the outgoing secret is still accepted, because Telegram
  // may not have been told the new one yet. It is cleared as soon as the new
  // webhook is confirmed, so this window is the length of one API round trip.
  var previous = getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET_PREVIOUS);
  if (secretsMatch_(provided, expected) || (previous && secretsMatch_(provided, previous))) {
    return !enforceRateLimit_("tg_webhook", TELEGRAM_WEBHOOK_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  }
  return false;
}

var TELEGRAM_UNAUTHORIZED_MESSAGE = "⛔️ Sizda bu botdan foydalanish huquqi yo'q.";

/**
 * Single source of truth for /yangi authorization.
 * Uses Telegram's permanent numeric from.id - never the username, which can
 * be changed or impersonated. Returns true only for the configured admin.
 */
function isAuthorizedTelegramUser_(fromId) {
  var configured = getAuthorizedTelegramUserId_();
  if (!configured) return false;
  var actual = String(fromId === null || fromId === undefined ? "" : fromId).trim();
  if (!actual) return false;
  return actual === String(configured).trim();
}

function extractTelegramFromId_(update) {
  if (!update) return "";
  if (update.callback_query && update.callback_query.from) return update.callback_query.from.id;
  if (update.message && update.message.from) return update.message.from.id;
  return "";
}

function handleOmadTelegramUpdate_(update, doc, configSheet) {
  var callback = update.callback_query;
  var message = update.message;
  var chatId = callback ? callback.message.chat.id : message.chat.id;
  var chatType = callback ? callback.message.chat.type : message.chat.type;
  var fromId = extractTelegramFromId_(update);
  var cache = CacheService.getScriptCache();
  // Session key is bound to the authorized user, not just the chat.
  var key = "yangi_" + fromId;
  debugLog_(doc, "telegram_update_received", JSON.stringify({ chatId: chatId, fromId: fromId, chatType: chatType, text: message && message.text, callback: callback && callback.data }));

  // The reporting group receives reports only - never accepts transaction entry.
  if (chatType !== "private") {
    debugLog_(doc, "telegram_non_private_ignored", JSON.stringify({ chatId: chatId, chatType: chatType, text: message && message.text, callback: callback && callback.data }));
    return okHtmlOutput_();
  }

  // Gate #1: every private update, before any session/cache/record is touched.
  if (!isAuthorizedTelegramUser_(fromId)) {
    debugLog_(doc, "telegram_unauthorized_blocked", JSON.stringify({ chatId: chatId, fromId: fromId, callback: callback && callback.data }));
    if (callback) answerCallbackQuery_(callback.id, TELEGRAM_UNAUTHORIZED_MESSAGE);
    sendTelegramMessage_(chatId, TELEGRAM_UNAUTHORIZED_MESSAGE);
    return okHtmlOutput_();
  }

  if (callback) {
    answerCallbackQuery_(callback.id);
    processOmadCallback_(callback, chatId, key, cache, doc, configSheet, fromId);
    return okHtmlOutput_();
  }

  var text = String((message && message.text) || "").trim();
  if (text === "/yangi" || text.indexOf("/yangi ") === 0) {
    cache.remove(key);
    debugLog_(doc, "telegram_yangi_triggered", JSON.stringify({ chatId: chatId, fromId: fromId }));
    sendTelegramMessage_(chatId, "Iltimos, operatsiya turini tanlang:", {
      inline_keyboard: [
        [
          { text: "🟢 Kirim", callback_data: "bot_type:Income" },
          { text: "🔴 Chiqim", callback_data: "bot_type:Expense" }
        ],
        // The task wizard. `bot_vz` and not `t_`: a t_-prefixed callback is
        // claimed by isTaskTelegramUpdate_, which applies neither the
        // private-chat check nor the authorization gate.
        [
          { text: "📋 Vazifa", callback_data: "bot_vz_type" }
        ]
      ]
    });
    return okHtmlOutput_();
  }

  processOmadTextStep_(text, chatId, key, cache, doc, configSheet, fromId);
  return okHtmlOutput_();
}

function processOmadCallback_(callback, chatId, key, cache, doc, configSheet, fromId) {
  // Gate #2: re-checked on every inline button callback (type, tenant,
  // expense source and currency selection all arrive through here).
  if (!isAuthorizedTelegramUser_(fromId)) {
    sendTelegramMessage_(chatId, TELEGRAM_UNAUTHORIZED_MESSAGE);
    return;
  }

  var data = String(callback.data || "");

  // The task wizard, handled before the accounting session is even read. It
  // deliberately does not receive configSheet: "the wizard never reads
  // financial config" is then enforced by this signature rather than by
  // discipline.
  if (data.indexOf("bot_vz") === 0) {
    handleTaskWizardCallback_(callback, chatId, key, cache, data, doc, fromId);
    return;
  }

  var state = safeParseJSON_(cache.get(key), {});

  if (data.indexOf("bot_type:") === 0) {
    // A fresh session id per entry. It becomes the transaction's request id, so
    // the whole conversation maps to exactly one financial record.
    state = {
      type: data.replace("bot_type:", "") === "Expense" ? "Expense" : "Income",
      sessionId: Utilities.getUuid().split("-").join("")
    };
    cache.put(key, JSON.stringify(state), 21600);
    var tenantNames = getActiveTenantNames_(configSheet);
    var keyboard = [];
    for (var i = 0; i < tenantNames.length; i++) keyboard.push([{ text: tenantNames[i], callback_data: "bot_ten:" + i }]);
    if (state.type === "Expense") {
      keyboard.push([{ text: "🗄️ Umumiy Naqd Puldan", callback_data: "bot_spec:Umumiy Naqd Puldan" }]);
      keyboard.push([{ text: "💳 Umumiy Bankdan", callback_data: "bot_spec:Umumiy Bankdan" }]);
    }
    editTelegramMessage_(chatId, callback.message.message_id, state.type === "Income" ? "Ijarachini tanlang:" : "Chiqim manbasini tanlang:", { inline_keyboard: keyboard });
    return;
  }

  if (data.indexOf("bot_ten:") === 0 || data.indexOf("bot_spec:") === 0) {
    if (!state.type) state.type = "Income";
    if (data.indexOf("bot_ten:") === 0) {
      var index = Number(data.replace("bot_ten:", ""));
      state.tenant = getActiveTenantNames_(configSheet)[index] || "";
    } else {
      state.tenant = data.replace("bot_spec:", "");
    }
    state.method = state.tenant === "Umumiy Bankdan" ? "Bank" : "Naqd";
    cache.put(key, JSON.stringify(state), 21600);
    editTelegramMessage_(chatId, callback.message.message_id, "Valyutani tanlang:", {
      inline_keyboard: [[
        { text: "🇺🇿 UZS", callback_data: "bot_curr:UZS" },
        { text: "🇺🇸 USD", callback_data: "bot_curr:USD" }
      ]]
    });
    return;
  }

  if (data.indexOf("bot_curr:") === 0) {
    state.currency = data.replace("bot_curr:", "") === "USD" ? "USD" : "UZS";
    state.step = "await_amount";
    cache.put(key, JSON.stringify(state), 21600);
    editTelegramMessage_(chatId, callback.message.message_id, "Valyuta tanlandi: " + state.currency, { inline_keyboard: [] });
    sendTelegramMessage_(chatId, "Iltimos, tranzaksiya summasini kiriting (faqat raqam):");
  }
}

function processOmadTextStep_(text, chatId, key, cache, doc, configSheet, fromId) {
  // Gate #3: re-checked on the amount and description steps, immediately
  // before the transaction is written to the sheet.
  if (!isAuthorizedTelegramUser_(fromId)) {
    sendTelegramMessage_(chatId, TELEGRAM_UNAUTHORIZED_MESSAGE);
    return;
  }

  var state = safeParseJSON_(cache.get(key), null);
  if (!state || !state.step) return;

  // The task wizard shares this session key, discriminated by `flow`. Every
  // wizard step id is vz_*, so it can never fall through into await_amount or
  // await_desc and write a financial row.
  if (state.flow === WIZARD_FLOW) {
    handleTaskWizardText_(text, chatId, key, cache, state, doc, fromId);
    return;
  }

  if (state.step === "await_amount") {
    var amount = Number(text.replace(/\s/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      sendTelegramMessage_(chatId, "Summa noto'g'ri. Iltimos, faqat musbat raqam kiriting:");
      return;
    }
    state.amount = amount;
    state.step = "await_desc";
    cache.put(key, JSON.stringify(state), 21600);
    sendTelegramMessage_(chatId, "Tranzaksiya izohini (kommentariya) kiriting:");
    return;
  }

  if (state.step === "await_desc") {
    // Gate #4: final check immediately before the financial record is saved.
    if (!isAuthorizedTelegramUser_(fromId)) {
      cache.remove(key);
      sendTelegramMessage_(chatId, TELEGRAM_UNAUTHORIZED_MESSAGE);
      return;
    }

    // The request id is derived from the session, so replaying the same update
    // - or a retried webhook delivery - resolves to the same transaction.
    // A session started before this field existed simply gets no dedup key,
    // which is safer than risking a collision with a different session.
    var requestId = state.sessionId ? ("tg_" + fromId + "_" + state.sessionId) : "";
    var transaction;

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var existing = findTransactionByRequestId_(doc, requestId);
      if (existing) {
        transaction = normalizeTransaction_(existing);
      } else {
        backupOmadState_(doc, configSheet, "telegram_yangi");
        transaction = normalizeTransaction_({
          id: Date.now() + "_0",
          tenant: state.tenant,
          month: currentPeriod_(),
          type: state.type,
          amount: state.amount,
          currency: state.currency,
          method: state.method,
          date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy"),
          comment: text,
          msgId: "",
          requestId: requestId,
          // One /yangi conversation is one business action, so it gets one
          // group id of its own rather than inheriting the id's prefix.
          groupId: newEntryGroupId_()
        });
        appendOmadTransaction_(doc, transaction);
      }
    } finally {
      lock.releaseLock();
    }

    // The financial record is safely stored. Finalise the session next, so a
    // failure anywhere below can never leave a session that accepts a second
    // submission of the same transaction.
    cache.remove(key);

    // Reporting is a separate retryable job. It cannot fail the transaction and
    // it cannot create a second copy of it.
    var reportJobId = "";
    try {
      reportJobId = enqueueJob_(doc, "omad_transaction_report", transaction.id, {
        groupId: String(transaction.groupId || ""),
        baseId: String(transaction.id).split("_")[0],
        messageId: ""
      });
    } catch (queueError) {
      debugLog_(doc, "telegram_report_enqueue_failed", String(queueError));
    }

    // Confirm to the user first - the save is what matters to them.
    sendTelegramMessage_(chatId, buildTelegramConfirmation_(transaction), null, "Markdown");

    if (reportJobId) drainJobQueueQuietly_(doc, null);
  }
}

function buildTelegramConfirmation_(transaction) {
  return [
    "✅ *Tranzaksiya saqlandi*",
    "_Guruhga hisobot alohida yuboriladi._",
    "",
    "*Turi:* " + (transaction.type === "Income" ? "Kirim" : "Chiqim"),
    "*Obyekt:* " + escapeMarkdown_(transaction.tenant),
    "*Davr:* " + escapeMarkdown_(formatPeriodLabel_(transactionPeriod_(transaction))),
    "*Summa:* " + Number(transaction.amount || 0).toLocaleString() + " " + transaction.currency,
    "*Usul:* " + escapeMarkdown_(transaction.method),
    "*Izoh:* " + escapeMarkdown_(transaction.comment || "Kiritilmagan")
  ].join("\n");
}

/**
 * Report for a whole entry group (the web UI can save several amounts under a
 * single comment). Identical wording to the single-transaction message so the
 * group sees one consistent format.
 */
function buildOmadGroupReportMessage_(group, balances) {
  var rates = getOmadRates_();
  var first = group[0];
  var title = first.type === "Income" ? "🟢 YANGI KIRIM" : "🔴 YANGI CHIQIM";
  var objectText = String(first.tenant || "").trim() || "Noma'lum";
  var period = transactionPeriod_(first);
  var periodText = formatPeriodLabel_(period) || "Noma'lum";

  var transferLines = [];
  var total = 0;
  for (var i = 0; i < group.length; i++) {
    // The value stored on the transaction, not today's rate.
    var valueUZS = transactionUZS_(group[i], rates);
    total += valueUZS;
    transferLines.push("💵 " + formatUZS_(valueUZS) + " UZS");
  }

  return (title +
    "\n\n🏢 Obyekt: " + objectText +
    "\n📅 Davr: " + periodText +
    "\n\n💸 O'tkazma:\n" + transferLines.join("\n") +
    "\nJami: " + formatUZS_(total) + " UZS" +
    "\n\n📝 Izoh: " + (String(first.comment || "").trim() || "Kiritilmagan") +
    "\n\n📊 HISOBOT:" +
    "\n🔹 " + periodText + " qoldig'i: " + formatUZS_(balances.monthBalance) + " UZS" +
    "\n🏦 Umumiy balans: " + formatUZS_(balances.allTimeBalance) + " UZS"
  ).slice(0, TELEGRAM_MAX_TEXT_LENGTH);
}

function buildCafeCloseDayMessage_(payload) {
  var items = Array.isArray(payload.soldItems) && payload.soldItems.length
    ? payload.soldItems
    : (Array.isArray(payload.summary) ? payload.summary : []);

  var lines = [];
  for (var i = 0; i < items.length; i++) {
    var qty = Number(items[i].qty !== undefined ? items[i].qty : items[i].sold) || 0;
    if (qty <= 0) continue;
    lines.push("• " + escapeTelegramHtml_(items[i].name) + ": <b>" + qty.toLocaleString() + "</b>");
  }
  if (lines.length === 0) lines.push("• Sotilgan mahsulotlar topilmadi");

  var stamp = formatCloseDayStamp_(payload.date);
  return [
    "🧾 <b>Kafe Kunlik Yakun Hisoboti</b>",
    "",
    "📅 <b>Sana:</b> " + escapeTelegramHtml_(stamp),
    "👤 <b>Sotuvchi:</b> " + escapeTelegramHtml_(payload.seller),
    "💵 <b>Jami tushum:</b> " + Math.round(Number(payload.totalRevenue) || 0).toLocaleString() + " UZS",
    "📈 <b>Jami foyda:</b> " + Math.round(Number(payload.totalProfit) || 0).toLocaleString() + " UZS",
    "",
    "📦 <b>Yopilgan mahsulotlar (sotilgan miqdor):</b>",
    lines.join("\n")
  ].join("\n").slice(0, TELEGRAM_MAX_TEXT_LENGTH);
}

// ----- apps-script/10_retry_queue.gs -------------------------------------------

// ============================================================
// Retry queue
// ------------------------------------------------------------
// Reporting is never on the critical path of a financial write. Jobs are queued
// after the record is committed and retried with backoff.
// ============================================================

// 5d. RETRY QUEUE (Google Sheets backed)
// ------------------------------------------
// Telegram reporting is never on the critical path of a financial write. Jobs
// are queued after the record is committed and retried with backoff.
// ==========================================
var JOB_QUEUE_SHEET = "Omad_Job_Queue";

var JOB_QUEUE_HEADER = [
  "Job_ID", "Related_ID", "Type", "Payload_JSON", "Status",
  "Attempts", "Next_Attempt_At", "Last_Error", "Created_At", "Completed_At"
];

var JOB_STATUS_PENDING = "Pending";

var JOB_STATUS_PROCESSING = "Processing";

var JOB_STATUS_COMPLETED = "Completed";

var JOB_STATUS_FAILED = "Failed";

var JOB_MAX_ATTEMPTS = 5;

var JOB_RETRY_BASE_SECONDS = 30;

// Deliberately one. A save returns as soon as the financial record is safely
// stored; at most one queued report rides along, and the time-driven trigger
// picks up everything else. Draining the whole queue inline would make the
// user wait for work they do not care about.
var JOB_QUEUE_INLINE_BATCH = 1;

var JOB_QUEUE_MANUAL_BATCH = 25;

var JOB_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

function jobQueueSheet_(doc) {
  var sheet = doc.getSheetByName(JOB_QUEUE_SHEET) || doc.insertSheet(JOB_QUEUE_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(JOB_QUEUE_HEADER);
  return sheet;
}

/**
 * True when an identical piece of work is already waiting.
 *
 * Asking twice for the same group message to be deleted is one instruction,
 * not two: the second job could only ever find the message already gone.
 */
function hasPendingJob_(doc, type, relatedId, payload) {
  var read = readJobRows_(doc);
  var wanted = JSON.stringify(payload || {});
  for (var i = 0; i < read.rows.length; i++) {
    var job = read.rows[i];
    if (job.status !== JOB_STATUS_PENDING && job.status !== JOB_STATUS_PROCESSING) continue;
    if (job.type !== String(type)) continue;
    if (job.relatedId !== String(relatedId || "")) continue;
    if (JSON.stringify(job.payload || {}) === wanted) return job.jobId;
  }
  return "";
}

function enqueueJob_(doc, type, relatedId, payload) {
  // Deduplicated before it is written, so a repeated instruction cannot leave
  // a second job behind to fail on its own.
  var duplicate = hasPendingJob_(doc, type, relatedId, payload);
  if (duplicate) return duplicate;

  var sheet = jobQueueSheet_(doc);
  var jobId = "job_" + new Date().getTime() + "_" + sheet.getLastRow();
  sheet.appendRow([
    jobId,
    String(relatedId || ""),
    String(type),
    JSON.stringify(payload || {}),
    JOB_STATUS_PENDING,
    0,
    new Date().toISOString(),
    "",
    new Date().toISOString(),
    ""
  ]);
  return jobId;
}

function readJobRows_(doc) {
  var sheet = doc.getSheetByName(JOB_QUEUE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { sheet: sheet, rows: [] };
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    rows.push({
      rowNumber: i + 1,
      jobId: String(data[i][0]),
      relatedId: String(data[i][1] || ""),
      type: String(data[i][2] || ""),
      payload: safeParseJSON_(data[i][3], {}),
      status: String(data[i][4] || ""),
      attempts: Number(data[i][5]) || 0,
      nextAttemptAt: String(data[i][6] || ""),
      lastError: String(data[i][7] || ""),
      createdAt: String(data[i][8] || ""),
      completedAt: String(data[i][9] || "")
    });
  }
  return { sheet: sheet, rows: rows };
}

function writeJobField_(sheet, rowNumber, columnIndex, value) {
  sheet.getRange(rowNumber, columnIndex).setValue(value);
}

/**
 * Claims a job by flipping it to Processing under the script lock, so two
 * concurrent workers can never run the same job twice.
 */
function claimDueJobs_(doc, maxJobs) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (error) {
    return [];
  }

  var claimed = [];
  try {
    var read = readJobRows_(doc);
    if (!read.sheet) return [];
    var nowMs = new Date().getTime();

    for (var i = 0; i < read.rows.length && claimed.length < maxJobs; i++) {
      var job = read.rows[i];

      // Recover jobs abandoned by a worker that died mid-flight.
      if (job.status === JOB_STATUS_PROCESSING) {
        var startedMs = Date.parse(job.nextAttemptAt) || 0;
        if (nowMs - startedMs < JOB_PROCESSING_TIMEOUT_MS) continue;
      } else if (job.status !== JOB_STATUS_PENDING) {
        continue;
      } else if ((Date.parse(job.nextAttemptAt) || 0) > nowMs) {
        continue;
      }

      writeJobField_(read.sheet, job.rowNumber, 5, JOB_STATUS_PROCESSING);
      writeJobField_(read.sheet, job.rowNumber, 7, new Date(nowMs).toISOString());
      job.status = JOB_STATUS_PROCESSING;
      job.sheet = read.sheet;
      claimed.push(job);
    }
  } finally {
    lock.releaseLock();
  }
  return claimed;
}

function completeJob_(sheet, job) {
  writeJobField_(sheet, job.rowNumber, 5, JOB_STATUS_COMPLETED);
  writeJobField_(sheet, job.rowNumber, 6, job.attempts + 1);
  writeJobField_(sheet, job.rowNumber, 8, "");
  writeJobField_(sheet, job.rowNumber, 10, new Date().toISOString());
}

function failJob_(sheet, job, error, doc) {
  var attempts = job.attempts + 1;
  var exhausted = attempts >= JOB_MAX_ATTEMPTS;
  var delaySeconds = JOB_RETRY_BASE_SECONDS * Math.pow(2, Math.max(0, attempts - 1));
  writeJobField_(sheet, job.rowNumber, 5, exhausted ? JOB_STATUS_FAILED : JOB_STATUS_PENDING);
  writeJobField_(sheet, job.rowNumber, 6, attempts);
  writeJobField_(sheet, job.rowNumber, 7, new Date(new Date().getTime() + delaySeconds * 1000).toISOString());
  writeJobField_(sheet, job.rowNumber, 8, redactSecrets_(error).slice(0, 500));
  if (exhausted) {
    writeJobField_(sheet, job.rowNumber, 10, new Date().toISOString());
    // Some jobs leave state behind that only makes sense while they are still
    // going to be retried.
    if (doc) {
      try { onJobPermanentlyFailed_(doc, job); } catch (hookError) {}
    }
  }
}

/** Last-chance cleanup when a job will never be attempted again. */
function onJobPermanentlyFailed_(doc, job) {
  if (job.type === "task_proof_prompt") releaseStuckProofPrompt_(doc, job);
}

function processPendingJobs_(doc, maxJobs) {
  var jobs = claimDueJobs_(doc, maxJobs || JOB_QUEUE_INLINE_BATCH);
  var processed = 0;
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    try {
      runJob_(doc, job);
      completeJob_(job.sheet, job);
      processed++;
    } catch (error) {
      failJob_(job.sheet, job, error, doc);
    }
  }
  return processed;
}

/**
 * Best-effort inline drain. Never throws into the caller's response path, and
 * never processes more than one job, so confirming a save stays fast.
 *
 * Pass `deferReports: true` on a request to skip it entirely and leave
 * everything to the trigger.
 */
function drainJobQueueQuietly_(doc, options) {
  if (options && options.deferReports === true) return 0;
  try {
    return processPendingJobs_(doc, JOB_QUEUE_INLINE_BATCH);
  } catch (error) {
    return 0;
  }
}

/**
 * The one time-driven trigger this project needs (see docs/TELEGRAM_SETUP.md).
 *
 * A tick is the whole cycle: scan the task schedules, enqueue whatever has come
 * due, then drain the queue. Scanning first means a reminder due right now goes
 * out in this tick rather than waiting five minutes for the next one, and it
 * removes the need to maintain a second `processTaskSchedules` trigger
 * alongside this one.
 *
 * The scan is wrapped because this queue also carries the accounting reports: a
 * fault on the task side must never stop a financial report from being sent.
 * Running it here as well as from `processTaskSchedules` is safe — the pass
 * takes the script lock and marks each reminder slot at enqueue time, so no
 * combination of entry points can produce a duplicate.
 */
function processPendingTelegramJobs() {
  resetRequestMemos_();
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  try {
    runTaskScheduler_(doc, Date.now());
  } catch (error) {
    debugLog_(doc, "task_scheduler_trigger_failed", String(error));
  }
  return processPendingJobs_(doc, JOB_QUEUE_MANUAL_BATCH);
}

function buildJobQueueStatus_(doc) {
  var read = readJobRows_(doc);
  var counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  var recentFailures = [];
  for (var i = 0; i < read.rows.length; i++) {
    var job = read.rows[i];
    if (job.status === JOB_STATUS_PENDING) counts.pending++;
    else if (job.status === JOB_STATUS_PROCESSING) counts.processing++;
    else if (job.status === JOB_STATUS_COMPLETED) counts.completed++;
    else if (job.status === JOB_STATUS_FAILED) {
      counts.failed++;
      recentFailures.push({ jobId: job.jobId, type: job.type, attempts: job.attempts, lastError: job.lastError });
    }
  }
  return { counts: counts, failures: recentFailures.slice(-10) };
}

function runJob_(doc, job) {
  if (job.type === "omad_transaction_report") return runOmadTransactionReportJob_(doc, job);
  if (job.type === "omad_transaction_delete_report") return runOmadDeleteReportJob_(job);
  if (job.type === "cafe_close_day_report") return runCafeCloseDayReportJob_(job);
  if (isTaskJobType_(job.type)) return runTaskJob_(doc, job);
  throw new Error("Unknown job type: " + job.type);
}

// ----- apps-script/11_report_jobs.gs -------------------------------------------

// ============================================================
// Business report jobs
// ------------------------------------------------------------
// The browser submits a business operation. The message text is composed here,
// on the server, from data the server already stored.
// ============================================================

function queueOmadTransactionReport_(doc, report) {
  if (!report || typeof report !== "object") return "";
  var operation = String(report.operation || "");
  if (operation === "transaction_delete") {
    if (!report.messageId) return "";
    return enqueueJob_(doc, "omad_transaction_delete_report", String(report.baseId || ""), {
      messageId: String(report.messageId)
    });
  }
  if (operation === "transaction_upsert") {
    var groupId = String(report.groupId || "");
    var baseId = String(report.baseId || "");
    if (!groupId && !baseId) return "";
    return enqueueJob_(doc, "omad_transaction_report", groupId || baseId, {
      // The group id is what the report resolves against. baseId rides along so
      // a job queued by an older client — or one already on the queue across a
      // deploy — still finds its rows.
      groupId: groupId,
      baseId: baseId,
      messageId: report.messageId ? String(report.messageId) : ""
    });
  }
  return "";
}

function runOmadTransactionReportJob_(doc, job) {
  var chatId = getOmadGroupChatId_();
  if (!chatId) throw new Error("Telegram guruh ID o'rnatilmagan.");

  // One pass over the ledger for both the group and the balances.
  var all = readOmadTransactions_(doc);
  var group = resolveReportGroupFrom_(all, job.payload);
  if (group.length === 0) {
    // The group was deleted before the report went out. Nothing to report.
    return;
  }

  // The resolved period, not the raw Month cell: balances are compared against
  // resolved periods, so passing "Avgust" (or a date cell) matched nothing and
  // every report quoted a month balance of 0.
  var balances = calculateBalancesFromTransactions_(all, transactionPeriod_(group[0]));
  // The linked pair is one business action and gets one message that says so.
  // The kind is read off the stored rows rather than the job payload, so a
  // report re-sent after an edit always describes what the data now is.
  var text = isTenantPaidGroup_(group)
    ? buildTenantPaidReportMessage_(group, balances)
    : buildOmadGroupReportMessage_(group, balances);
  var existingMessageId = String(job.payload.messageId || group[0].msgId || "");

  if (existingMessageId) {
    editTelegramMessage_(chatId, existingMessageId, text);
    applyMsgIdToGroup_(doc, group, existingMessageId);
    return;
  }

  var response = sendTelegramMessage_(chatId, text);
  var newMessageId = extractTelegramMessageId_(response);
  if (newMessageId) applyMsgIdToGroup_(doc, group, newMessageId);
}

/**
 * The rows a report job covers.
 *
 * Stored group id first, because that is the grouping the data actually
 * asserts. The id-prefix fallback is only for jobs enqueued before the column
 * existed, which can still be sitting on the queue when this deploys.
 */
/**
 * The rows a report is about, picked out of a list already in memory.
 *
 * This used to fetch them itself, and the caller then read the whole ledger
 * again to compute the balances -- two full passes over every transaction ever
 * recorded, for every report, and a report is queued for every entry.
 */
function resolveReportGroupFrom_(all, payload) {
  var groupId = String((payload && payload.groupId) || "");
  var group = [];
  var i;

  if (groupId) {
    for (i = 0; i < all.length; i++) {
      if (String(all[i].groupId || "") === groupId) group.push(all[i]);
    }
    if (group.length > 0) return group;
  }

  var baseId = String((payload && payload.baseId) || "");
  if (!baseId) return [];
  var prefix = baseId + "_";
  for (i = 0; i < all.length; i++) {
    var id = String(all[i].id || "");
    if (id === baseId || id.indexOf(prefix) === 0) group.push(all[i]);
  }
  return group;
}

/**
 * Stamps the group's Telegram message id onto every row of the group.
 *
 * One pass over the sheet for the whole group, not one per row.
 * `updateOmadTransactionMsgId_` reads the entire sheet to find its row, so
 * calling it in a loop cost a full read per line -- two for a tenant-paid
 * pair, on every report, on top of the read that composed it.
 */
function applyMsgIdToGroup_(doc, group, messageId) {
  if (!messageId || !group || group.length === 0) return;

  var sheetName = activeTransactionSheetName_(doc);
  var txSheet = doc.getSheetByName(sheetName);
  if (!txSheet || txSheet.getLastRow() < 2) return;

  var column = sheetName === OMAD_TRANSACTIONS_V2_SHEET ? 21 : 10;
  var g;

  // The ledger reader already carries each row's position, so the rows this
  // report was composed from can be written to directly -- no second pass over
  // the sheet at all.
  var known = 0;
  for (g = 0; g < group.length; g++) if (group[g].rowNumber) known++;
  if (known === group.length) {
    for (g = 0; g < group.length; g++) {
      txSheet.getRange(group[g].rowNumber, column).setValue(messageId);
    }
    return;
  }

  // The legacy reader does not, so those rows are found in one pass for the
  // whole group rather than one pass per row.
  var wanted = {};
  for (g = 0; g < group.length; g++) wanted[String(group[g].id)] = true;

  var data = txSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (wanted[String(data[i][0])]) txSheet.getRange(i + 1, column).setValue(messageId);
  }
}

/**
 * Removes a group report.
 *
 * Deleting is a statement about the end state, not about who got there first:
 * if the message is already gone the job has nothing left to do and is done.
 * Retrying that forever only produced a permanently failed queue entry, which
 * is what happened when one deletion was requested twice.
 */
function runOmadDeleteReportJob_(job) {
  var messageId = String((job.payload && job.payload.messageId) || "");
  if (!messageId) return;

  var chatId = getOmadGroupChatId_();
  if (!chatId) throw new Error("Telegram guruh ID o'rnatilmagan.");

  deleteTelegramMessageIfPresent_(chatId, messageId);
}

function queueCafeCloseDayReport_(doc, payload) {
  return enqueueJob_(doc, "cafe_close_day_report", "", {
    date: String(payload.date || ""),
    seller: String(payload.seller || "").slice(0, TELEGRAM_MAX_FIELD_LENGTH),
    totalRevenue: Number(payload.totalRevenue) || 0,
    totalProfit: Number(payload.totalProfit) || 0,
    summary: Array.isArray(payload.summary) ? payload.summary.slice(0, 200) : [],
    soldItems: Array.isArray(payload.soldItems) ? payload.soldItems.slice(0, 200) : []
  });
}

function runCafeCloseDayReportJob_(job) {
  var chatId = getOmadGroupChatId_();
  if (!chatId) throw new Error("Telegram guruh ID o'rnatilmagan.");
  var text = buildCafeCloseDayMessage_(job.payload);
  sendTelegramMessage_(chatId, text, null, "HTML");
}

// ----- apps-script/12_cafe.gs --------------------------------------------------

// ============================================================
// Café operations
// ------------------------------------------------------------
// Inventory/recipes/categories/settings for cafe_admin.html, and sales, voids
// and close-day for cafe_pos.html. Behaviour is unchanged from the version
// that lived inline in doPost.
// ============================================================

var CAFE_SALES_HEADER = ["Sana", "Sotuvchi", "Jami_Tushum", "Sof_Foyda", "Chek_Tafsilotlari", "ID"];
var CAFE_CLOSE_DAY_HEADER = ["Sana", "Sotuvchi", "Jami_Tushum", "Sof_Foyda", "Tafsilotlar_JSON"];

/**
 * A counter bumped on every inventory write, whoever makes it.
 *
 * The admin screen edits stock and prices as a whole object, and the till now
 * depletes stock on the server. Without a version to check against, an admin
 * page opened this morning and saved this evening would put back everything
 * the day had sold -- silently, and in a way that only shows up as a stock
 * count that no longer matches the shelf.
 */
var CAFE_INVENTORY_REV_KEY = "Cafe_Inventory_Rev";

function cafeInventoryRev_(configSheet) {
  return Number(getConfig(configSheet, CAFE_INVENTORY_REV_KEY)) || 0;
}

/** The one place inventory is written, so the revision cannot be forgotten. */
function writeCafeInventory_(configSheet, inventory) {
  setConfig(configSheet, "Cafe_Inventory", JSON.stringify(inventory || []));
  var next = cafeInventoryRev_(configSheet) + 1;
  setConfig(configSheet, CAFE_INVENTORY_REV_KEY, String(next));
  return next;
}

var CAFE_MUTATIONS = {
  save_inventory: true, save_recipe: true, save_categories: true,
  save_cafe_settings: true, save_sale: true, void_sale: true, close_day: true
};

/**
 * Which role each café mutation belongs to.
 *
 * The catalogue is the manager's; the till is the seller's. Neither of them
 * gets the other's, and neither gets the accounting.
 */
var CAFE_ACTION_ROLES = {
  save_inventory: "admin", save_recipe: "admin", save_categories: "admin",
  save_cafe_settings: "admin", save_sale: "sell", void_sale: "sell", close_day: "sell"
};

function isCafeAction_(action) {
  return CAFE_MUTATIONS[String(action || "")] === true;
}

/**
 * Handles every café action. Returns a ContentService output, or null when the
 * action does not belong to the café, so the router can carry on.
 *
 * Every one of these writes: inventory, recipes, prices, sales, voids and the
 * close-day record. They were reachable by anyone who knew the /exec URL, which
 * meant anyone could rewrite the stock or file a sale. They now take a session
 * whose role says which half of the café it may touch.
 */
function handleCafeAction_(action, payload, doc, configSheet) {
  if (!isCafeAction_(action)) return null;

  var auth = authorizeWebRequest_(payload, CAFE_ACTION_ROLES[action] === "admin"
    ? AUTH_ROLES_CAFE_ADMIN
    : AUTH_ROLES_CAFE_SELL);
  if (!auth.ok) return authRefusal_(auth);

  if (action === 'save_inventory') {
    // Optimistic concurrency. The screen says which version it was looking at;
    // anything else means stock moved underneath it and its copy is a
    // rollback waiting to happen.
    var currentRev = cafeInventoryRev_(configSheet);
    if (currentRev > 0 && Number(payload.expectedRev) !== currentRev) {
      return jsonOutput_({
        status: "error", stale: true, inventoryRev: currentRev,
        message: "Ombor boshqa joyda o'zgardi. Sahifani yangilab, qaytadan kiriting."
      });
    }
    return jsonOutput_({
      status: "success",
      inventoryRev: writeCafeInventory_(configSheet, payload.inventory)
    });
  }
  if (action === 'save_recipe') {
    setConfig(configSheet, "Cafe_Recipes", JSON.stringify(payload.recipes));
    return jsonOutput_({ status: "success" });
  }
  if (action === 'save_categories') {
    setConfig(configSheet, "Cafe_Categories", JSON.stringify(payload.categories));
    return jsonOutput_({ status: "success" });
  }
  if (action === 'save_cafe_settings') {
    setConfig(configSheet, "Cafe_Settings", JSON.stringify(payload.settings));
    return jsonOutput_({ status: "success" });
  }
  if (action === 'save_sale') return saveCafeSale_(doc, configSheet, payload);
  if (action === 'void_sale') return voidCafeSale_(doc, configSheet, payload);
  if (action === 'close_day') return closeCafeDay_(doc, configSheet, payload);
  return null;
}

// ------------------------------------------------------- authoritative pricing
//
// The browser used to decide what a sale was worth. It sent the total, the
// cost and the profit, and the server wrote them down; it also depleted stock
// only in its own memory, so a refresh restored the stock it had just sold and
// two devices each tracked a different inventory.
//
// Everything below computes those figures from what is stored: the price on
// the product or recipe, the recipe's ingredients, and the stock on hand. The
// client says which items and how many; the server decides the rest.

var CAFE_STOCK_EPSILON = 0.0001;

/**
 * Just the catalogue: what can be sold and what it costs.
 *
 * `readCafeState_` also reads the whole Cafe_Sales sheet and the whole
 * close-day sheet. Pricing a sale needs neither, and a sale already scans the
 * sales sheet once for its request id -- reading it a second time to find the
 * price of a bottle of cola is hundreds of rows of work per transaction, and
 * grows with every sale ever made.
 */
function cafeCatalogue_(configSheet) {
  return {
    inventory: safeParseJSON_(getConfig(configSheet, "Cafe_Inventory"), []),
    recipes: safeParseJSON_(getConfig(configSheet, "Cafe_Recipes"), [])
  };
}

/** Rounds a quantity the way the POS does, so stock stays comparable. */
function cafeRoundQty_(value) {
  var n = Number(value) || 0;
  return Math.round(n * 10000) / 10000;
}

/** Index inventory by id once, rather than scanning per line. */
function cafeInventoryIndex_(inventory) {
  var map = {};
  for (var i = 0; i < inventory.length; i++) {
    map[String(inventory[i].id)] = inventory[i];
  }
  return map;
}

function cafeRecipeIndex_(recipes) {
  var map = {};
  for (var i = 0; i < recipes.length; i++) map[String(recipes[i].id)] = recipes[i];
  return map;
}

/** What one unit of a product costs us, honouring bulk servings. */
function cafeProductUnitCost_(product) {
  if (product.isBulk && Number(product.gramsPerServing) > 0) {
    return Math.round((Number(product.unitCost) || 0) * (Number(product.gramsPerServing) / 1000));
  }
  return Number(product.unitCost) || 0;
}

/** How much stock one sold unit consumes. */
function cafeProductStockPerUnit_(product) {
  if (product.isBulk && Number(product.gramsPerServing) > 0) {
    return Number(product.gramsPerServing) / 1000;
  }
  return 1;
}

/**
 * Turns the requested items into priced lines, or explains why it cannot.
 *
 * Nothing on the request is trusted for money: `price` and `baseCost` are read
 * from the stored product or recipe, never from the payload. An item the
 * catalogue does not contain is refused rather than sold at whatever the
 * caller suggested.
 */
function resolveCafeSaleLines_(state, items) {
  var requested = Array.isArray(items) ? items : [];
  if (requested.length === 0) return { error: "Savat bo'sh." };
  if (requested.length > 200) return { error: "Savatda juda ko'p mahsulot." };

  var inventory = cafeInventoryIndex_(state.inventory);
  var recipes = cafeRecipeIndex_(state.recipes);
  var lines = [];
  var consumption = {};   // inventory id -> { qty, cost }

  var consume = function (id, qty, cost) {
    var key = String(id);
    if (!consumption[key]) consumption[key] = { qty: 0, cost: 0 };
    consumption[key].qty += qty;
    consumption[key].cost += cost;
  };

  for (var i = 0; i < requested.length; i++) {
    var item = requested[i] || {};
    var qty = Number(item.qty);
    if (!isFinite(qty) || qty <= 0) return { error: "Miqdor musbat bo'lishi kerak." };
    if (qty > 100000) return { error: "Miqdor juda katta." };

    var kind = String(item.kind || "");

    if (kind === "recipe") {
      var recipe = recipes[String(item.recipeId)];
      if (!recipe) return { error: "Retsept topilmadi: " + String(item.name || item.recipeId || "") };
      var recipePrice = Number(recipe.sellPrice) || 0;
      if (recipePrice <= 0) return { error: "Retsept narxi belgilanmagan: " + String(recipe.name || "") };

      var recipeCost = 0;
      var ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
      for (var g = 0; g < ingredients.length; g++) {
        var ing = ingredients[g] || {};
        var ingQty = (Number(ing.qty) || 0) * qty;
        var ingCost = (Number(ing.cost) || 0) * qty;
        recipeCost += ingCost;
        if (ing.inventoryId) consume(ing.inventoryId, ingQty, ingCost);
      }
      // A recipe may record its own cost; the ingredients are the truth when
      // they exist, because that is what the stock movement will charge.
      if (ingredients.length === 0) recipeCost = (Number(recipe.baseCost) || 0) * qty;

      lines.push({
        id: String(item.id || ("recipe_" + recipe.id)),
        kind: "recipe", recipeId: String(recipe.id),
        name: String(recipe.name || ""), qty: qty,
        price: recipePrice, baseCost: ingredients.length ? Math.round(recipeCost / qty) : (Number(recipe.baseCost) || 0),
        lineTotal: Math.round(recipePrice * qty),
        lineCost: Math.round(recipeCost)
      });
      continue;
    }

    var product = inventory[String(item.inventoryId)];
    if (!product) return { error: "Mahsulot topilmadi: " + String(item.name || item.inventoryId || "") };
    if (product.type !== "product") return { error: "Bu mahsulot sotuvda emas: " + String(product.name || "") };
    var price = Number(product.sellPrice) || 0;
    if (price <= 0) return { error: "Mahsulot narxi belgilanmagan: " + String(product.name || "") };

    var unitCost = cafeProductUnitCost_(product);
    var stockPerUnit = cafeProductStockPerUnit_(product);
    consume(product.id, stockPerUnit * qty, unitCost * qty);

    lines.push({
      id: String(item.id || ("product_" + product.id)),
      kind: "product", inventoryId: String(product.id),
      name: String(product.name || ""), qty: qty,
      price: price, baseCost: unitCost,
      isBulk: !!product.isBulk,
      gramsPerServing: Number(product.gramsPerServing) || 0,
      lineTotal: Math.round(price * qty),
      lineCost: Math.round(unitCost * qty)
    });
  }

  var total = 0;
  var cost = 0;
  for (var l = 0; l < lines.length; l++) { total += lines[l].lineTotal; cost += lines[l].lineCost; }

  return {
    lines: lines,
    consumption: consumption,
    total: Math.round(total),
    cost: Math.round(cost),
    profit: Math.round(total - cost)
  };
}

/** Refuses a sale that the stock on hand cannot cover. */
function cafeStockShortfall_(state, consumption) {
  var inventory = cafeInventoryIndex_(state.inventory);
  var short = [];
  Object.keys(consumption).forEach(function (id) {
    var item = inventory[id];
    if (!item) { short.push("Omborda yo'q: " + id); return; }
    var have = Number(item.qty) || 0;
    if (have + CAFE_STOCK_EPSILON < consumption[id].qty) {
      short.push(String(item.name || id) + ": " + have + " " + String(item.unit || "") +
                 " qoldi, " + cafeRoundQty_(consumption[id].qty) + " kerak");
    }
  });
  return short;
}

/**
 * Moves stock. `direction` is -1 for a sale and +1 for a void.
 *
 * The unit cost is recomputed from the remaining total so the next sale is
 * charged what the stock actually cost, which is what the POS did in the
 * browser and what the close-day figures assume.
 */
function applyCafeStockMovement_(state, consumption, direction) {
  var inventory = cafeInventoryIndex_(state.inventory);
  Object.keys(consumption).forEach(function (id) {
    var item = inventory[id];
    if (!item) return;
    item.qty = cafeRoundQty_((Number(item.qty) || 0) + consumption[id].qty * direction);
    item.totalCost = Math.max(0, Math.round((Number(item.totalCost) || 0) + consumption[id].cost * direction));
    if (item.qty > 0) {
      item.unitCost = Math.round(item.totalCost / item.qty);
    } else {
      item.qty = 0;
      item.unitCost = 0;
    }
  });
  return state.inventory;
}

/** The stored sale with this request id, if the request has already run. */
function findCafeSaleByRequestId_(salesSheet, requestId) {
  if (!salesSheet || !requestId || salesSheet.getLastRow() < 2) return null;
  var data = salesSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var detail = safeParseJSON_(data[i][4], null);
    if (detail && String(detail.requestId || "") === String(requestId)) {
      return { rowNumber: i + 1, row: data[i], detail: detail };
    }
  }
  return null;
}

function cafeSaleResponse_(id, date, seller, resolved, inventory) {
  return {
    status: "success",
    sale: {
      id: id, date: date, seller: seller,
      total: resolved.total, profit: resolved.profit, cost: resolved.cost,
      items: resolved.lines
    },
    inventory: inventory
  };
}

/**
 * Records one sale, priced and stock-checked by the server, atomically.
 *
 * The lock matters as much as the arithmetic: reading stock, deciding it is
 * sufficient and writing it back is a read-modify-write, and two tills selling
 * the last item at the same moment would otherwise both succeed.
 */
function saveCafeSale_(doc, configSheet, payload) {
  var requestId = String(payload.requestId || payload.id || "").trim();
  if (!requestId) return jsonOutput_({ status: "error", message: "requestId talab qilinadi." });
  if (requestId.length > 128) return jsonOutput_({ status: "error", message: "requestId juda uzun." });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var salesSheet = doc.getSheetByName("Cafe_Sales") || doc.insertSheet("Cafe_Sales");
    if (salesSheet.getLastRow() === 0) salesSheet.appendRow(CAFE_SALES_HEADER);

    // A retry, a double tap or a redelivered request resolves to the sale the
    // first attempt created rather than ringing it up twice.
    var existing = findCafeSaleByRequestId_(salesSheet, requestId);
    if (existing) {
      var state = cafeCatalogue_(configSheet);
      return jsonOutput_(Object.assign(
        cafeSaleResponse_(String(existing.row[5]), existing.row[0], existing.row[1], {
          total: Number(existing.row[2]) || 0,
          profit: Number(existing.row[3]) || 0,
          cost: (Number(existing.row[2]) || 0) - (Number(existing.row[3]) || 0),
          lines: existing.detail.items || []
        }, state.inventory),
        { duplicate: true }));
    }

    var current = cafeCatalogue_(configSheet);
    var resolved = resolveCafeSaleLines_(current, payload.items);
    if (resolved.error) return jsonOutput_({ status: "error", message: resolved.error });

    var short = cafeStockShortfall_(current, resolved.consumption);
    if (short.length > 0) {
      return jsonOutput_({ status: "error", message: "Omborda yetarli emas — " + short.join("; ") });
    }

    var inventory = applyCafeStockMovement_(current, resolved.consumption, -1);
    writeCafeInventory_(configSheet, inventory);

    var saleId = String(payload.id || new Date().getTime());
    var saleDate = payload.date || new Date().toISOString();
    var seller = String(payload.seller || "").slice(0, 120);

    salesSheet.appendRow([
      saleDate, seller, resolved.total, resolved.profit,
      JSON.stringify({ requestId: requestId, items: resolved.lines }),
      saleId
    ]);
    // After the row, not before it: the inventory write bumped the revision
    // already, and a read landing between the two would otherwise cache a
    // till payload that is missing the sale that has just been recorded.
    bumpDataRevision_(CACHE_SCOPE_CAFE);

    return jsonOutput_(Object.assign(
      cafeSaleResponse_(saleId, saleDate, seller, resolved, inventory),
      { duplicate: false }));
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reverses a stored sale.
 *
 * The stock is restored from the sale that was recorded, not from an inventory
 * the caller supplies. A browser that had drifted -- or one replaying an old
 * screen -- could otherwise overwrite the whole stock with a stale copy under
 * the guise of voiding one receipt.
 */
function voidCafeSale_(doc, configSheet, payload) {
  var saleId = String(payload.id || "").trim();
  if (!saleId) return jsonOutput_({ status: "error", message: "Sotuv ID talab qilinadi." });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var salesSheet = doc.getSheetByName("Cafe_Sales");
    var rowNumber = 0;
    var detail = null;

    if (salesSheet && salesSheet.getLastRow() >= 2) {
      var data = salesSheet.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][5]) === saleId) {
          rowNumber = i + 1;
          detail = safeParseJSON_(data[i][4], null);
          break;
        }
      }
    }

    if (!rowNumber) {
      // Idempotent, including when that receipt was the only one on the sheet.
      // A repeated void of something already gone is not an error, and must
      // never be an excuse to put its stock back a second time.
      var already = cafeCatalogue_(configSheet);
      return jsonOutput_({ status: "success", duplicate: true, inventory: already.inventory });
    }

    var current = cafeCatalogue_(configSheet);
    var restored = resolveCafeSaleLines_(current, cafeReceiptItems_(detail));

    var inventory = current.inventory;
    if (!restored.error) {
      inventory = applyCafeStockMovement_(current, restored.consumption, 1);
      writeCafeInventory_(configSheet, inventory);
    } else {
      // The receipt names something the catalogue no longer has. The sale is
      // still voided -- the money is what matters -- but the stock cannot be
      // put back automatically, and saying so is better than guessing.
      debugLog_(doc, "cafe_void_stock_unresolved", saleId + ": " + restored.error);
    }

    salesSheet.deleteRow(rowNumber);
    bumpDataRevision_(CACHE_SCOPE_CAFE);
    appendAuditRow_(doc, "cafe_sale_voided", saleId);

    return jsonOutput_({
      status: "success", duplicate: false, inventory: inventory,
      stockRestored: !restored.error
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Closes the day.
 *
 * Revenue, profit and the sale count are totalled from the sales that were
 * actually recorded; the browser's own running totals are not consulted. A
 * counted stock level *is* user-measured -- somebody looked in the fridge --
 * so it is accepted when supplied, and the day's own arithmetic is what
 * decides the money.
 */
function closeCafeDay_(doc, configSheet, payload) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var state = readCafeState_(doc, configSheet);
    var dayKey = cafeDateKey_(payload.date || new Date().toISOString());

    var revenue = 0;
    var profit = 0;
    var count = 0;
    for (var i = 0; i < state.sales.length; i++) {
      if (cafeDateKey_(state.sales[i].date) !== dayKey) continue;
      revenue += Number(state.sales[i].total) || 0;
      profit += Number(state.sales[i].profit) || 0;
      count++;
    }

    // A physical count is the one thing only a person can supply.
    // A physical count is a measurement, not an edit of a stale copy, so it
    // is not version-checked -- what is on the shelf is what is on the shelf.
    if (Array.isArray(payload.countedInventory)) {
      writeCafeInventory_(configSheet, payload.countedInventory);
      state.inventory = payload.countedInventory;
    }

    var closeSheet = doc.getSheetByName("Cafe_Kun_Yakuni") || doc.insertSheet("Cafe_Kun_Yakuni");
    if (closeSheet.getLastRow() === 0) closeSheet.appendRow(CAFE_CLOSE_DAY_HEADER);
    closeSheet.appendRow([
      payload.date || new Date().toISOString(),
      String(payload.seller || "").slice(0, 120),
      Math.round(revenue),
      Math.round(profit),
      JSON.stringify(Array.isArray(payload.summary) ? payload.summary : [])
    ]);
    bumpDataRevision_(CACHE_SCOPE_CAFE);

    var report = {
      date: payload.date, seller: payload.seller,
      totalRevenue: Math.round(revenue), totalProfit: Math.round(profit),
      salesCount: count, summary: payload.summary
    };

    // The close-day record is stored. Its Telegram report is queued
    // server-side; the browser never composes a Telegram message, and queueing
    // must never undo a close-day that is already stored.
    var closeJobId = "";
    try {
      closeJobId = queueCafeCloseDayReport_(doc, report);
    } catch (queueError) {
      debugLog_(doc, "report_enqueue_failed", String(queueError));
    }
    drainJobQueueQuietly_(doc, payload);

    return jsonOutput_({
      status: "success", reportJobId: closeJobId || "",
      totalRevenue: Math.round(revenue), totalProfit: Math.round(profit),
      salesCount: count, inventory: state.inventory
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * The sale lines out of a stored receipt, whichever shape it is in.
 *
 * A receipt written since the café became server-authoritative is
 * `{ requestId, items: [...] }`; one written before that is the bare array.
 * Readers were handing the *wrapper* on as `items`, so anything doing
 * `sale.items.forEach(...)` threw on every modern receipt — which in the POS
 * meant the load failed, and the failure path emptied the till. Both shapes
 * resolve to the array here, once, so no caller has to know there are two.
 */
function cafeReceiptItems_(raw) {
  var parsed = raw && typeof raw === "object" ? raw : safeParseJSON_(raw, null);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.items)) return parsed.items;
  return [];
}

/**
 * Sales as figures, with each receipt left as the text it is stored as.
 *
 * `readCafeState_` parses the receipt JSON of every sale ever made, because
 * the admin screen edits receipts. Nothing that only wants totals needs that:
 * the Mini App summary adds up revenue and profit over the whole history and
 * shows a line count for the last ten sales, so parsing seven hundred receipts
 * to answer it was the bulk of the work in that request. Callers that need a
 * receipt parse `itemsRaw` for the few rows they actually show.
 */
function readCafeSalesLean_(doc) {
  var sheet = doc.getSheetByName("Cafe_Sales");
  var rows = [];
  if (!sheet || sheet.getLastRow() < 2) return rows;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    rows.push({
      date: data[i][0], seller: data[i][1], total: data[i][2],
      profit: data[i][3], itemsRaw: data[i][4], id: data[i][5]
    });
  }
  return rows;
}

/** Close-day records without their per-item summary, for the same reason. */
function readCafeClosingsLean_(doc) {
  var sheet = doc.getSheetByName("Cafe_Kun_Yakuni");
  var rows = [];
  if (!sheet || sheet.getLastRow() < 2) return rows;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    rows.push({
      date: data[i][0], seller: data[i][1],
      totalRevenue: data[i][2], totalProfit: data[i][3]
    });
  }
  return rows;
}

// ------------------------------------------------------------- scoped reads
//
// `readCafeState_` sends every sale ever made, with its receipt parsed, to
// whichever screen asked. Neither screen wants that:
//
//   * the till needs the catalogue and *today's* receipts, so it can show the
//     progress bar and offer a void;
//   * the manager needs the catalogue and *totals*, which are four numbers per
//     period plus a best-seller.
//
// Both used to be produced in the browser out of the whole history, so the
// response grew with every sale the business had ever rung up, and the phone
// parsed all of it to display four figures. The catalogue is unchanged; only
// what is derived from the sales sheet is scoped.
//
// The full payload is still what an unscoped request gets, so nothing that
// already works has to know about this.

var CAFE_ADMIN_RECENT_CLOSINGS = 30;

/** How long a café display summary may be reused. Every write bumps the key. */
var CAFE_SUMMARY_TTL_SECONDS = 120;

/** Routes `get_cafe_data` to the payload the asking screen actually needs. */
function readCafePayloadForScope_(doc, configSheet, payload) {
  var scope = String((payload && payload.scope) || "");
  if (scope === "pos") return readCafePosPayload_(doc, configSheet, payload);
  if (scope === "admin") return readCafeAdminPayload_(doc, configSheet, payload);
  return readCafeState_(doc, configSheet);
}

/** A yyyy-MM-dd the caller supplied, or today in the script's timezone. */
function cafeRequestedDayKey_(value) {
  var text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

/** The catalogue every café screen starts from. */
function cafeScreenCatalogue_(configSheet) {
  return {
    inventory: safeParseJSON_(getConfigOnce_(configSheet, "Cafe_Inventory"), []),
    inventoryRev: cafeInventoryRev_(configSheet),
    recipes: safeParseJSON_(getConfigOnce_(configSheet, "Cafe_Recipes"), []),
    categories: safeParseJSON_(getConfigOnce_(configSheet, "Cafe_Categories"),
      ["Ichimliklar", "Fast-Food", "Muzqaymoq"]),
    settings: safeParseJSON_(getConfigOnce_(configSheet, "Cafe_Settings"), { dailyTarget: 0 })
  };
}

/**
 * The till: the catalogue plus the receipts this cashier rang up today.
 *
 * Cached against the café revision, which every sale, void, close-day and
 * catalogue edit bumps — so the entry is unreachable the moment anything it
 * describes changes, and the till is never shown a stale shelf. If the cache
 * is empty the same answer is computed from the sheets.
 */
function readCafePosPayload_(doc, configSheet, payload) {
  var dayKey = cafeRequestedDayKey_(payload && payload.dateKey);
  var seller = String((payload && payload.seller) || "").slice(0, 120);

  return cachedSummary_("cafe_pos_" + dayKey + "_" + seller, CACHE_SCOPE_CAFE,
    CAFE_SUMMARY_TTL_SECONDS, function () {
      var body = cafeScreenCatalogue_(configSheet);
      body.status = "success";
      body.scope = "pos";
      body.dateKey = dayKey;
      body.sales = readCafeSalesForDay_(doc, dayKey, seller);
      return body;
    });
}

/** Today's receipts for one cashier, parsed — a bounded number of rows. */
function readCafeSalesForDay_(doc, dayKey, seller) {
  var rows = readCafeSalesLean_(doc);
  var sales = [];
  for (var i = 0; i < rows.length; i++) {
    if (cafeDateKey_(rows[i].date) !== dayKey) continue;
    if (seller && String(rows[i].seller || "") !== seller) continue;
    sales.push({
      date: rows[i].date, seller: rows[i].seller, total: rows[i].total,
      profit: rows[i].profit, items: cafeReceiptItems_(rows[i].itemsRaw), id: rows[i].id
    });
  }
  return sales;
}

/**
 * The manager: the catalogue, the period totals and the recent closings.
 *
 * The four period figures and the best-seller are exactly what the dashboard
 * used to compute in the browser, from the entire sales history it had been
 * sent. The day boundaries come from the caller so "today" still means the day
 * the person looking at the screen is having.
 */
function readCafeAdminPayload_(doc, configSheet, payload) {
  var todayKey = cafeRequestedDayKey_(payload && payload.todayKey);
  var yesterdayKey = /^\d{4}-\d{2}-\d{2}$/.test(String((payload && payload.yesterdayKey) || ""))
    ? String(payload.yesterdayKey)
    : "";
  var monthKey = /^\d{4}-\d{2}$/.test(String((payload && payload.monthKey) || ""))
    ? String(payload.monthKey)
    : todayKey.slice(0, 7);

  var closingsLimit = Math.min(Math.max(Number(payload && payload.closingsLimit) || 0,
    CAFE_ADMIN_RECENT_CLOSINGS), 500);

  return cachedSummary_(
    "cafe_admin_" + todayKey + "_" + yesterdayKey + "_" + monthKey + "_" + closingsLimit,
    CACHE_SCOPE_CAFE, CAFE_SUMMARY_TTL_SECONDS, function () {
      var body = cafeScreenCatalogue_(configSheet);
      body.status = "success";
      body.scope = "admin";
      body.summary = buildCafeDashboardSummary_(doc, todayKey, yesterdayKey, monthKey);
      // Newest-first and paged. The count travels with the page so the screen
      // can say how many it is not showing rather than silently stopping.
      var closings = readCafeRecentClosings_(doc, closingsLimit);
      body.closeReports = closings.rows;
      body.closeReportsTotal = closings.total;
      return body;
    });
}

/** Revenue, profit, sale count and best-seller for each dashboard period. */
function buildCafeDashboardSummary_(doc, todayKey, yesterdayKey, monthKey) {
  var rows = readCafeSalesLean_(doc);
  var buckets = {
    today: cafeEmptyBucket_(), yesterday: cafeEmptyBucket_(),
    month: cafeEmptyBucket_(), all: cafeEmptyBucket_()
  };

  for (var i = 0; i < rows.length; i++) {
    var key = cafeDateKey_(rows[i].date);
    var targets = ["all"];
    if (todayKey && key === todayKey) targets.push("today");
    if (yesterdayKey && key === yesterdayKey) targets.push("yesterday");
    if (monthKey && key.indexOf(monthKey) === 0) targets.push("month");

    var revenue = Number(rows[i].total) || 0;
    var profit = Number(rows[i].profit) || 0;
    // One parse per row, once, on the server — instead of one per row in every
    // browser that opens the dashboard, on top of shipping it there.
    var items = cafeReceiptItems_(rows[i].itemsRaw);

    for (var t = 0; t < targets.length; t++) {
      var bucket = buckets[targets[t]];
      bucket.revenue += revenue;
      bucket.profit += profit;
      bucket.count++;
      for (var n = 0; n < items.length; n++) {
        var name = String((items[n] || {}).name || "");
        if (!name) continue;
        bucket.items[name] = (bucket.items[name] || 0) + (Number(items[n].qty) || 0);
      }
    }
  }

  var summary = {};
  Object.keys(buckets).forEach(function (name) {
    summary[name] = cafeFinishBucket_(buckets[name]);
  });
  return summary;
}

function cafeEmptyBucket_() {
  return { revenue: 0, profit: 0, count: 0, items: {} };
}

function cafeFinishBucket_(bucket) {
  var top = "";
  var best = 0;
  Object.keys(bucket.items).forEach(function (name) {
    if (bucket.items[name] > best) { best = bucket.items[name]; top = name; }
  });
  return {
    revenue: Math.round(bucket.revenue),
    profit: Math.round(bucket.profit),
    count: bucket.count,
    top: top
  };
}

/**
 * The most recent close-day records, newest first, with their summaries, and
 * how many there are in total.
 *
 * Only the page that is shown has its per-item summary parsed; the count comes
 * from the row count, so "showing 30 of 214" costs nothing.
 */
function readCafeRecentClosings_(doc, limit) {
  var sheet = doc.getSheetByName("Cafe_Kun_Yakuni");
  if (!sheet || sheet.getLastRow() < 2) return { rows: [], total: 0 };

  var data = sheet.getDataRange().getValues();
  var start = Math.max(1, data.length - limit);
  var rows = [];
  for (var i = start; i < data.length; i++) {
    rows.push({
      date: data[i][0], seller: data[i][1], totalRevenue: data[i][2],
      totalProfit: data[i][3], summary: safeParseJSON_(data[i][4], [])
    });
  }
  rows.reverse();
  return { rows: rows, total: data.length - 1 };
}

/** Everything cafe_admin.html and cafe_pos.html need on load. */
function readCafeState_(doc, configSheet) {
  var salesSheet = doc.getSheetByName("Cafe_Sales");
  var sales = [];
  if (salesSheet && salesSheet.getLastRow() > 1) {
    var salesData = salesSheet.getDataRange().getValues();
    for (var j = 1; j < salesData.length; j++) {
      sales.push({
        date: salesData[j][0], seller: salesData[j][1], total: salesData[j][2],
        profit: salesData[j][3], items: cafeReceiptItems_(salesData[j][4]), id: salesData[j][5]
      });
    }
  }

  var closeSheet = doc.getSheetByName("Cafe_Kun_Yakuni");
  var closeReports = [];
  if (closeSheet && closeSheet.getLastRow() > 1) {
    var closeData = closeSheet.getDataRange().getValues();
    for (var k = 1; k < closeData.length; k++) {
      closeReports.push({
        date: closeData[k][0], seller: closeData[k][1], totalRevenue: closeData[k][2],
        totalProfit: closeData[k][3], summary: safeParseJSON_(closeData[k][4], [])
      });
    }
  }

  return {
    // The unscoped payload answered without a status at all, which meant the
    // one thing a client can rely on -- "the server said this worked" -- was
    // the absence of an error. The scoped payloads say so; so does this one.
    status: "success",
    inventory: safeParseJSON_(getConfig(configSheet, "Cafe_Inventory"), []),
    inventoryRev: cafeInventoryRev_(configSheet),
    recipes: safeParseJSON_(getConfig(configSheet, "Cafe_Recipes"), []),
    categories: safeParseJSON_(getConfig(configSheet, "Cafe_Categories"), ["Ichimliklar", "Fast-Food", "Muzqaymoq"]),
    settings: safeParseJSON_(getConfig(configSheet, "Cafe_Settings"), { dailyTarget: 0 }),
    sales: sales,
    closeReports: closeReports
  };
}

// ----- apps-script/13_migration.gs ---------------------------------------------

// ============================================================
// Migration to canonical year-month periods
// ------------------------------------------------------------
// The original sheet is never overwritten. Migrated rows are written to a new
// versioned sheet, verified, and only then read from. Rollback is a config
// change, not a restore.
//
//   preview  -> what would happen, writing nothing
//   apply    -> write Omad_Transactions_V2 (original untouched)
//   verify   -> row counts, unique ids, per-period totals, balances
//   cutover  -> point reads at V2
//   rollback -> point reads back at the original
// ============================================================

var MIGRATION_STATUS_KEY = "Omad_Migration_Status";
var MIGRATION_SCHEMA_VERSION = LEDGER_SCHEMA_VERSION;

/**
 * Resolves every row without writing anything.
 *
 * Returns the proposed period for each row, a per-year summary, the rows whose
 * year could not be determined, duplicate ids, and the pre-migration financial
 * totals that verification will compare against.
 */
function previewOmadMigration_(doc, options) {
  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  var fallbackYear = Number((options && options.fallbackYear) || 0) || getFallbackYear_(configSheet);

  var sourceName = OMAD_TRANSACTIONS_SHEET;
  var sourceSheet = doc.getSheetByName(sourceName);
  var rows = readRawTransactionRows_(sourceSheet);

  var byYear = {};
  var bySource = {};
  var unresolved = [];
  var resolvedRows = [];
  var idCounts = {};

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var resolution = resolveTransactionPeriod_(row, fallbackYear);
    idCounts[String(row.id)] = (idCounts[String(row.id)] || 0) + 1;
    bySource[resolution.source] = (bySource[resolution.source] || 0) + 1;

    if (!resolution.period) {
      unresolved.push({
        rowNumber: row.rowNumber,
        id: String(row.id),
        month: String(row.month),
        date: String(row.date),
        amount: Number(row.amount) || 0,
        currency: String(row.currency),
        reason: resolution.detail || resolution.source
      });
      continue;
    }

    var year = periodYear_(resolution.period);
    byYear[year] = (byYear[year] || 0) + 1;
    resolvedRows.push({ row: row, period: resolution.period, source: resolution.source });
  }

  var duplicateIds = Object.keys(idCounts).filter(function (id) { return idCounts[id] > 1; }).sort();

  return {
    sourceSheet: sourceName,
    targetSheet: OMAD_TRANSACTIONS_V2_SHEET,
    fallbackYear: fallbackYear,
    fallbackYearRequired: bySource.needs_fallback_year > 0 || bySource.conflict > 0,
    totalRows: rows.length,
    resolvedRows: resolvedRows.length,
    byYear: byYear,
    bySource: bySource,
    unresolved: unresolved,
    duplicateIds: duplicateIds,
    // What verification will compare against.
    totalsByPeriod: totalsByPeriod_(resolvedRows),
    balances: balanceTotals_(rows),
    ratePreview: migrateRatesMap_(safeParseJSON_(getConfig(configSheet, "Omad_Rates"), {}), fallbackYear),
    canApply: rows.length > 0 && unresolved.length === 0 && duplicateIds.length === 0
  };
}

/** Raw rows with their sheet row number, so the operator can find them. */
function readRawTransactionRows_(sheet) {
  var rows = [];
  if (!sheet || sheet.getLastRow() < 2) return rows;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === "" || data[i][0] === null || data[i][0] === undefined) continue;
    rows.push({
      rowNumber: i + 1,
      id: data[i][0], tenant: data[i][1], month: data[i][2], type: data[i][3],
      amount: data[i][4], currency: data[i][5], method: data[i][6],
      date: data[i][7], comment: data[i][8], msgId: data[i][9],
      requestId: data[i].length > 10 ? data[i][10] : "",
      groupId: data[i].length > 11 ? data[i][11] : "",
      // Column 13. Absent on rows written before the tenant-paid feature, and
      // the migration cannot carry across what it never read.
      entryKind: data[i].length > 12 ? data[i][12] : ""
    });
  }
  return rows;
}

/** Signed UZS totals per period, using each period's own sell rate. */
function totalsByPeriod_(resolvedRows) {
  var rates = getOmadRates_();
  var totals = {};
  for (var i = 0; i < resolvedRows.length; i++) {
    var entry = resolvedRows[i];
    var value = toUZS_(entry.row.amount, entry.row.currency, entry.period, rates, "sell");
    var sign = entry.row.type === "Income" ? 1 : -1;
    totals[entry.period] = Math.round((totals[entry.period] || 0) + value * sign);
  }
  return totals;
}

/** Cash, bank and total balances - invariants the migration must not move. */
function balanceTotals_(rows) {
  var rates = getOmadRates_();
  var cash = 0;
  var bank = 0;
  var income = 0;
  var expense = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var period = transactionPeriod_(row);
    var value = toUZS_(row.amount, row.currency, period, rates, "sell");
    var sign = row.type === "Income" ? 1 : -1;
    if (row.type === "Income") income += value; else expense += value;
    if (row.method === "Bank") bank += value * sign; else cash += value * sign;
  }

  return {
    cash: Math.round(cash),
    bank: Math.round(bank),
    total: Math.round(cash + bank),
    income: Math.round(income),
    expense: Math.round(expense)
  };
}

/**
 * Writes the migrated rows to the versioned sheet. The source sheet is not
 * touched, which is what makes rollback cheap.
 *
 * The target sheet is rewritten from scratch every time, so an interrupted
 * apply is recovered simply by running it again.
 */
function applyOmadMigration_(doc, options) {
  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  var preview = previewOmadMigration_(doc, options);

  if (preview.totalRows === 0) {
    return { status: "error", message: "Ko'chiriladigan yozuv yo'q.", preview: preview };
  }
  if (preview.duplicateIds.length > 0) {
    return {
      status: "error",
      message: "Takrorlangan ID topildi: " + preview.duplicateIds.join(", "),
      preview: preview
    };
  }
  if (preview.unresolved.length > 0 && options.allowUnresolved !== true) {
    return {
      status: "error",
      message: preview.unresolved.length + " ta yozuvning yili aniqlanmadi. " +
               "Zaxira yilni tanlang yoki sanalarni tuzating.",
      preview: preview
    };
  }

  if (preview.fallbackYear) setFallbackYear_(configSheet, preview.fallbackYear);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    backupOmadState_(doc, configSheet, "pre_period_migration");

    // The target is rebuilt from scratch, so an interrupted apply is recovered
    // simply by running it again.
    var target = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET) ||
                 doc.insertSheet(OMAD_TRANSACTIONS_V2_SHEET);
    clearSheetRows_(target);
    target.appendRow(LEDGER_HEADER);

    var sourceRows = readRawTransactionRows_(doc.getSheetByName(OMAD_TRANSACTIONS_SHEET));
    var migratedAt = new Date().toISOString();
    var written = [];
    for (var i = 0; i < sourceRows.length; i++) {
      var resolution = resolveTransactionPeriod_(sourceRows[i], preview.fallbackYear);
      if (!resolution.period) continue;
      written.push(transactionToLedgerRow_(
        migratedRowToLedger_(sourceRows[i], resolution.period, migratedAt)));
    }
    if (written.length > 0) {
      // Formats first: every migrated row carries a canonical period, and the
      // spreadsheet would otherwise turn all of them into dates on the way in.
      applyLedgerColumnFormats_(target, 2, written.length);
      target.getRange(2, 1, written.length, LEDGER_HEADER.length).setValues(written);
    }

    // Rates carry a month but no date of their own, so they follow the same
    // fallback year. The original map is kept in the audit trail.
    var rateMigration = migrateRatesMap_(
      safeParseJSON_(getConfig(configSheet, "Omad_Rates"), {}), preview.fallbackYear);
    setConfig(configSheet, "Omad_Rates_V1_Backup", getConfig(configSheet, "Omad_Rates") || "{}");
    setConfig(configSheet, "Omad_Rates", JSON.stringify(rateMigration.rates));

    recordMigrationStatus_(configSheet, {
      state: "applied",
      appliedAt: new Date().toISOString(),
      fallbackYear: preview.fallbackYear,
      sourceRows: preview.totalRows,
      migratedRows: written.length,
      skippedRows: preview.totalRows - written.length,
      schemaVersion: MIGRATION_SCHEMA_VERSION
    });
    appendAuditRow_(doc, "omad_period_migration_applied", JSON.stringify({
      migrated: written.length, skipped: preview.totalRows - written.length,
      fallbackYear: preview.fallbackYear, byYear: preview.byYear
    }));
  } finally {
    lock.releaseLock();
  }

  return { status: "success", preview: preview, verification: verifyOmadMigration_(doc) };
}

/**
 * Compares the migrated sheet against the original: row counts, unique ids,
 * per-period totals and the cash/bank/total balances.
 */
/**
 * The UZS value a migrated row *claims*, checked against its own frozen rate.
 *
 * A frozen value must never be re-derived from the current rate table - that
 * is the whole point of freezing it, and doing so would make verification
 * agree with any figure the table happens to produce today. It is instead
 * checked for internal consistency: the amount, the rate recorded on the row,
 * and the stored total have to describe the same conversion.
 */
function frozenAmountFailures_(row) {
  var failures = [];
  var amount = Number(row.amount) || 0;
  var stored = Number(row.amountUZS);
  var used = Number(row.rateUsed) || 0;

  if (!isFinite(stored)) {
    failures.push("Amount_UZS o'qib bo'lmadi: " + row.id);
    return failures;
  }

  if (row.currency === "USD") {
    if (used <= 0) {
      failures.push("Rate_Used yo'q: " + row.id);
    } else if (Math.abs(stored - Math.round(amount * used)) > 1) {
      failures.push("Amount_UZS noto'g'ri (" + row.id + "): " +
                    stored + " != " + Math.round(amount * used));
    }
    // The applied rate must be one of the two recorded on the row.
    var buy = Number(row.rateBuy) || 0;
    var sell = Number(row.rateSell) || 0;
    if (used > 0 && used !== buy && used !== sell) {
      failures.push("Rate_Used saqlangan kurslarga mos emas: " + row.id);
    }
    if (row.rateType === "sell" && sell > 0 && used !== sell) {
      failures.push("Sotish kursi ishlatilmagan: " + row.id);
    }
  } else if (Math.abs(stored - Math.round(amount)) > 1) {
    failures.push("UZS Amount_UZS asl summaga teng emas (" + row.id + "): " +
                  stored + " != " + Math.round(amount));
  }

  return failures;
}

/**
 * Every migrated row against the row it came from, field by field.
 *
 * Totals alone cannot see a swapped tenant, a changed method or a tampered
 * frozen value that happens to keep a period sum intact, so each record is
 * compared directly and the frozen conversion is checked on its own terms.
 */
function verifyMigratedRows_(sourceResolved, ledgerRows) {
  var failures = [];
  var byId = {};
  for (var i = 0; i < ledgerRows.length; i++) byId[String(ledgerRows[i].id)] = ledgerRows[i];

  var matched = {};
  for (var j = 0; j < sourceResolved.length; j++) {
    var source = sourceResolved[j].row;
    var period = sourceResolved[j].period;
    var id = String(source.id);
    var target = byId[id];

    if (!target) {
      failures.push("Yozuv ko'chirilmagan: " + id);
      continue;
    }
    matched[id] = true;

    var normalized = normalizeTransaction_({
      id: source.id, tenant: source.tenant, month: period, type: source.type,
      amount: source.amount, currency: source.currency, method: source.method,
      date: source.date, comment: source.comment, msgId: source.msgId,
      requestId: source.requestId,
      // Compared, so they have to be supplied. Normalizing without them
      // derived a fallback group id and an empty kind, which would have
      // agreed with a migration that dropped both.
      groupId: source.groupId, entryKind: source.entryKind
    });

    var fields = [
      ["Tenant", normalized.tenant, String(target.tenant || "")],
      ["Type", normalized.type, String(target.type || "")],
      ["Amount", String(normalized.amount), String(Number(target.amount) || 0)],
      ["Currency", normalized.currency, String(target.currency || "")],
      ["Method", normalized.method, String(target.method || "")],
      ["Period", period, String(target.period || "")],
      ["Request_ID", String(normalized.requestId || ""), String(target.requestId || "")],
      ["Telegram_Msg_ID", String(normalized.msgId || ""), String(target.msgId || "")],
      ["Status", TX_STATUS_ACTIVE, String(target.status || "")],
      ["Related_ID", "", String(target.relatedId || "")],
      // The three the old check did not look at. A migration that silently
      // dropped the group id or the entry kind passed every aggregate and
      // every field comparison above it.
      ["Entry_Group_ID", String(normalized.groupId || ""), String(target.groupId || "")],
      ["Entry_Kind", String(normalized.entryKind || ""), String(target.entryKind || "")],
      ["Comment", String(normalized.comment || ""), String(target.comment || "")]
    ];

    for (var k = 0; k < fields.length; k++) {
      if (fields[k][1] !== fields[k][2]) {
        failures.push(fields[k][0] + " mos emas (" + id + "): " +
                      fields[k][1] + " -> " + fields[k][2]);
      }
    }

    failures = failures.concat(frozenAmountFailures_(target));
  }

  for (var m = 0; m < ledgerRows.length; m++) {
    var extraId = String(ledgerRows[m].id);
    if (!matched[extraId]) failures.push("Manbada yo'q yozuv: " + extraId);
  }

  return failures.concat(verifyMigratedGroups_(sourceResolved, ledgerRows));
}

/**
 * The business meaning of the rows, not just their contents.
 *
 * Every field can match while the ledger still says something different from
 * the source: a group is a claim that several rows are one action, and a
 * tenant-paid pair is a claim that the pair nets to zero against our cash.
 * Neither survives being checked one row at a time, so both are checked here.
 */
function verifyMigratedGroups_(sourceResolved, ledgerRows) {
  var failures = [];

  var group = function (rows, idOf, groupOf) {
    var map = {};
    for (var i = 0; i < rows.length; i++) {
      var key = String(groupOf(rows[i]) || "");
      if (!map[key]) map[key] = [];
      map[key].push(String(idOf(rows[i])));
    }
    Object.keys(map).forEach(function (k) { map[k].sort(); });
    return map;
  };

  var sourceRows = sourceResolved.map(function (entry) {
    return normalizeTransaction_(Object.assign({}, entry.row, { month: entry.period }));
  });

  var sourceGroups = group(sourceRows,
    function (r) { return r.id; }, function (r) { return r.groupId; });
  var targetGroups = group(ledgerRows,
    function (r) { return r.id; }, function (r) { return r.groupId; });

  Object.keys(sourceGroups).forEach(function (key) {
    var before = sourceGroups[key];
    var after = targetGroups[key];
    if (!after) {
      failures.push("Guruh yo'qoldi (" + key + "): " + before.length + " ta yozuv");
      return;
    }
    if (before.join("|") !== after.join("|")) {
      failures.push("Guruh tarkibi o'zgardi (" + key + "): " +
                    before.length + " -> " + after.length + " ta yozuv");
    }
  });
  Object.keys(targetGroups).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(sourceGroups, key)) {
      failures.push("Manbada yo'q guruh: " + key);
    }
  });

  // A tenant-paid pair has to arrive as a tenant-paid pair. If the kind is
  // lost the two halves become unrelated rows that can be edited apart, and
  // the "our cash did not move" property stops being visible anywhere.
  var byGroup = {};
  for (var t = 0; t < ledgerRows.length; t++) {
    var g = String(ledgerRows[t].groupId || "");
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(ledgerRows[t]);
  }
  var sourceByGroup = {};
  for (var s = 0; s < sourceRows.length; s++) {
    var sg = String(sourceRows[s].groupId || "");
    if (!sourceByGroup[sg]) sourceByGroup[sg] = [];
    sourceByGroup[sg].push(sourceRows[s]);
  }

  Object.keys(sourceByGroup).forEach(function (key) {
    if (!isTenantPaidGroup_(sourceByGroup[key])) return;
    var after = byGroup[key] || [];
    if (!isTenantPaidGroup_(after)) {
      failures.push("Ijarachi to'lovi guruhi buzildi (" + key + ")");
      return;
    }
    var income = 0;
    var expense = 0;
    for (var r = 0; r < after.length; r++) {
      var value = Number(after[r].amountUZS);
      if (!isFinite(value)) value = 0;
      if (after[r].type === "Income") income += value; else expense += value;
    }
    if (Math.abs(income - expense) > 1) {
      failures.push("Ijarachi to'lovi kassaga ta'sir qilmasligi kerak (" + key + "): " +
                    income + " != " + expense);
    }
  });

  return failures;
}

function verifyOmadMigration_(doc) {
  var sourceRows = readRawTransactionRows_(doc.getSheetByName(OMAD_TRANSACTIONS_SHEET));
  var targetSheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);
  // The target carries the append-only schema, so it is read as a ledger and
  // then shaped like the source for a like-for-like comparison.
  // Read once: the row-by-row check below needs the same rows.
  var ledgerRows = readLedgerRows_(doc);
  var targetRows = ledgerRows.map(function (t) {
    return {
      id: t.id, tenant: t.tenant, month: t.period, type: t.type, amount: t.amount,
      currency: t.currency, method: t.method, date: t.createdAt, comment: t.comment,
      msgId: t.msgId, requestId: t.requestId, status: t.status
    };
  });
  var failures = [];

  if (!targetSheet) {
    return { ok: false, failures: ["Omad_Transactions_V2 varag'i topilmadi."] };
  }

  var configSheet = doc.getSheetByName("System_Config");
  var fallbackYear = getFallbackYear_(configSheet);

  if (targetRows.length !== sourceRows.length) {
    failures.push("Yozuvlar soni mos emas: " + sourceRows.length + " -> " + targetRows.length);
  }

  var seen = {};
  var duplicates = [];
  for (var i = 0; i < targetRows.length; i++) {
    var id = String(targetRows[i].id);
    if (seen[id]) duplicates.push(id); else seen[id] = true;
    if (!isCanonicalPeriod_(targetRows[i].month)) {
      failures.push("Kanonik bo'lmagan davr: " + targetRows[i].id + " -> " + targetRows[i].month);
    }
  }
  if (duplicates.length > 0) failures.push("Takrorlangan ID: " + duplicates.join(", "));

  // Per-period totals: the source resolves to the same periods the target
  // stores, so the two maps must be identical.
  var sourceResolved = [];
  for (var j = 0; j < sourceRows.length; j++) {
    var resolution = resolveTransactionPeriod_(sourceRows[j], fallbackYear);
    if (resolution.period) sourceResolved.push({ row: sourceRows[j], period: resolution.period });
  }
  var expectedTotals = totalsByPeriod_(sourceResolved);
  var actualTotals = totalsByPeriod_(targetRows.map(function (row) {
    return { row: row, period: String(row.month) };
  }));

  Object.keys(expectedTotals).forEach(function (period) {
    if (expectedTotals[period] !== actualTotals[period]) {
      failures.push("Davr yig'indisi mos emas (" + period + "): " +
                    expectedTotals[period] + " -> " + (actualTotals[period] || 0));
    }
  });
  Object.keys(actualTotals).forEach(function (period) {
    if (!Object.prototype.hasOwnProperty.call(expectedTotals, period)) {
      failures.push("Kutilmagan davr: " + period);
    }
  });

  // Row by row, including each frozen value against its own recorded rate.
  // Aggregates alone cannot see a tampered Amount_UZS that leaves a period
  // sum looking correct.
  failures = failures.concat(verifyMigratedRows_(sourceResolved, ledgerRows));

  var expectedBalances = balanceTotals_(sourceResolved.map(function (entry) {
    return Object.assign({}, entry.row, { period: entry.period });
  }));
  var actualBalances = balanceTotals_(targetRows);
  ["cash", "bank", "total", "income", "expense"].forEach(function (key) {
    if (expectedBalances[key] !== actualBalances[key]) {
      failures.push("Balans mos emas (" + key + "): " +
                    expectedBalances[key] + " -> " + actualBalances[key]);
    }
  });

  return {
    ok: failures.length === 0,
    failures: failures,
    sourceRows: sourceRows.length,
    targetRows: targetRows.length,
    expectedTotals: expectedTotals,
    actualTotals: actualTotals,
    expectedBalances: expectedBalances,
    actualBalances: actualBalances
  };
}

/** Points reads and writes at the verified V2 sheet. */
function cutoverOmadMigration_(doc) {
  var verification = verifyOmadMigration_(doc);
  if (!verification.ok) {
    return { status: "error", message: "Tekshiruv o'tmadi.", verification: verification };
  }

  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  backupOmadState_(doc, configSheet, "pre_period_cutover");
  setConfig(configSheet, OMAD_ACTIVE_TX_SHEET_KEY, OMAD_TRANSACTIONS_V2_SHEET);
  recordMigrationStatus_(configSheet, {
    state: "cutover",
    cutoverAt: new Date().toISOString(),
    activeSheet: OMAD_TRANSACTIONS_V2_SHEET,
    schemaVersion: MIGRATION_SCHEMA_VERSION
  });
  appendAuditRow_(doc, "omad_period_migration_cutover", OMAD_TRANSACTIONS_V2_SHEET);

  return { status: "success", verification: verification, activeSheet: OMAD_TRANSACTIONS_V2_SHEET };
}

/**
 * Points reads back at the original sheet. V2 is left in place on purpose:
 * deleting data is never part of a rollback.
 */
function rollbackOmadMigration_(doc) {
  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  setConfig(configSheet, OMAD_ACTIVE_TX_SHEET_KEY, OMAD_TRANSACTIONS_SHEET);

  var backedUpRates = getConfig(configSheet, "Omad_Rates_V1_Backup");
  if (backedUpRates) setConfig(configSheet, "Omad_Rates", backedUpRates);

  recordMigrationStatus_(configSheet, {
    state: "rolled_back",
    rolledBackAt: new Date().toISOString(),
    activeSheet: OMAD_TRANSACTIONS_SHEET,
    schemaVersion: 1
  });
  appendAuditRow_(doc, "omad_period_migration_rolled_back", OMAD_TRANSACTIONS_SHEET);

  return { status: "success", activeSheet: OMAD_TRANSACTIONS_SHEET };
}

function recordMigrationStatus_(configSheet, status) {
  var previous = safeParseJSON_(getConfig(configSheet, MIGRATION_STATUS_KEY), {});
  setConfig(configSheet, MIGRATION_STATUS_KEY, JSON.stringify(Object.assign({}, previous, status)));
}

function getMigrationStatus_(doc) {
  var configSheet = doc.getSheetByName("System_Config");
  var stored = configSheet ? safeParseJSON_(getConfig(configSheet, MIGRATION_STATUS_KEY), {}) : {};
  var v2 = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);

  return {
    state: stored.state || "not_started",
    schemaVersion: stored.schemaVersion || 1,
    fallbackYear: getFallbackYear_(configSheet),
    activeSheet: activeTransactionSheetName_(doc),
    versionedSheetExists: !!v2,
    versionedSheetRows: v2 ? Math.max(0, v2.getLastRow() - 1) : 0,
    sourceSheetRows: (function () {
      var source = doc.getSheetByName(OMAD_TRANSACTIONS_SHEET);
      return source ? Math.max(0, source.getLastRow() - 1) : 0;
    })(),
    appliedAt: stored.appliedAt || "",
    cutoverAt: stored.cutoverAt || "",
    rolledBackAt: stored.rolledBackAt || ""
  };
}

/**
 * A legacy row in the append-only schema. The rates in force for the resolved
 * period are frozen onto it, so post-migration rate edits cannot move it.
 */
function migratedRowToLedger_(row, period, migratedAt) {
  var normalized = normalizeTransaction_({
    id: row.id, tenant: row.tenant, month: period, type: row.type,
    amount: row.amount, currency: row.currency, method: row.method,
    date: row.date, comment: row.comment, msgId: row.msgId, requestId: row.requestId,
    // Carried across verbatim when the legacy row has one, and derived
    // deterministically when it does not, so a business action that spanned
    // several rows before the migration still spans them after it.
    groupId: row.groupId,
    // What kind of business action that was. Dropping this would turn every
    // tenant-paid pair into two unrelated rows: isTenantPaidGroup_ reads it,
    // so the pair would stop reporting as one entry and either half could be
    // edited on its own -- exactly the state the feature exists to prevent.
    entryKind: row.entryKind
  });
  var snapshot = buildRateSnapshot_(period, normalized.currency, "sell");

  return {
    id: normalized.id,
    requestId: normalized.requestId,
    // The original entry date is what matters; the migration timestamp is
    // recorded separately as the update.
    createdAt: legacyDateToIso_(row.date, period),
    updatedAt: migratedAt,
    createdBy: "migration",
    source: TX_SOURCE_MIGRATION,
    period: period,
    tenant: normalized.tenant,
    type: normalized.type,
    amount: normalized.amount,
    currency: normalized.currency,
    rateBuy: snapshot.rateBuy,
    rateSell: snapshot.rateSell,
    rateUsed: snapshot.rateUsed,
    rateType: snapshot.rateType,
    amountUZS: Math.round(normalized.currency === "USD"
      ? normalized.amount * snapshot.rateUsed : normalized.amount),
    method: normalized.method,
    comment: normalized.comment,
    status: TX_STATUS_ACTIVE,
    relatedId: "",
    msgId: normalized.msgId,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    groupId: normalized.groupId,
    entryKind: normalized.entryKind
  };
}

/** Best-effort ISO timestamp for a legacy row; falls back to the period start. */
function legacyDateToIso_(dateValue, period) {
  var parsed = parseTransactionDate_(dateValue);
  if (parsed) {
    var day = 1;
    var text = String(dateValue || "");
    var dmy = /^(\d{1,2})[\/.-]\d{1,2}[\/.-]\d{4}$/.exec(text);
    var iso = /^\d{4}-\d{2}-(\d{2})/.exec(text);
    if (dmy) day = Number(dmy[1]);
    else if (iso) day = Number(iso[1]);
    else if (typeof dateValue === "object" && dateValue.getDate) day = dateValue.getDate();
    return new Date(Date.UTC(parsed.year, parsed.month - 1, day)).toISOString();
  }
  return new Date(Date.UTC(periodYear_(period), periodMonth_(period) - 1, 1)).toISOString();
}

function clearSheetRows_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow > 0) sheet.deleteRows(1, lastRow);
}

// ----- apps-script/14_ledger.gs ------------------------------------------------

// ============================================================
// Append-only transaction ledger (schema V2)
// ------------------------------------------------------------
// Financial records are never rewritten in place and never deleted.
//
//   create  -> append one Active row
//   correct -> mark the original Corrected, append a new Active row that
//              points back at it
//   cancel  -> mark the row Cancelled; nothing is removed
//
// Every row carries the exchange rates that were in force when it was written,
// so changing a rate later cannot move a historical value.
// ============================================================

var LEDGER_SCHEMA_VERSION = 2;

var LEDGER_HEADER = [
  "ID",                 //  1 transaction id
  "Request_ID",         //  2 idempotency key
  "Created_At",         //  3 ISO timestamp
  "Updated_At",         //  4 ISO timestamp, set when the status changes
  "Created_By",         //  5 who or what wrote it
  "Source",             //  6 Web | Telegram | Migration
  "Period",             //  7 canonical YYYY-MM
  "Tenant",             //  8 tenant name, or the expense source
  "Type",               //  9 Income | Expense
  "Amount",             // 10 original amount
  "Currency",           // 11 UZS | USD
  "Rate_Buy",           // 12 buy rate available at write time
  "Rate_Sell",          // 13 sell rate available at write time
  "Rate_Used",          // 14 the rate actually applied
  "Rate_Type",          // 15 which of the two was applied
  "Amount_UZS",         // 16 converted value, frozen at write time
  "Method",             // 17 Naqd | Bank
  "Comment",            // 18 free text
  "Status",             // 19 Active | Corrected | Cancelled
  "Related_ID",         // 20 the transaction this one corrects
  "Telegram_Msg_ID",    // 21 group message id
  "Schema_Version",     // 22
  "Entry_Group_ID",     // 23 the business action this row belongs to
  "Entry_Kind"          // 24 what kind of business action that is
];

/** Column 23. Shared by every row of one business action. */
var LEDGER_GROUP_ID_COLUMN = 23;

/** Column 24. Mirrors the legacy sheet's Entry_Kind. */
var LEDGER_ENTRY_KIND_COLUMN = 24;

var TX_STATUS_ACTIVE = "Active";
var TX_STATUS_CORRECTED = "Corrected";
var TX_STATUS_CANCELLED = "Cancelled";
/**
 * A row that was written but never counted.
 *
 * A correction writes its replacement first and only then hides the original.
 * If hiding the original fails, the replacement is marked Void and the whole
 * correction is reported as failed — so the pair can never end up as two
 * Active rows, and the original can never end up hidden with nothing to
 * replace it. Void rows are excluded from every read, exactly like Cancelled
 * ones, and are ignored when a retry looks its request id up.
 */
var TX_STATUS_VOID = "Void";

var TX_SOURCE_WEB = "Web";
var TX_SOURCE_TELEGRAM = "Telegram";
var TX_SOURCE_MIGRATION = "Migration";

var TX_SOURCES = {};
TX_SOURCES[TX_SOURCE_WEB] = true;
TX_SOURCES[TX_SOURCE_TELEGRAM] = true;
TX_SOURCES[TX_SOURCE_MIGRATION] = true;

/** True once the migrated ledger is the sheet reads and writes go to. */
function isLedgerActive_(doc) {
  return activeTransactionSheetName_(doc) === OMAD_TRANSACTIONS_V2_SHEET;
}

function ledgerSheet_(doc) {
  var sheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET) ||
              doc.insertSheet(OMAD_TRANSACTIONS_V2_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(LEDGER_HEADER);
    return sheet;
  }
  // Upgrades a sheet written before Entry_Group_ID in place. Existing rows keep
  // their values and read back through the deterministic backfill until
  // backfill_entry_group_ids is run against them.
  var firstRow = sheet.getRange(1, 1, 1, LEDGER_HEADER.length).getValues()[0];
  if (firstRow[LEDGER_HEADER.length - 1] !== LEDGER_HEADER[LEDGER_HEADER.length - 1]) {
    sheet.getRange(1, 1, 1, LEDGER_HEADER.length).setValues([LEDGER_HEADER]);
  }
  return sheet;
}

/**
 * Keeps the spreadsheet from reinterpreting the ledger's text columns.
 *
 * Period holds "2026-08" and the two timestamps hold ISO strings. Without a
 * text format the sheet stores all three as dates - the same silent rewrite
 * that put a legacy entry in the wrong month.
 */
function applyLedgerColumnFormats_(sheet, startRow, numRows) {
  if (!sheet || numRows < 1 || typeof sheet.getRange !== "function") return;
  var periodRange = sheet.getRange(startRow, 7, numRows, 1);
  if (typeof periodRange.setNumberFormat !== "function") return;
  periodRange.setNumberFormat("@");
  sheet.getRange(startRow, 3, numRows, 2).setNumberFormat("@");
}

/** Appends one ledger row with its text columns protected first. */
function appendLedgerRow_(sheet, values) {
  appendLedgerRows_(sheet, [values]);
}

/**
 * Appends several ledger rows in a single write.
 *
 * One setValues call is one spreadsheet operation, so a business action made
 * of several rows either lands whole or not at all. This is what makes the
 * tenant-paid pair impossible to half-create.
 */
function appendLedgerRows_(sheet, rows) {
  if (!rows || rows.length === 0) return;
  var start = sheet.getLastRow() + 1;
  applyLedgerColumnFormats_(sheet, start, rows.length);
  sheet.getRange(start, 1, rows.length, LEDGER_HEADER.length).setValues(rows);
  // Every cached Omad summary was derived from the rows that were here a
  // moment ago. Bumping at the writer means a new read path cannot forget to.
  bumpDataRevision_(CACHE_SCOPE_OMAD);
}

function ledgerRowToTransaction_(row, rowNumber) {
  return {
    rowNumber: rowNumber,
    id: String(row[0]),
    requestId: String(row[1] || ""),
    createdAt: String(row[2] || ""),
    updatedAt: String(row[3] || ""),
    createdBy: String(row[4] || ""),
    source: String(row[5] || TX_SOURCE_WEB),
    // normalizeMonthValue_ recovers a period the sheet stored as a date
    // instead of stringifying it into "Sat Aug 01 2026 ...".
    period: normalizeMonthValue_(row[6]),
    tenant: String(row[7] || ""),
    type: row[8] === "Expense" ? "Expense" : "Income",
    amount: Number(row[9]) || 0,
    currency: row[10] === "USD" ? "USD" : "UZS",
    rateBuy: Number(row[11]) || 0,
    rateSell: Number(row[12]) || 0,
    rateUsed: Number(row[13]) || 0,
    rateType: String(row[14] || "sell"),
    amountUZS: Number(row[15]) || 0,
    method: row[16] === "Bank" ? "Bank" : "Naqd",
    comment: String(row[17] || ""),
    status: String(row[18] || TX_STATUS_ACTIVE),
    relatedId: String(row[19] || ""),
    msgId: String(row[20] || ""),
    schemaVersion: Number(row[21]) || LEDGER_SCHEMA_VERSION,
    // Rows written before the column existed fall back to the same
    // deterministic derivation the legacy sheet uses, so grouping is
    // consistent across both schemas and across the migration.
    groupId: String(row[22] || "").trim() || legacyEntryGroupId_(row[0]),
    entryKind: normalizeEntryKind_(row[23])
  };
}

function transactionToLedgerRow_(t) {
  return [
    t.id, t.requestId, t.createdAt, t.updatedAt, t.createdBy, t.source, t.period,
    t.tenant, t.type, t.amount, t.currency, t.rateBuy, t.rateSell, t.rateUsed,
    t.rateType, t.amountUZS, t.method, t.comment, t.status, t.relatedId,
    t.msgId, t.schemaVersion, t.groupId || "", t.entryKind || ""
  ];
}

/** Every row, in sheet order, including corrected and cancelled ones. */
function readLedgerRows_(doc) {
  var sheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === "" || data[i][0] === null || data[i][0] === undefined) continue;
    rows.push(ledgerRowToTransaction_(data[i], i + 1));
  }
  return rows;
}

function findLedgerRow_(doc, transactionId) {
  var rows = readLedgerRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === String(transactionId)) return rows[i];
  }
  return null;
}

/**
 * The record a request id produced, or null.
 *
 * Void rows are skipped: they are the discarded half of a correction that
 * failed, so treating one as "already done" would answer a retry with a record
 * that deliberately counts for nothing.
 */
function findLedgerRowByRequestId_(doc, requestId) {
  if (!requestId) return null;
  var rows = readLedgerRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].status === TX_STATUS_VOID) continue;
    if (rows[i].requestId && rows[i].requestId === String(requestId)) return rows[i];
  }
  return null;
}

/** Every row of one business action, whatever its status. */
function findLedgerRowsByGroupId_(doc, groupId) {
  var wanted = String(groupId || "").trim();
  if (!wanted) return [];
  var rows = readLedgerRows_(doc);
  var group = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].groupId === wanted) group.push(rows[i]);
  }
  return group;
}

/** Writes deterministic group ids onto ledger rows that predate the column. */
function backfillLedgerEntryGroupIds_(doc) {
  var sheet = doc.getSheetByName(OMAD_TRANSACTIONS_V2_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { status: "success", filled: 0, alreadySet: 0 };

  ledgerSheet_(doc);
  var data = sheet.getDataRange().getValues();
  var filled = 0;
  var alreadySet = 0;

  for (var i = 1; i < data.length; i++) {
    var id = data[i][0];
    if (id === "" || id === null || id === undefined) continue;
    if (String((data[i].length > 22 ? data[i][22] : "") || "").trim()) { alreadySet++; continue; }
    var derived = legacyEntryGroupId_(id);
    if (!derived) continue;
    sheet.getRange(i + 1, LEDGER_GROUP_ID_COLUMN).setValue(derived);
    filled++;
  }

  if (filled > 0) appendAuditRow_(doc, "entry_group_ids_backfilled", String(filled));
  return { status: "success", filled: filled, alreadySet: alreadySet };
}

/**
 * A transaction as the rest of the app expects to see it. `month` is kept
 * alongside `period` so existing readers keep working unchanged.
 */
function ledgerToLegacyShape_(t) {
  return {
    id: t.id,
    // Where the row physically lives. Carried so a caller that has already
    // read the ledger can write back to it -- stamping a report's message id
    // otherwise costs a second full pass over the sheet. It is a position, not
    // business data, and is only meaningful to the read it came from.
    rowNumber: t.rowNumber,
    groupId: t.groupId,
    entryKind: t.entryKind,
    tenant: t.tenant,
    month: t.period,
    period: t.period,
    periodLabel: formatPeriodLabel_(t.period),
    periodSource: "canonical",
    type: t.type,
    amount: t.amount,
    currency: t.currency,
    method: t.method,
    date: formatLedgerDate_(t.createdAt),
    comment: t.comment,
    msgId: t.msgId,
    requestId: t.requestId,
    status: t.status,
    relatedId: t.relatedId,
    source: t.source,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    createdBy: t.createdBy,
    rateBuy: t.rateBuy,
    rateSell: t.rateSell,
    rateUsed: t.rateUsed,
    rateType: t.rateType,
    amountUZS: t.amountUZS,
    schemaVersion: t.schemaVersion
  };
}

function formatLedgerDate_(isoTimestamp) {
  try {
    var parsed = new Date(String(isoTimestamp || ""));
    if (isNaN(parsed.getTime())) return "";
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), "dd/MM/yyyy");
  } catch (error) {
    return "";
  }
}

// ------------------------------------------------------------------ validation

function validateTransactionInput_(input) {
  var payload = input || {};

  if (!isCanonicalPeriod_(payload.period)) return "Davr noto'g'ri (masalan 2026-01).";
  if (!String(payload.tenant || "").trim()) return "Obyekt tanlanmagan.";
  if (String(payload.tenant).length > 200) return "Obyekt nomi juda uzun.";

  var amount = Number(payload.amount);
  if (!isFinite(amount) || amount <= 0) return "Summa musbat raqam bo'lishi kerak.";
  if (amount > 1e15) return "Summa juda katta.";

  if (payload.currency !== "UZS" && payload.currency !== "USD") return "Valyuta noto'g'ri.";
  if (payload.method !== "Naqd" && payload.method !== "Bank") return "To'lov usuli noto'g'ri.";
  if (payload.type !== "Income" && payload.type !== "Expense") return "Operatsiya turi noto'g'ri.";
  if (String(payload.comment || "").length > 2000) return "Izoh juda uzun.";
  if (payload.source && !TX_SOURCES[payload.source]) return "Manba noto'g'ri.";

  return "";
}

/**
 * Freezes the rates in force right now onto the transaction. USD amounts are
 * converted at the sell rate; UZS amounts convert one-to-one and record the
 * rates anyway, so the history is complete.
 */
function buildRateSnapshot_(period, currency, rateType) {
  var rates = getOmadRates_();
  var entry = getPeriodRate_(rates, period);
  var appliedType = rateType === "buy" ? "buy" : "sell";
  var used = currency === "USD" ? (appliedType === "buy" ? entry.buy : entry.sell) : 1;

  return {
    rateBuy: entry.buy,
    rateSell: entry.sell,
    rateUsed: used,
    rateType: currency === "USD" ? appliedType : "none"
  };
}

// -------------------------------------------------------------------- create

/**
 * Appends one Active transaction. Idempotent on `requestId`: the same request
 * always resolves to the same record, so a retry, a refresh or a double-click
 * cannot create a second copy.
 */
function createTransaction_(doc, input) {
  var validationError = validateTransactionInput_(input);
  if (validationError) return { status: "error", message: validationError };

  var requestId = String(input.requestId || "").trim();
  if (!requestId) return { status: "error", message: "requestId talab qilinadi." };
  if (requestId.length > 128) return { status: "error", message: "requestId juda uzun." };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var existing = findLedgerRowByRequestId_(doc, requestId);
    if (existing) {
      // Not an error: the caller gets exactly the record their request created.
      return { status: "success", duplicate: true, transaction: ledgerToLegacyShape_(existing) };
    }

    var now = new Date().toISOString();
    var snapshot = buildRateSnapshot_(input.period, input.currency, input.rateType);
    var amount = Number(input.amount);

    var transaction = {
      id: input.id ? String(input.id) : nextTransactionId_(doc),
      requestId: requestId,
      createdAt: now,
      updatedAt: "",
      createdBy: String(input.createdBy || "").slice(0, 120),
      source: TX_SOURCES[input.source] ? input.source : TX_SOURCE_WEB,
      period: String(input.period),
      tenant: String(input.tenant).trim(),
      type: input.type,
      amount: amount,
      currency: input.currency,
      rateBuy: snapshot.rateBuy,
      rateSell: snapshot.rateSell,
      rateUsed: snapshot.rateUsed,
      rateType: snapshot.rateType,
      amountUZS: Math.round(input.currency === "USD" ? amount * snapshot.rateUsed : amount),
      method: input.method,
      comment: String(input.comment || "").slice(0, 2000),
      status: TX_STATUS_ACTIVE,
      relatedId: "",
      msgId: String(input.msgId || ""),
      schemaVersion: LEDGER_SCHEMA_VERSION,
      // Supplied when this row is one line of a larger business action; its own
      // group when it stands alone. Never derived from the id.
      groupId: String(input.groupId || "").trim() || newEntryGroupId_(),
      entryKind: normalizeEntryKind_(input.entryKind)
    };

    appendLedgerRow_(ledgerSheet_(doc), transactionToLedgerRow_(transaction));
    appendAuditRow_(doc, "transaction_created", JSON.stringify({
      id: transaction.id, period: transaction.period, source: transaction.source,
      amount: transaction.amount, currency: transaction.currency
    }));

    return { status: "success", duplicate: false, transaction: ledgerToLegacyShape_(transaction) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Ids are "<epochMillis>_<n>". The suffix disambiguates two transactions
 * created inside the same millisecond, which the entry form does routinely.
 */
function nextTransactionId_(doc) {
  var stamp = String(new Date().getTime());
  var rows = readLedgerRows_(doc);
  var used = {};
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id.indexOf(stamp + "_") === 0) used[rows[i].id] = true;
  }
  var index = 0;
  while (used[stamp + "_" + index]) index++;
  return stamp + "_" + index;
}

// ------------------------------------------------------------------- correct

/**
 * Replaces a transaction: the replacement is written first, then the original
 * is hidden. The original row is never edited beyond its status and timestamp,
 * so the audit trail keeps the value that was actually recorded at the time.
 *
 * The order is the whole point. Hiding the original first — which is what this
 * used to do — meant a failure between the two writes left the original marked
 * Corrected with no replacement in the sheet: money that silently left the
 * books, in the one operation the append-only design exists to make safe.
 *
 * Writing the replacement first cannot lose money. It can, for exactly as long
 * as the second write takes, double-count it, so the failure path marks the
 * replacement Void and reports the correction as failed. The three outcomes are
 * therefore: both writes land, or neither counts, or — only if the rollback
 * *also* fails, against a spreadsheet that has already failed twice — two
 * Active rows and a loud audit entry naming both ids. Never a hidden original.
 *
 * All of it runs under the script lock, so no other write interleaves.
 */
function correctTransaction_(doc, input) {
  var requestId = String((input && input.requestId) || "").trim();
  if (!requestId) return { status: "error", message: "requestId talab qilinadi." };

  var validationError = validateTransactionInput_(input);
  if (validationError) return { status: "error", message: validationError };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var alreadyDone = findLedgerRowByRequestId_(doc, requestId);
    if (alreadyDone) {
      return { status: "success", duplicate: true, transaction: ledgerToLegacyShape_(alreadyDone) };
    }

    var original = findLedgerRow_(doc, input.transactionId);
    if (!original) return { status: "error", message: "Tranzaksiya topilmadi." };
    if (original.status !== TX_STATUS_ACTIVE) {
      return {
        status: "error",
        message: "Bu tranzaksiya allaqachon " +
                 (original.status === TX_STATUS_CANCELLED ? "bekor qilingan" : "tuzatilgan") + "."
      };
    }

    var now = new Date().toISOString();
    var snapshot = buildRateSnapshot_(input.period, input.currency, input.rateType);
    var amount = Number(input.amount);

    var replacement = {
      id: nextTransactionId_(doc),
      requestId: requestId,
      createdAt: now,
      updatedAt: "",
      createdBy: String(input.createdBy || "").slice(0, 120),
      source: TX_SOURCES[input.source] ? input.source : TX_SOURCE_WEB,
      period: String(input.period),
      tenant: String(input.tenant).trim(),
      type: input.type,
      amount: amount,
      currency: input.currency,
      rateBuy: snapshot.rateBuy,
      rateSell: snapshot.rateSell,
      rateUsed: snapshot.rateUsed,
      rateType: snapshot.rateType,
      amountUZS: Math.round(input.currency === "USD" ? amount * snapshot.rateUsed : amount),
      method: input.method,
      comment: String(input.comment || "").slice(0, 2000),
      status: TX_STATUS_ACTIVE,
      relatedId: original.id,
      // The replacement inherits the group message so the report is edited
      // rather than duplicated.
      msgId: original.msgId,
      schemaVersion: LEDGER_SCHEMA_VERSION,
      // A correction stays inside the business action it corrects, and cannot
      // change what kind of action that is.
      groupId: original.groupId,
      entryKind: original.entryKind
    };

    var sheet = ledgerSheet_(doc);
    appendLedgerRow_(sheet, transactionToLedgerRow_(replacement));

    var replacementRow = sheet.getLastRow();
    try {
      setLedgerStatus_(sheet, original.rowNumber, TX_STATUS_CORRECTED, now);
    } catch (statusError) {
      voidFailedReplacement_(doc, sheet, replacementRow, replacement, original, statusError);
      return {
        status: "error",
        message: "Tuzatishni saqlab bo'lmadi, asl yozuv o'zgarmadi. Qaytadan urinib ko'ring."
      };
    }

    appendAuditRow_(doc, "transaction_corrected", JSON.stringify({
      original: original.id, replacement: replacement.id,
      before: { amount: original.amount, currency: original.currency, period: original.period },
      after: { amount: replacement.amount, currency: replacement.currency, period: replacement.period }
    }));

    return {
      status: "success",
      duplicate: false,
      transaction: ledgerToLegacyShape_(replacement),
      corrected: original.id
    };
  } finally {
    lock.releaseLock();
  }
}

// -------------------------------------------------------------------- cancel

/** Marks a transaction Cancelled. Financial records are never deleted. */
function cancelTransaction_(doc, input) {
  var requestId = String((input && input.requestId) || "").trim();
  if (!requestId) return { status: "error", message: "requestId talab qilinadi." };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var original = findLedgerRow_(doc, input.transactionId);
    if (!original) return { status: "error", message: "Tranzaksiya topilmadi." };

    if (original.status === TX_STATUS_CANCELLED) {
      // Cancelling twice is the same outcome as cancelling once.
      return { status: "success", duplicate: true, transaction: ledgerToLegacyShape_(original) };
    }
    if (original.status === TX_STATUS_CORRECTED) {
      return { status: "error", message: "Tuzatilgan yozuvni bekor qilib bo'lmaydi. Yangi yozuvni bekor qiling." };
    }
    if (original.status === TX_STATUS_VOID) {
      // Already counts for nothing; there is nothing to cancel.
      return { status: "success", duplicate: true, transaction: ledgerToLegacyShape_(original) };
    }

    var now = new Date().toISOString();
    setLedgerStatus_(ledgerSheet_(doc), original.rowNumber, TX_STATUS_CANCELLED, now);

    appendAuditRow_(doc, "transaction_cancelled", JSON.stringify({
      id: original.id, reason: String((input && input.reason) || "").slice(0, 500),
      amount: original.amount, currency: original.currency, period: original.period
    }));

    var cancelled = Object.assign({}, original, { status: TX_STATUS_CANCELLED, updatedAt: now });
    return { status: "success", duplicate: false, transaction: ledgerToLegacyShape_(cancelled) };
  } finally {
    lock.releaseLock();
  }
}

function setLedgerStatus_(sheet, rowNumber, status, timestamp) {
  sheet.getRange(rowNumber, 19).setValue(status);
  sheet.getRange(rowNumber, 4).setValue(timestamp);
  // A cancellation or a correction changes every figure derived from this row.
  bumpDataRevision_(CACHE_SCOPE_OMAD);
}

/**
 * Discards a replacement whose correction could not be completed.
 *
 * The original is untouched and still Active, so the books are already correct;
 * this only stops the replacement being counted a second time. If even this
 * write fails the spreadsheet is failing repeatedly, and the one useful thing
 * left is to say so loudly and name both rows — silence here would leave a
 * double count nobody knows to look for.
 */
function voidFailedReplacement_(doc, sheet, rowNumber, replacement, original, cause) {
  try {
    setLedgerStatus_(sheet, rowNumber, TX_STATUS_VOID, new Date().toISOString());
    appendAuditRow_(doc, "transaction_correction_failed", JSON.stringify({
      original: original.id,
      voidedReplacement: replacement.id,
      reason: redactSecrets_(cause).slice(0, 300)
    }));
  } catch (rollbackError) {
    appendAuditRow_(doc, "transaction_correction_rollback_failed", JSON.stringify({
      original: original.id,
      orphanReplacement: replacement.id,
      reason: redactSecrets_(cause).slice(0, 200),
      rollbackReason: redactSecrets_(rollbackError).slice(0, 200)
    }));
  }
}

// ---------------------------------------------------------------------- read

/** Active transactions only - what the dashboard, reports and balances use. */
function listActiveTransactions_(doc, filters) {
  var options = filters || {};
  var rows = readLedgerRows_(doc);
  var result = [];

  for (var i = 0; i < rows.length; i++) {
    if (rows[i].status !== TX_STATUS_ACTIVE) continue;
    if (options.period && rows[i].period !== options.period) continue;
    if (options.tenant && rows[i].tenant !== options.tenant) continue;
    if (options.type && rows[i].type !== options.type) continue;
    result.push(ledgerToLegacyShape_(rows[i]));
  }
  return result;
}

function getTransaction_(doc, transactionId) {
  var found = findLedgerRow_(doc, transactionId);
  return found ? ledgerToLegacyShape_(found) : null;
}

/**
 * The full chain for one transaction: the record itself, whatever it corrected,
 * and whatever corrected it - newest last.
 */
function getTransactionHistory_(doc, transactionId) {
  var rows = readLedgerRows_(doc);
  var byId = {};
  for (var i = 0; i < rows.length; i++) byId[rows[i].id] = rows[i];

  var target = byId[String(transactionId)];
  if (!target) return null;

  // Walk back to the first record in the chain.
  var root = target;
  var guard = 0;
  while (root.relatedId && byId[root.relatedId] && guard++ < 1000) root = byId[root.relatedId];

  // Then forward, collecting every link.
  var chain = [root];
  var current = root;
  guard = 0;
  while (guard++ < 1000) {
    var next = null;
    for (var j = 0; j < rows.length; j++) {
      if (rows[j].relatedId === current.id) { next = rows[j]; break; }
    }
    if (!next) break;
    chain.push(next);
    current = next;
  }

  return {
    transactionId: String(transactionId),
    chain: chain.map(ledgerToLegacyShape_),
    current: ledgerToLegacyShape_(chain[chain.length - 1])
  };
}

// ----- apps-script/15_system_status.gs -----------------------------------------

// ============================================================
// System and data status
// ------------------------------------------------------------
// Everything the "Tizim va Ma'lumotlar" settings section shows: backups,
// migration state, the retry queue, recent audit history, schema version and
// the last successful server operation.
//
// Diagnostics here are deliberately *safe*: counts, timestamps and event names
// only. No secrets, no transaction amounts, no message contents.
// ============================================================

var SYSTEM_LAST_OPERATION_KEY = "Omad_Last_Operation";
var AUDIT_TAIL_SIZE = 20;

/** Records that a server operation completed. Never throws. */
function recordLastOperation_(doc, operation) {
  try {
    var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
    setConfig(configSheet, SYSTEM_LAST_OPERATION_KEY, JSON.stringify({
      operation: String(operation || ""),
      at: new Date().toISOString()
    }));
  } catch (error) {}
}

function sheetRowCount_(doc, name) {
  var sheet = doc.getSheetByName(name);
  return sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
}

/** The most recent Omad_Backups row, without its snapshot payload. */
function latestBackupInfo_(doc) {
  var sheet = doc.getSheetByName("Omad_Backups");
  if (!sheet || sheet.getLastRow() < 2) return { count: 0, lastAt: "", lastReason: "" };

  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(lastRow, 1, 1, 3).getValues()[0];
  var snapshot = safeParseJSON_(values[2], null);

  return {
    count: lastRow - 1,
    lastAt: String(values[0] || ""),
    lastReason: String(values[1] || ""),
    // Size only - the snapshot itself is never returned to the browser.
    lastTransactionCount: snapshot && Array.isArray(snapshot.transactions)
      ? snapshot.transactions.length : 0
  };
}

/** The tail of the audit log: timestamps and event names, details truncated. */
function recentAuditEntries_(doc, limit) {
  var sheet = doc.getSheetByName("Omad_Audit_Log");
  if (!sheet || sheet.getLastRow() < 2) return [];

  var size = Math.min(limit || AUDIT_TAIL_SIZE, sheet.getLastRow() - 1);
  var start = sheet.getLastRow() - size + 1;
  var values = sheet.getRange(start, 1, size, 3).getValues();

  var entries = [];
  for (var i = values.length - 1; i >= 0; i--) {
    entries.push({
      at: String(values[i][0] || ""),
      event: String(values[i][1] || ""),
      details: redactSecrets_(values[i][2]).slice(0, 300)
    });
  }
  return entries;
}

function buildSystemStatus_(doc) {
  var configSheet = doc.getSheetByName("System_Config");
  var lastOperation = configSheet
    ? safeParseJSON_(getConfig(configSheet, SYSTEM_LAST_OPERATION_KEY), null)
    : null;

  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    activeSheet: activeTransactionSheetName_(doc),
    ledgerActive: isLedgerActive_(doc),
    backup: latestBackupInfo_(doc),
    migration: getMigrationStatus_(doc),
    queue: buildJobQueueStatus_(doc),
    audit: recentAuditEntries_(doc, AUDIT_TAIL_SIZE),
    lastOperation: lastOperation,
    counts: {
      legacyTransactions: sheetRowCount_(doc, OMAD_TRANSACTIONS_SHEET),
      ledgerTransactions: sheetRowCount_(doc, OMAD_TRANSACTIONS_V2_SHEET),
      archive: sheetRowCount_(doc, "Omad_Transaction_Archive"),
      auditLog: sheetRowCount_(doc, "Omad_Audit_Log"),
      backups: sheetRowCount_(doc, "Omad_Backups"),
      jobs: sheetRowCount_(doc, JOB_QUEUE_SHEET)
    }
  };
}

/** Writes a snapshot on demand and reports the result. */
function createManualBackup_(doc) {
  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  backupOmadState_(doc, configSheet, "manual");
  appendAuditRow_(doc, "manual_backup_created", "");
  recordLastOperation_(doc, "create_backup");
  return { status: "success", backup: latestBackupInfo_(doc) };
}

/**
 * Puts failed jobs back in the queue for one more round of attempts.
 * Used by the "retry" control in System and Data.
 */
function retryFailedJobs_(doc) {
  var read = readJobRows_(doc);
  if (!read.sheet) return { status: "success", retried: 0 };

  var retried = 0;
  for (var i = 0; i < read.rows.length; i++) {
    if (read.rows[i].status !== JOB_STATUS_FAILED) continue;
    writeJobField_(read.sheet, read.rows[i].rowNumber, 5, JOB_STATUS_PENDING);
    writeJobField_(read.sheet, read.rows[i].rowNumber, 6, 0);
    writeJobField_(read.sheet, read.rows[i].rowNumber, 7, new Date().toISOString());
    writeJobField_(read.sheet, read.rows[i].rowNumber, 10, "");
    retried++;
  }

  if (retried > 0) {
    appendAuditRow_(doc, "failed_jobs_retried", String(retried));
    recordLastOperation_(doc, "retry_failed_jobs");
  }
  return { status: "success", retried: retried, queue: buildJobQueueStatus_(doc) };
}

// ----- apps-script/15a_maintenance.gs ------------------------------------------

// ============================================================
// Maintenance
// ------------------------------------------------------------
// One-off, operator-triggered repairs to live data and live configuration.
//
// Everything here is admin-key protected, backs up before it writes, is safe
// to run twice, and reports counts rather than contents. Nothing in this file
// runs on its own.
// ============================================================

// -------------------------------------------------------------- date repair
//
// Older rows show day and month transposed: the app wrote "05/08/2026" as text
// and the spreadsheet read it back through a MM/DD locale, so 5 August became
// 8 May. Writes have since been fixed (08_omad_transactions.gs writes real
// date values), and the Month/period column — not this one — is what every
// figure is calculated from, so the damage is cosmetic.
//
// It is still repairable *provably*, without guessing, because the transaction
// id is "<epochMillis>_<n>" and the app has only ever written today's date. The
// id therefore records the instant the row was created, and the correct date is
// that instant in the script's timezone. A row is corrected only when swapping
// the stored day and month reproduces the id's date exactly. Anything else —
// a row whose date disagrees for some other reason, or whose id carries no
// usable timestamp — is reported and left alone.

/** The Tashkent calendar date an id's epoch prefix refers to, or null. */
function transactionIdDateParts_(transactionId) {
  var base = String(transactionId === null || transactionId === undefined ? "" : transactionId).split("_")[0];
  if (!/^\d{12,16}$/.test(base)) return null;
  var millis = Number(base);
  if (!isFinite(millis) || millis <= 0) return null;

  var stamp = Utilities.formatDate(new Date(millis), Session.getScriptTimeZone(), "dd/MM/yyyy");
  var parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(stamp);
  if (!parts) return null;
  return { day: Number(parts[1]), month: Number(parts[2]), year: Number(parts[3]) };
}

/** The calendar date a stored Date cell holds, or null. */
function storedDateParts_(value) {
  if (value && typeof value === "object" && typeof value.getFullYear === "function") {
    if (isNaN(value.getTime())) return null;
    return { day: value.getDate(), month: value.getMonth() + 1, year: value.getFullYear() };
  }
  var parsed = parseTransactionDate_(value);
  if (!parsed) return null;
  var text = String(value || "");
  var dmy = /^(\d{1,2})[\/.-]\d{1,2}[\/.-]\d{4}$/.exec(text);
  return {
    day: dmy ? Number(dmy[1]) : (parsed.day || 1),
    month: parsed.month,
    year: parsed.year
  };
}

function sameDateParts_(a, b) {
  return !!a && !!b && a.day === b.day && a.month === b.month && a.year === b.year;
}

/** True when a and b are the same date with day and month swapped. */
function transposedDateParts_(stored, fromId) {
  if (!stored || !fromId) return false;
  if (sameDateParts_(stored, fromId)) return false;
  return stored.year === fromId.year && stored.day === fromId.month && stored.month === fromId.day;
}

function formatDateParts_(parts) {
  if (!parts) return "";
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  return pad(parts.day) + "/" + pad(parts.month) + "/" + parts.year;
}

var DATE_AUDIT_SAMPLE_SIZE = 25;

/**
 * Classifies every row's Date cell against the date its id proves.
 *
 * Writes nothing. The samples are capped so the response stays small; the
 * counts always cover every row.
 */
function auditTransactionDates_(doc) {
  var sheetName = activeTransactionSheetName_(doc);
  var sheet = doc.getSheetByName(sheetName);
  var result = {
    sheet: sheetName,
    total: 0,
    correct: 0,
    transposed: 0,
    unprovable: 0,
    noIdTimestamp: 0,
    transposedSample: [],
    unprovableSample: []
  };
  if (!sheet || sheet.getLastRow() < 2) return result;
  // The ledger stores an ISO Created_At rather than a display date, so it has
  // nothing to transpose.
  if (sheetName === OMAD_TRANSACTIONS_V2_SHEET) return result;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var id = data[i][0];
    if (id === "" || id === null || id === undefined) continue;
    result.total++;

    var fromId = transactionIdDateParts_(id);
    if (!fromId) { result.noIdTimestamp++; continue; }

    var stored = storedDateParts_(data[i][7]);
    if (sameDateParts_(stored, fromId)) { result.correct++; continue; }

    if (transposedDateParts_(stored, fromId)) {
      result.transposed++;
      if (result.transposedSample.length < DATE_AUDIT_SAMPLE_SIZE) {
        result.transposedSample.push({
          rowNumber: i + 1, id: String(id),
          stored: formatDateParts_(stored), correct: formatDateParts_(fromId)
        });
      }
      continue;
    }

    result.unprovable++;
    if (result.unprovableSample.length < DATE_AUDIT_SAMPLE_SIZE) {
      result.unprovableSample.push({
        rowNumber: i + 1, id: String(id),
        stored: formatDateParts_(stored), fromId: formatDateParts_(fromId)
      });
    }
  }
  return result;
}

/**
 * Rewrites the Date cell of every provably transposed row, and nothing else.
 *
 * Backs the whole Omad state up first. Idempotent: a row corrected by an
 * earlier run matches its id's date and is skipped. `dryRun` reports what
 * would change without touching the sheet.
 */
function fixTransposedTransactionDates_(doc, options) {
  var settings = options || {};
  var audit = auditTransactionDates_(doc);
  if (settings.dryRun === true) {
    return { status: "success", dryRun: true, audit: audit, fixed: 0 };
  }
  if (audit.transposed === 0) {
    return { status: "success", dryRun: false, audit: audit, fixed: 0 };
  }

  var sheetName = audit.sheet;
  var sheet = doc.getSheetByName(sheetName);
  if (!sheet) return { status: "error", message: "Tranzaksiya varag'i topilmadi." };

  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");
  backupOmadState_(doc, configSheet, "fix_transaction_dates");

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var fixed = 0;
  try {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var id = data[i][0];
      if (id === "" || id === null || id === undefined) continue;
      var fromId = transactionIdDateParts_(id);
      if (!fromId) continue;
      if (!transposedDateParts_(storedDateParts_(data[i][7]), fromId)) continue;

      // A real date value, not text: text is what the locale re-read in the
      // first place. The column format is reapplied so it displays day-first.
      applyTransactionColumnFormats_(sheet, i + 1, 1, sheetName);
      sheet.getRange(i + 1, 8).setValue(new Date(fromId.year, fromId.month - 1, fromId.day));
      fixed++;
    }
  } finally {
    lock.releaseLock();
  }

  appendAuditRow_(doc, "transaction_dates_corrected", JSON.stringify({
    fixed: fixed, unprovableLeftAlone: audit.unprovable
  }));
  recordLastOperation_(doc, "fix_transaction_dates");

  return { status: "success", dryRun: false, fixed: fixed, audit: auditTransactionDates_(doc) };
}

// ------------------------------------------------- historical secret cleanup
//
// Request bodies are no longer logged, so a secret cannot reach
// Telegram_Debug_Log any more. Rows written *before* that change can still
// contain the webhook verification secret, because setWebhook carries it twice.
// This re-redacts them in place, after copying the sheet.

var DEBUG_LOG_SHEET = "Telegram_Debug_Log";

/**
 * Anything left that is shaped like a high-entropy credential.
 *
 * The webhook secret is two UUIDs with the dashes removed — 64 hex characters
 * — so a bare occurrence that no `wh=` or `secret_token=` context caught is
 * still removed. Deliberately blunt: this runs over a debug log, where losing
 * a long hex identifier costs nothing and keeping a secret costs everything.
 */
function redactHighEntropyValues_(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "[REDACTED]");
}

/** Full redaction for a stored log row: the live rules plus the blunt one. */
function redactStoredLogValue_(value) {
  return redactHighEntropyValues_(redactSecrets_(value));
}

/** True for a sheet this cleanup created on some earlier run. */
function isDebugLogBackupSheetName_(name) {
  return String(name || "").indexOf(DEBUG_LOG_SHEET + "_Backup_") === 0;
}

/**
 * Redacts one sheet's Details column in place. Returns how many rows changed.
 *
 * Reads and writes the whole column in two operations rather than one call per
 * row: the live log is thousands of rows, and a per-row setValue is both slow
 * enough to time out and non-atomic enough to leave a half-cleaned sheet
 * behind if it does.
 */
function redactDebugSheetInPlace_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return { rows: 0, redacted: 0 };

  var rowCount = sheet.getLastRow() - 1;
  var range = sheet.getRange(2, 3, rowCount, 1);
  var details = range.getValues();
  var redacted = 0;

  for (var i = 0; i < details.length; i++) {
    var before = String(details[i][0] === null || details[i][0] === undefined ? "" : details[i][0]);
    var after = redactStoredLogValue_(before);
    if (after === before) continue;
    details[i][0] = after;
    redacted++;
  }

  if (redacted > 0) range.setValues(details);
  return { rows: rowCount, redacted: redacted };
}

/**
 * Removes historical credentials from Telegram_Debug_Log and from every backup
 * an earlier run of this cleanup left behind.
 *
 * The order matters, and getting it wrong is why this was rewritten: copying
 * the sheet first and redacting the original afterwards moves the leaked
 * secret into a second tab rather than removing it. Nothing is copied until it
 * has been through the redactor, so the backup is born clean and the raw value
 * exists in exactly one place — the live sheet — right up to the moment it is
 * overwritten.
 *
 * Backups from before this change are swept too, in place. A secret already
 * duplicated into one of them is the same leak; leaving it there because this
 * run did not create it would be pointless.
 *
 * Safe to run twice: a row already redacted comes back identical, is left
 * alone, and produces no further backup. Reports counts only, never contents.
 */
function purgeTelegramDebugSecrets_(doc) {
  var priorBackups = sweepDebugLogBackups_(doc);
  var sheet = doc.getSheetByName(DEBUG_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) {
    return {
      status: "success", rows: 0, redacted: 0, backupSheet: "",
      backupsSwept: priorBackups.sheets, backupRowsRedacted: priorBackups.redacted
    };
  }

  var rowCount = sheet.getLastRow() - 1;
  var values = sheet.getRange(2, 1, rowCount, 3).getValues();

  // Redact first, in memory. `values` holds no secret from here on, so it is
  // safe to write anywhere.
  var redacted = 0;
  for (var i = 0; i < values.length; i++) {
    var before = String(values[i][2] === null || values[i][2] === undefined ? "" : values[i][2]);
    var after = redactStoredLogValue_(before);
    if (after === before) continue;
    values[i][2] = after;
    redacted++;
  }

  // A run that found nothing to redact has nothing worth backing up either,
  // and a backup per no-op run is just more sheets to audit later.
  var backupName = "";
  if (redacted > 0) {
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");
    backupName = (DEBUG_LOG_SHEET + "_Backup_" + stamp).slice(0, 95);
    var backup = doc.getSheetByName(backupName) || doc.insertSheet(backupName);
    if (backup.getLastRow() === 0) backup.appendRow(["Timestamp", "Event", "Details"]);
    backup.getRange(backup.getLastRow() + 1, 1, values.length, 3).setValues(values);

    sheet.getRange(2, 1, rowCount, 3).setValues(values);
  }

  appendAuditRow_(doc, "telegram_debug_log_redacted", JSON.stringify({
    rows: rowCount, redacted: redacted, backupSheet: backupName,
    backupsSwept: priorBackups.sheets, backupRowsRedacted: priorBackups.redacted
  }));
  recordLastOperation_(doc, "purge_telegram_debug_secrets");

  return {
    status: "success", rows: rowCount, redacted: redacted, backupSheet: backupName,
    backupsSwept: priorBackups.sheets, backupRowsRedacted: priorBackups.redacted
  };
}

/** Redacts every backup sheet an earlier cleanup created. */
function sweepDebugLogBackups_(doc) {
  var sheets = doc.getSheets();
  var swept = [];
  var redacted = 0;

  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    if (!isDebugLogBackupSheetName_(name)) continue;
    var result = redactDebugSheetInPlace_(sheets[i]);
    swept.push(name);
    redacted += result.redacted;
  }

  return { sheets: swept, redacted: redacted };
}

/**
 * What a reader of the sheet could still find, as counts and sheet names.
 *
 * Deliberately reports only how many rows still look like they carry a
 * credential — printing the offending row would defeat the point of the
 * cleanup that produced this number.
 */
function auditTelegramSecretExposure_(doc) {
  var sheets = doc.getSheets();
  var findings = [];
  var total = 0;

  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    if (name !== DEBUG_LOG_SHEET && !isDebugLogBackupSheetName_(name)) continue;
    if (sheets[i].getLastRow() < 2) continue;

    var details = sheets[i].getRange(2, 3, sheets[i].getLastRow() - 1, 1).getValues();
    var dirty = 0;
    for (var r = 0; r < details.length; r++) {
      var before = String(details[r][0] === null || details[r][0] === undefined ? "" : details[r][0]);
      if (redactStoredLogValue_(before) !== before) dirty++;
    }
    if (dirty > 0) findings.push({ sheet: name, rows: dirty });
    total += dirty;
  }

  return { status: "success", clean: total === 0, exposedRows: total, sheets: findings };
}

// ------------------------------------------------------ webhook secret rotation

var TELEGRAM_PROP_WEBHOOK_SECRET_PREVIOUS = "TELEGRAM_WEBHOOK_SECRET_PREVIOUS";
var TELEGRAM_PROP_WEBHOOK_ROTATED_AT = "TELEGRAM_WEBHOOK_ROTATED_AT";

function generateWebhookSecret_() {
  return Utilities.getUuid().split("-").join("") + Utilities.getUuid().split("-").join("");
}

/**
 * Replaces the webhook verification secret and re-points Telegram at it.
 *
 * The previous secret stays accepted for the length of the rotation, which is
 * what removes the race: between storing the new value and Telegram learning
 * it, an update signed with either one verifies, so no update is ever dropped.
 * It is cleared the moment Telegram confirms the new URL.
 *
 * If setWebhook or the verification fails, the old secret is put back and the
 * webhook is re-pointed at it, so a failed rotation leaves the bot exactly as
 * it was rather than deaf. The secret itself is never returned or logged.
 */
function rotateTelegramWebhookSecret_(payload) {
  if (!getBotToken_()) return { status: "error", message: "Bot token o'rnatilmagan." };

  var webhookUrl = stripWebhookSecret_(
    (payload && payload.webhookUrl) || getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL) || ""
  );
  if (!/^https:\/\/[^\s]+$/.test(webhookUrl)) {
    return { status: "error", message: "Webhook manzili https:// bilan boshlanishi kerak." };
  }

  var previous = getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET);
  var next = generateWebhookSecret_();

  // Accept both before Telegram is told anything, so neither ordering can drop
  // an update that is already in flight.
  if (previous) setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET_PREVIOUS, previous);
  setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET, next);

  try {
    var separator = webhookUrl.indexOf("?") === -1 ? "?" : "&";
    telegramFetch_("setWebhook", {
      url: webhookUrl + separator + TELEGRAM_WEBHOOK_SECRET_PARAM + "=" + next,
      secret_token: next,
      allowed_updates: ["message", "callback_query"]
    });

    var info = safeParseJSON_(telegramFetch_("getWebhookInfo", {}).getContentText(), {});
    var result = (info && info.result) || {};
    if (!result.url) throw new Error("Telegram webhook manzilini tasdiqlamadi.");

    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET_PREVIOUS, "");
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL, webhookUrl);
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_ROTATED_AT, new Date().toISOString());
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_STATUS, JSON.stringify({
      configured: true,
      verified: true,
      pendingUpdateCount: result.pending_update_count || 0,
      lastErrorMessage: redactSecrets_(result.last_error_message || ""),
      checkedAt: new Date().toISOString()
    }));

    auditTelegramSettingsChange_(["webhookSecret"]);
    return { status: "success", rotated: true, settings: buildTelegramSettingsView_() };
  } catch (error) {
    restoreWebhookSecret_(previous, webhookUrl);
    return {
      status: "error",
      message: "Kalitni almashtirib bo'lmadi, eski kalit qaytarildi. " + redactSecrets_(error).slice(0, 200),
      settings: buildTelegramSettingsView_()
    };
  }
}

/** Puts the old secret back and re-points Telegram at it. Never throws. */
function restoreWebhookSecret_(previous, webhookUrl) {
  try {
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET, previous || "");
    setTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET_PREVIOUS, "");
    if (!previous) return;
    var separator = webhookUrl.indexOf("?") === -1 ? "?" : "&";
    telegramFetch_("setWebhook", {
      url: webhookUrl + separator + TELEGRAM_WEBHOOK_SECRET_PARAM + "=" + previous,
      secret_token: previous,
      allowed_updates: ["message", "callback_query"]
    });
  } catch (restoreError) {
    // Nothing further is safe to try automatically. The operator's recovery is
    // the Webhook button, which mints and installs a secret from scratch.
    try {
      recordTelegramError_("rotateWebhookSecret", restoreError);
    } catch (ignored) {}
  }
}

// ----- apps-script/16_tasks_recurrence.gs --------------------------------------

// ============================================================
// Tasks — time & recurrence (pure)
// ------------------------------------------------------------
// Everything the task system needs to reason about calendar time, kept as pure
// functions so it behaves identically in Apps Script and under `node --test`.
//
// All task scheduling and display uses Asia/Tashkent. Uzbekistan abolished DST
// in 1992 and has been a fixed UTC+5 ever since, so a constant offset is exact
// and — unlike Utilities.formatDate / the host timezone — fully deterministic.
// Instants are epoch milliseconds (timezone independent); wall-clock is derived
// from them only where a human has to read it.
// ============================================================

var TASHKENT_UTC_OFFSET_MINUTES = 300; // UTC+5, year round.
var TASK_MS_PER_DAY = 86400000;

function taskPad2_(n) {
  var s = String(Math.abs(Number(n) || 0));
  return s.length >= 2 ? s : "0" + s;
}

/** epoch ms -> Tashkent wall-clock parts. */
function taskTzParts_(instant) {
  var ms = (instant instanceof Date ? instant.getTime() : Number(instant));
  if (!isFinite(ms)) ms = 0;
  var shifted = new Date(ms + TASHKENT_UTC_OFFSET_MINUTES * 60000);
  var year = shifted.getUTCFullYear();
  var month = shifted.getUTCMonth() + 1;
  var day = shifted.getUTCDate();
  var hour = shifted.getUTCHours();
  var minute = shifted.getUTCMinutes();
  return {
    year: year,
    month: month,
    day: day,
    hour: hour,
    minute: minute,
    weekday: shifted.getUTCDay(), // 0=Sunday .. 6=Saturday
    dateKey: year + "-" + taskPad2_(month) + "-" + taskPad2_(day),
    timeKey: taskPad2_(hour) + ":" + taskPad2_(minute)
  };
}

/** "now" in Tashkent as a YYYY-MM-DD date key. */
function taskTodayKey_(nowMs) {
  return taskTzParts_(nowMs === undefined ? Date.now() : nowMs).dateKey;
}

function isTaskDateKey_(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function isTaskTimeKey_(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

/**
 * A YYYY-MM-DD key from whatever the sheet handed back.
 *
 * Exact text wins. A cell the spreadsheet already turned into a real date is
 * recovered from its local year/month/day - the same convention
 * parseTransactionDate_ uses for the accounting columns - so rows written
 * before these columns were text-formatted still read correctly instead of
 * silently becoming "". Anything else is not a date key and returns "".
 */
function taskDateKeyFromCell_(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object" && typeof value.getFullYear === "function") {
    if (isNaN(value.getTime())) return "";
    return value.getFullYear() + "-" + taskPad2_(value.getMonth() + 1) + "-" + taskPad2_(value.getDate());
  }
  var text = String(value).trim();
  if (isTaskDateKey_(text)) return text;
  // A full timestamp in a date column is an instant, not a calendar date;
  // read it in the same local frame a Date cell would have been read in.
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    var instant = new Date(text);
    if (!isNaN(instant.getTime())) {
      return instant.getFullYear() + "-" + taskPad2_(instant.getMonth() + 1) + "-" + taskPad2_(instant.getDate());
    }
  }
  return "";
}

/**
 * An HH:mm key from whatever the sheet handed back. Sheets stores a bare
 * "20:00" as 1899-12-30T20:00, so a time cell arrives as a Date whose clock
 * fields are the only part that means anything.
 */
function taskTimeKeyFromCell_(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object" && typeof value.getHours === "function") {
    if (isNaN(value.getTime())) return "";
    return taskPad2_(value.getHours()) + ":" + taskPad2_(value.getMinutes());
  }
  var text = String(value).trim();
  if (isTaskTimeKey_(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    var instant = new Date(text);
    if (!isNaN(instant.getTime())) return taskPad2_(instant.getHours()) + ":" + taskPad2_(instant.getMinutes());
  }
  var hm = /^(\d{1,2}):([0-5]\d)/.exec(text);
  if (hm && Number(hm[1]) <= 23) return taskPad2_(hm[1]) + ":" + hm[2];
  return "";
}

/** The epoch ms of a Tashkent wall-clock (dateKey + optional HH:mm). NaN if bad. */
function taskInstantMs_(dateKey, timeKey) {
  var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!dm) return NaN;
  var tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeKey || "00:00"));
  var hour = tm ? Number(tm[1]) : 0;
  var minute = tm ? Number(tm[2]) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return NaN;
  return Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), hour, minute, 0)
    - TASHKENT_UTC_OFFSET_MINUTES * 60000;
}

/** Midnight UTC anchor for a date key, used only for whole-day arithmetic. */
function taskKeyAnchorMs_(dateKey) {
  var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!dm) return NaN;
  return Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
}

function taskKeyFromAnchorMs_(ms) {
  var d = new Date(ms);
  return d.getUTCFullYear() + "-" + taskPad2_(d.getUTCMonth() + 1) + "-" + taskPad2_(d.getUTCDate());
}

/** Shift a date key by whole days, forwards or backwards, across month ends. */
function taskDateKeyAddDays_(dateKey, days) {
  var anchor = taskKeyAnchorMs_(dateKey);
  if (!isFinite(anchor)) return "";
  return taskKeyFromAnchorMs_(anchor + Number(days || 0) * TASK_MS_PER_DAY);
}

/** Whole days from a to b (b - a); negative when b precedes a. */
function taskDaysBetweenKeys_(a, b) {
  var left = taskKeyAnchorMs_(a);
  var right = taskKeyAnchorMs_(b);
  if (!isFinite(left) || !isFinite(right)) return NaN;
  return Math.round((right - left) / TASK_MS_PER_DAY);
}

/** 0=Sunday .. 6=Saturday for a date key. */
function taskWeekdayOfKey_(dateKey) {
  var anchor = taskKeyAnchorMs_(dateKey);
  if (!isFinite(anchor)) return -1;
  return new Date(anchor).getUTCDay();
}

/** The Monday that starts the ISO week containing this date key. */
function taskWeekStartKey_(dateKey) {
  var weekday = taskWeekdayOfKey_(dateKey);
  if (weekday < 0) return "";
  var back = (weekday + 6) % 7; // days since Monday
  return taskDateKeyAddDays_(dateKey, -back);
}

/** Days in a month, leap years included. */
function taskDaysInMonth_(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Normalises an admin-supplied recurrence into a canonical shape.
 *
 *   { freq: 'daily'|'weekly'|'monthly'|'custom',
 *     interval: >=1,            // every N days / weeks / months
 *     weekdays: [0..6],         // weekly: which days (0=Sun); [] means "start's weekday"
 *     monthDay: 1..31 | 'last', // monthly: which day of month
 *     intervalDays: >=1 }       // custom: every N days
 */
function normalizeTaskRecurrence_(recurrence) {
  var r = recurrence && typeof recurrence === "object" ? recurrence : {};
  var freq = ["daily", "weekly", "monthly", "custom"].indexOf(String(r.freq)) !== -1 ? String(r.freq) : "daily";
  var weekdays = [];
  if (Array.isArray(r.weekdays)) {
    var seen = {};
    for (var i = 0; i < r.weekdays.length; i++) {
      var wd = Number(r.weekdays[i]);
      if (wd >= 0 && wd <= 6 && !seen[wd]) { seen[wd] = true; weekdays.push(wd); }
    }
    weekdays.sort(function (a, b) { return a - b; });
  }
  var monthDay = r.monthDay === "last" ? "last" : Math.min(31, Math.max(1, Number(r.monthDay) || 1));
  return {
    freq: freq,
    interval: Math.max(1, Math.floor(Number(r.interval) || 1)),
    weekdays: weekdays,
    monthDay: monthDay,
    intervalDays: Math.max(1, Math.floor(Number(r.intervalDays) || Number(r.interval) || 1))
  };
}

/**
 * Whether a routine falls due on a given date, honouring start/end bounds.
 * `recurrence` must already be normalised.
 */
function routineOccursOnKey_(recurrence, startKey, endKey, dateKey) {
  if (!isTaskDateKey_(startKey) || !isTaskDateKey_(dateKey)) return false;
  if (dateKey < startKey) return false;
  if (endKey && isTaskDateKey_(endKey) && dateKey > endKey) return false;

  var r = recurrence || {};
  if (r.freq === "daily") {
    var dailyDiff = taskDaysBetweenKeys_(startKey, dateKey);
    return dailyDiff >= 0 && dailyDiff % r.interval === 0;
  }

  if (r.freq === "weekly") {
    var weekdays = (r.weekdays && r.weekdays.length) ? r.weekdays : [taskWeekdayOfKey_(startKey)];
    if (weekdays.indexOf(taskWeekdayOfKey_(dateKey)) === -1) return false;
    var weekDiff = Math.floor(
      taskDaysBetweenKeys_(taskWeekStartKey_(startKey), taskWeekStartKey_(dateKey)) / 7);
    return weekDiff >= 0 && weekDiff % r.interval === 0;
  }

  if (r.freq === "monthly") {
    var d = taskTzPartsFromKey_(dateKey);
    var s = taskTzPartsFromKey_(startKey);
    var monthDiff = (d.year - s.year) * 12 + (d.month - s.month);
    if (monthDiff < 0 || monthDiff % r.interval !== 0) return false;
    var lastDay = taskDaysInMonth_(d.year, d.month);
    var targetDay = r.monthDay === "last" ? lastDay : Math.min(Number(r.monthDay), lastDay);
    return d.day === targetDay;
  }

  if (r.freq === "custom") {
    var customDiff = taskDaysBetweenKeys_(startKey, dateKey);
    return customDiff >= 0 && customDiff % r.intervalDays === 0;
  }

  return false;
}

/** Cheap year/month/day for a date key, without a timezone shift. */
function taskTzPartsFromKey_(dateKey) {
  var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!dm) return { year: 0, month: 0, day: 0 };
  return { year: Number(dm[1]), month: Number(dm[2]), day: Number(dm[3]) };
}

/** Every date a routine falls due within [fromKey, toKey], inclusive. */
function routineOccurrenceKeysInRange_(recurrence, startKey, endKey, fromKey, toKey) {
  var keys = [];
  if (!isTaskDateKey_(fromKey) || !isTaskDateKey_(toKey)) return keys;
  var cursor = fromKey < startKey ? startKey : fromKey;
  var guard = 0;
  while (cursor <= toKey && guard < 1000) {
    guard++;
    if (routineOccursOnKey_(recurrence, startKey, endKey, cursor)) keys.push(cursor);
    cursor = taskDateKeyAddDays_(cursor, 1);
  }
  return keys;
}

/** "2h 14m", "1d 3h 0m", "0m" — never negative. */
function formatTaskDuration_(ms) {
  var totalMinutes = Math.max(0, Math.floor((Number(ms) || 0) / 60000));
  var days = Math.floor(totalMinutes / 1440);
  var hours = Math.floor((totalMinutes % 1440) / 60);
  var minutes = totalMinutes % 60;
  var parts = [];
  if (days) parts.push(days + "d");
  if (days || hours) parts.push(hours + "h");
  parts.push(minutes + "m");
  return parts.join(" ");
}

/** Human Tashkent stamp "dd.MM.yyyy HH:mm" from an epoch ms. */
function formatTaskInstant_(instant) {
  var p = taskTzParts_(instant);
  return taskPad2_(p.day) + "." + taskPad2_(p.month) + "." + p.year + " " + p.timeKey;
}

/** Human Tashkent date "dd.MM.yyyy" from a date key. */
function formatTaskDateKey_(dateKey) {
  var p = taskTzPartsFromKey_(dateKey);
  if (!p.year) return String(dateKey || "");
  return taskPad2_(p.day) + "." + taskPad2_(p.month) + "." + p.year;
}

// ----- apps-script/17_tasks_store.gs -------------------------------------------

// ============================================================
// Tasks — storage, occurrences and views
// ------------------------------------------------------------
// Task data lives in its own sheets and never touches the financial ledger.
//
//   Tasks              one row per definition (one-time, routine or goal)
//   Task_Occurrences   one row per completable instance, with its own
//                      completion / proof / reminder history
//
// A routine never "completes"; the scheduler materialises a fresh occurrence
// per due date, so each day has its own row, status and history.
// ============================================================

var TASKS_SHEET = "Tasks";
var TASK_OCCURRENCES_SHEET = "Task_Occurrences";

var TASKS_HEADER = [
  "ID", "Type", "Title", "Description", "Responsible", "Priority", "Photo_Required",
  "Recurrence_JSON", "Reminder_Times_JSON", "Remind_Daily", "Due_Time",
  "Deadline_Key", "Deadline_Time", "Start_Key", "End_Key", "Status", "Steps_JSON",
  "Created_At", "Updated_At", "Created_By", "Meta_JSON"
];

var TASK_OCC_HEADER = [
  "ID", "Task_ID", "Task_Type", "Title", "Date_Key", "Step_Index", "Due_At",
  "Responsible", "Priority", "Photo_Required", "Reminder_Times_JSON", "Remind_Daily",
  "Status", "Reminders_Sent_JSON", "Notified_At", "Telegram_Msg_ID",
  "Completed_By_Id", "Completed_By_Name", "Completed_At", "On_Time", "Late_Ms",
  "Proof_File_Id", "Proof_Msg_Id", "Proof_Awaiting_User_Id",
  "Created_At", "Updated_At", "Meta_JSON"
];

// Occurrence lifecycle states. "Overdue" is a *derived* view of an Open (or
// waiting) occurrence past its deadline, never a stored value, so a completion
// can always be judged on-time vs late against the same deadline.
var TASK_STATUS_OPEN = "Open";
var TASK_STATUS_WAITING = "WaitingProof";
var TASK_STATUS_COMPLETED = "Completed";
var TASK_STATUS_CANCELLED = "Cancelled";
var TASK_STATUS_SKIPPED = "Skipped";

// Task-definition states.
var TASK_DEF_ACTIVE = "active";
var TASK_DEF_PAUSED = "paused";
var TASK_DEF_COMPLETED = "completed";
var TASK_DEF_CANCELLED = "cancelled";

var TASK_PRIORITIES = ["low", "normal", "high", "urgent"];
var TASK_TYPES = ["once", "routine", "goal"];

var TASK_GENERATION_HORIZON_DAYS = 14; // how far ahead routines are materialised
var TASK_STATS_WINDOW = 180;           // occurrences considered for streak / rate

function parseTaskBool_(value) {
  return value === true || value === "TRUE" || value === "true" || value === 1 || value === "1";
}

function taskBoolCell_(value) {
  return value ? "TRUE" : "FALSE";
}

function normalizeTaskPriority_(value) {
  var v = String(value || "").toLowerCase();
  return TASK_PRIORITIES.indexOf(v) !== -1 ? v : "normal";
}

function normalizeTaskTimes_(times) {
  var source = Array.isArray(times) ? times : [];
  var seen = {};
  var out = [];
  for (var i = 0; i < source.length; i++) {
    // Tolerant of a value the spreadsheet already rewrote, so a reminder list
    // that was stored oddly still parses instead of vanishing.
    var t = taskTimeKeyFromCell_(source[i]);
    if (isTaskTimeKey_(t) && !seen[t]) { seen[t] = true; out.push(t); }
  }
  out.sort();
  return out;
}

// ------------------------------------------------------------------ sheets

function tasksSheet_(doc) {
  var sheet = doc.getSheetByName(TASKS_SHEET) || doc.insertSheet(TASKS_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(TASKS_HEADER);
  return sheet;
}

function taskOccurrencesSheet_(doc) {
  var sheet = doc.getSheetByName(TASK_OCCURRENCES_SHEET) || doc.insertSheet(TASK_OCCURRENCES_SHEET);
  if (sheet.getLastRow() === 0) sheet.appendRow(TASK_OCC_HEADER);
  return sheet;
}

function taskColumnIndex_(header, name) {
  return header.indexOf(name) + 1; // 1-based sheet column
}

// Columns whose value must reach the sheet as exact text. Everything here is
// a date key, a clock time or an ISO stamp: values a spreadsheet will happily
// reinterpret as a date of its own choosing if the column is not text.
var TASKS_TEXT_COLUMNS = [
  "Due_Time", "Deadline_Key", "Deadline_Time", "Start_Key", "End_Key",
  "Created_At", "Updated_At"
];

var TASK_OCC_TEXT_COLUMNS = [
  "Date_Key", "Notified_At", "Completed_At", "Created_At", "Updated_At"
];

/** Column numbers for `names`, merged into contiguous [start, count] spans. */
function taskTextColumnSpans_(header, names) {
  var cols = [];
  for (var i = 0; i < names.length; i++) {
    var index = header.indexOf(names[i]) + 1;
    if (index > 0) cols.push(index);
  }
  cols.sort(function (a, b) { return a - b; });
  var spans = [];
  for (var c = 0; c < cols.length; c++) {
    var last = spans[spans.length - 1];
    if (last && cols[c] === last[0] + last[1]) last[1]++;
    else spans.push([cols[c], 1]);
  }
  return spans;
}

/**
 * Stops the spreadsheet reinterpreting what is about to be written.
 *
 * Must run BEFORE the values land: a number format applied afterwards
 * reformats an already-coerced value, it does not recover it.
 */
function applyTaskTextFormats_(sheet, header, names, startRow, numRows) {
  if (!sheet || numRows < 1 || typeof sheet.getRange !== "function") return;
  var probe = sheet.getRange(startRow, 1, numRows, 1);
  if (typeof probe.setNumberFormat !== "function") return; // older host / test double
  var spans = taskTextColumnSpans_(header, names);
  for (var s = 0; s < spans.length; s++) {
    sheet.getRange(startRow, spans[s][0], numRows, spans[s][1]).setNumberFormat("@");
  }
}

// ------------------------------------------------------------ task records

function taskFromRow_(row) {
  var i = function (name) { return row[TASKS_HEADER.indexOf(name)]; };
  return {
    id: String(i("ID") || ""),
    type: String(i("Type") || "once"),
    title: String(i("Title") || ""),
    description: String(i("Description") || ""),
    responsible: String(i("Responsible") || ""),
    priority: normalizeTaskPriority_(i("Priority")),
    photoRequired: parseTaskBool_(i("Photo_Required")),
    recurrence: normalizeTaskRecurrence_(safeParseJSON_(i("Recurrence_JSON"), {})),
    reminderTimes: normalizeTaskTimes_(safeParseJSON_(i("Reminder_Times_JSON"), [])),
    remindDaily: parseTaskBool_(i("Remind_Daily")),
    dueTime: taskTimeKeyFromCell_(i("Due_Time")),
    deadlineKey: taskDateKeyFromCell_(i("Deadline_Key")),
    deadlineTime: taskTimeKeyFromCell_(i("Deadline_Time")),
    startKey: taskDateKeyFromCell_(i("Start_Key")),
    endKey: taskDateKeyFromCell_(i("End_Key")),
    status: String(i("Status") || TASK_DEF_ACTIVE),
    steps: normalizeGoalSteps_(safeParseJSON_(i("Steps_JSON"), [])),
    createdAt: String(i("Created_At") || ""),
    updatedAt: String(i("Updated_At") || ""),
    createdBy: String(i("Created_By") || ""),
    meta: safeParseJSON_(i("Meta_JSON"), {})
  };
}

function taskToRow_(task) {
  var map = {
    ID: task.id,
    Type: task.type,
    Title: task.title,
    Description: task.description || "",
    Responsible: task.responsible || "",
    Priority: task.priority || "normal",
    Photo_Required: taskBoolCell_(task.photoRequired),
    Recurrence_JSON: JSON.stringify(task.recurrence || {}),
    Reminder_Times_JSON: JSON.stringify(task.reminderTimes || []),
    Remind_Daily: taskBoolCell_(task.remindDaily),
    Due_Time: task.dueTime || "",
    Deadline_Key: task.deadlineKey || "",
    Deadline_Time: task.deadlineTime || "",
    Start_Key: task.startKey || "",
    End_Key: task.endKey || "",
    Status: task.status || TASK_DEF_ACTIVE,
    Steps_JSON: JSON.stringify(task.steps || []),
    Created_At: task.createdAt || "",
    Updated_At: task.updatedAt || "",
    Created_By: task.createdBy || "",
    Meta_JSON: JSON.stringify(task.meta || {})
  };
  return TASKS_HEADER.map(function (name) { return map[name]; });
}

function newGoalStepId_() {
  return "step_" + Utilities.getUuid().split("-").join("");
}

function normalizeGoalSteps_(steps) {
  var source = Array.isArray(steps) ? steps : [];
  var out = [];
  for (var i = 0; i < source.length; i++) {
    var step = typeof source[i] === "string" ? { title: source[i] } : (source[i] || {});
    var title = String(step.title || "").trim();
    if (!title) continue;
    var entry = { title: title };
    if (step.id) entry.id = String(step.id).slice(0, 64);
    // Absent means "inherit from the goal". Only an explicit value overrides,
    // which is why this key is not written unless one was supplied.
    if (step.photoRequired !== undefined && step.photoRequired !== null && step.photoRequired !== "") {
      entry.photoRequired = parseTaskBool_(step.photoRequired);
    }
    out.push(entry);
  }
  return out;
}

/** The photo rule that actually applies to a step. */
function effectiveStepPhotoRequired_(task, step) {
  if (step && step.photoRequired !== undefined) return !!step.photoRequired;
  return !!task.photoRequired;
}

/** "<goal title> — <step title>", the label a step-occurrence carries. */
function goalStepTitle_(task, step, index) {
  return task.title + " — " + ((step && step.title) || ("Qadam " + (index + 1)));
}

/**
 * Whether a goal's reminder times apply to its steps.
 *
 * A step has no due date, so there is no single moment to remind about. If the
 * admin set reminder times on the goal, the only reading that does what they
 * asked is "every day until the step is done".
 */
function goalRemindDaily_(task) {
  return !!(task.reminderTimes && task.reminderTimes.length);
}

function readTaskRows_(doc) {
  var sheet = doc.getSheetByName(TASKS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var task = taskFromRow_(data[i]);
    task.rowNumber = i + 1;
    rows.push(task);
  }
  return rows;
}

function findTask_(doc, taskId) {
  if (!taskId) return null;
  var rows = readTaskRows_(doc);
  for (var i = 0; i < rows.length; i++) if (rows[i].id === String(taskId)) return rows[i];
  return null;
}

function appendTaskRow_(doc, task) {
  var sheet = tasksSheet_(doc);
  var row = sheet.getLastRow() + 1;
  applyTaskTextFormats_(sheet, TASKS_HEADER, TASKS_TEXT_COLUMNS, row, 1);
  sheet.appendRow(taskToRow_(task));
  bumpDataRevision_(CACHE_SCOPE_TASKS);
}

function updateTaskRow_(doc, task) {
  var sheet = tasksSheet_(doc);
  if (!task.rowNumber) return;
  applyTaskTextFormats_(sheet, TASKS_HEADER, TASKS_TEXT_COLUMNS, task.rowNumber, 1);
  sheet.getRange(task.rowNumber, 1, 1, TASKS_HEADER.length).setValues([taskToRow_(task)]);
  bumpDataRevision_(CACHE_SCOPE_TASKS);
}

// ------------------------------------------------------ occurrence records

function occurrenceFromRow_(row) {
  var i = function (name) { return row[TASK_OCC_HEADER.indexOf(name)]; };
  var dueRaw = i("Due_At");
  return {
    id: String(i("ID") || ""),
    taskId: String(i("Task_ID") || ""),
    taskType: String(i("Task_Type") || ""),
    title: String(i("Title") || ""),
    dateKey: taskDateKeyFromCell_(i("Date_Key")),
    stepIndex: i("Step_Index") === "" || i("Step_Index") === null || i("Step_Index") === undefined
      ? "" : Number(i("Step_Index")),
    dueAt: dueRaw === "" || dueRaw === null || dueRaw === undefined ? "" : Number(dueRaw),
    responsible: String(i("Responsible") || ""),
    priority: normalizeTaskPriority_(i("Priority")),
    photoRequired: parseTaskBool_(i("Photo_Required")),
    reminderTimes: normalizeTaskTimes_(safeParseJSON_(i("Reminder_Times_JSON"), [])),
    remindDaily: parseTaskBool_(i("Remind_Daily")),
    status: String(i("Status") || TASK_STATUS_OPEN),
    remindersSent: safeParseJSON_(i("Reminders_Sent_JSON"), {}),
    notifiedAt: String(i("Notified_At") || ""),
    msgId: String(i("Telegram_Msg_ID") || ""),
    completedById: String(i("Completed_By_Id") || ""),
    completedByName: String(i("Completed_By_Name") || ""),
    completedAt: String(i("Completed_At") || ""),
    onTime: i("On_Time") === "" ? "" : parseTaskBool_(i("On_Time")),
    lateMs: i("Late_Ms") === "" || i("Late_Ms") === null || i("Late_Ms") === undefined ? "" : Number(i("Late_Ms")),
    proofFileId: String(i("Proof_File_Id") || ""),
    proofMsgId: String(i("Proof_Msg_Id") || ""),
    proofAwaitingUserId: String(i("Proof_Awaiting_User_Id") || ""),
    createdAt: String(i("Created_At") || ""),
    updatedAt: String(i("Updated_At") || ""),
    meta: safeParseJSON_(i("Meta_JSON"), {})
  };
}

function occurrenceToRow_(occ) {
  var map = {
    ID: occ.id,
    Task_ID: occ.taskId,
    Task_Type: occ.taskType,
    Title: occ.title,
    Date_Key: occ.dateKey || "",
    Step_Index: occ.stepIndex === "" || occ.stepIndex === undefined || occ.stepIndex === null ? "" : occ.stepIndex,
    Due_At: occ.dueAt === "" || occ.dueAt === undefined || occ.dueAt === null ? "" : occ.dueAt,
    Responsible: occ.responsible || "",
    Priority: occ.priority || "normal",
    Photo_Required: taskBoolCell_(occ.photoRequired),
    Reminder_Times_JSON: JSON.stringify(occ.reminderTimes || []),
    Remind_Daily: taskBoolCell_(occ.remindDaily),
    Status: occ.status || TASK_STATUS_OPEN,
    Reminders_Sent_JSON: JSON.stringify(occ.remindersSent || {}),
    Notified_At: occ.notifiedAt || "",
    Telegram_Msg_ID: occ.msgId || "",
    Completed_By_Id: occ.completedById || "",
    Completed_By_Name: occ.completedByName || "",
    Completed_At: occ.completedAt || "",
    On_Time: occ.onTime === "" || occ.onTime === undefined || occ.onTime === null ? "" : taskBoolCell_(occ.onTime),
    Late_Ms: occ.lateMs === "" || occ.lateMs === undefined || occ.lateMs === null ? "" : occ.lateMs,
    Proof_File_Id: occ.proofFileId || "",
    Proof_Msg_Id: occ.proofMsgId || "",
    Proof_Awaiting_User_Id: occ.proofAwaitingUserId || "",
    Created_At: occ.createdAt || "",
    Updated_At: occ.updatedAt || "",
    Meta_JSON: JSON.stringify(occ.meta || {})
  };
  return TASK_OCC_HEADER.map(function (name) { return map[name]; });
}

function readOccurrenceRows_(doc) {
  var sheet = doc.getSheetByName(TASK_OCCURRENCES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    var occ = occurrenceFromRow_(data[i]);
    occ.rowNumber = i + 1;
    rows.push(occ);
  }
  return rows;
}

function findOccurrence_(doc, occurrenceId) {
  if (!occurrenceId) return null;
  var rows = readOccurrenceRows_(doc);
  for (var i = 0; i < rows.length; i++) if (rows[i].id === String(occurrenceId)) return rows[i];
  return null;
}

function occurrencesForTask_(rows, taskId) {
  var out = [];
  for (var i = 0; i < rows.length; i++) if (rows[i].taskId === String(taskId)) out.push(rows[i]);
  return out;
}

function appendOccurrenceRow_(doc, occ) {
  var sheet = taskOccurrencesSheet_(doc);
  var row = sheet.getLastRow() + 1;
  applyTaskTextFormats_(sheet, TASK_OCC_HEADER, TASK_OCC_TEXT_COLUMNS, row, 1);
  sheet.appendRow(occurrenceToRow_(occ));
  occ.rowNumber = row;
  bumpDataRevision_(CACHE_SCOPE_TASKS);
}

/** Appends many occurrences in one write, protecting their text columns first. */
function appendOccurrenceRows_(doc, occurrences) {
  if (!occurrences || !occurrences.length) return [];
  var sheet = taskOccurrencesSheet_(doc);
  var startRow = sheet.getLastRow() + 1;
  applyTaskTextFormats_(sheet, TASK_OCC_HEADER, TASK_OCC_TEXT_COLUMNS, startRow, occurrences.length);
  var values = [];
  for (var i = 0; i < occurrences.length; i++) values.push(occurrenceToRow_(occurrences[i]));
  sheet.getRange(startRow, 1, values.length, TASK_OCC_HEADER.length).setValues(values);
  for (var r = 0; r < occurrences.length; r++) occurrences[r].rowNumber = startRow + r;
  bumpDataRevision_(CACHE_SCOPE_TASKS);
  return occurrences;
}

/** Rewrites a single occurrence row from an in-memory object. */
function writeOccurrenceRow_(doc, occ) {
  var sheet = taskOccurrencesSheet_(doc);
  if (!occ.rowNumber) return;
  occ.updatedAt = new Date().toISOString();
  applyTaskTextFormats_(sheet, TASK_OCC_HEADER, TASK_OCC_TEXT_COLUMNS, occ.rowNumber, 1);
  sheet.getRange(occ.rowNumber, 1, 1, TASK_OCC_HEADER.length).setValues([occurrenceToRow_(occ)]);
  bumpDataRevision_(CACHE_SCOPE_TASKS);
}

// ------------------------------------------------ occurrence materialisation

/**
 * Ensures the occurrence rows that should exist for a task exist, and returns
 * the ones this call created. Idempotent: an occurrence is keyed by
 * (taskId, dateKey) for routines/one-time and (taskId, stepIndex) for goals,
 * so re-running never duplicates and never disturbs completed history.
 *
 * `ctx` is an optional per-pass working set: the occurrence rows already read
 * from the sheet, plus the rows this pass wants to add. Passing one turns a
 * scan-per-task into a single scan and a single append for the whole pass.
 * Called without one it behaves exactly as before.
 */
function materializeTaskOccurrences_(doc, task, nowMs, ctx) {
  if (task.status === TASK_DEF_CANCELLED) return [];
  var todayKey = taskTodayKey_(nowMs);
  var existing = occurrencesForTask_(ctx ? ctx.occurrences : readOccurrenceRows_(doc), task.id);

  var byDate = {};
  var byStep = {};
  for (var e = 0; e < existing.length; e++) {
    if (existing[e].dateKey) byDate[existing[e].dateKey] = existing[e];
    // A removed step's row is history and must not block a new step from
    // taking its index.
    if (existing[e].stepIndex !== "" && !(existing[e].meta && existing[e].meta.removedStep)) {
      byStep[existing[e].stepIndex] = existing[e];
    }
  }

  var created = [];

  if (task.type === "once") {
    // A single occurrence. dateKey/dueAt are empty when the task has no deadline.
    if (existing.length === 0) {
      created.push(buildOccurrenceForOnce_(task));
    }
  } else if (task.type === "goal") {
    for (var s = 0; s < task.steps.length; s++) {
      if (byStep[s] === undefined) created.push(buildOccurrenceForGoalStep_(task, s));
    }
  } else if (task.type === "routine" && task.status === TASK_DEF_ACTIVE) {
    var genFrom = task.startKey && task.startKey > todayKey ? task.startKey : todayKey;
    var genTo = taskDateKeyAddDays_(todayKey, TASK_GENERATION_HORIZON_DAYS);
    var dueKeys = routineOccurrenceKeysInRange_(task.recurrence, task.startKey || genFrom, task.endKey, genFrom, genTo);
    for (var k = 0; k < dueKeys.length; k++) {
      if (!byDate[dueKeys[k]]) created.push(buildOccurrenceForRoutine_(task, dueKeys[k]));
    }
  }

  if (ctx) {
    for (var c = 0; c < created.length; c++) { ctx.pending.push(created[c]); ctx.occurrences.push(created[c]); }
  } else {
    for (var a = 0; a < created.length; a++) appendOccurrenceRow_(doc, created[a]);
  }
  return created;
}

function newOccurrenceId_() {
  return "occ_" + Utilities.getUuid().split("-").join("");
}

function baseOccurrence_(task) {
  var nowIso = new Date().toISOString();
  return {
    id: newOccurrenceId_(),
    taskId: task.id,
    taskType: task.type,
    title: task.title,
    dateKey: "",
    stepIndex: "",
    dueAt: "",
    responsible: task.responsible || "",
    priority: task.priority || "normal",
    photoRequired: !!task.photoRequired,
    reminderTimes: task.reminderTimes || [],
    remindDaily: !!task.remindDaily,
    status: TASK_STATUS_OPEN,
    remindersSent: {},
    notifiedAt: "",
    msgId: "",
    completedById: "",
    completedByName: "",
    completedAt: "",
    onTime: "",
    lateMs: "",
    proofFileId: "",
    proofMsgId: "",
    proofAwaitingUserId: "",
    createdAt: nowIso,
    updatedAt: nowIso,
    meta: {}
  };
}

function buildOccurrenceForOnce_(task) {
  var occ = baseOccurrence_(task);
  occ.dateKey = task.deadlineKey || "";
  occ.dueAt = task.deadlineKey ? taskInstantMs_(task.deadlineKey, task.deadlineTime || "23:59") : "";
  return occ;
}

function buildOccurrenceForRoutine_(task, dateKey) {
  var occ = baseOccurrence_(task);
  occ.dateKey = dateKey;
  // A routine with a due time can be late; one without simply "belongs" to the day.
  occ.dueAt = task.dueTime ? taskInstantMs_(dateKey, task.dueTime) : "";
  return occ;
}

function buildOccurrenceForGoalStep_(task, stepIndex) {
  var occ = baseOccurrence_(task);
  var step = task.steps[stepIndex] || {};
  occ.stepIndex = stepIndex;
  occ.title = goalStepTitle_(task, step, stepIndex);
  occ.photoRequired = effectiveStepPhotoRequired_(task, step);
  occ.remindDaily = goalRemindDaily_(task);
  occ.dueAt = "";
  occ.meta = { stepId: step.id || "" };
  return occ;
}

// ---------------------------------------------------------------- views

/**
 * The derived, human-facing status of an occurrence at a moment in time.
 * "Overdue" only ever exists here — it is never written to the sheet.
 */
function occurrenceDisplayStatus_(occ, nowMs) {
  if (occ.status === TASK_STATUS_COMPLETED) return "Completed";
  if (occ.status === TASK_STATUS_CANCELLED) return "Cancelled";
  if (occ.status === TASK_STATUS_SKIPPED) return "Skipped";
  if (occ.status === TASK_STATUS_WAITING) return "WaitingProof";
  if (occ.dueAt !== "" && isFinite(occ.dueAt) && nowMs > occ.dueAt) return "Overdue";
  return "Open";
}

function decorateOccurrence_(occ, nowMs) {
  var display = occurrenceDisplayStatus_(occ, nowMs);
  var view = {
    id: occ.id,
    taskId: occ.taskId,
    taskType: occ.taskType,
    title: occ.title,
    dateKey: occ.dateKey,
    stepIndex: occ.stepIndex,
    responsible: occ.responsible,
    priority: occ.priority,
    photoRequired: occ.photoRequired,
    reminderTimes: occ.reminderTimes,
    status: occ.status,
    displayStatus: display,
    isOverdue: display === "Overdue",
    dueAt: occ.dueAt,
    dueLabel: occ.dueAt !== "" && isFinite(occ.dueAt) ? formatTaskInstant_(occ.dueAt)
      : (occ.dateKey ? formatTaskDateKey_(occ.dateKey) : ""),
    completedAt: occ.completedAt,
    completedByName: occ.completedByName,
    onTime: occ.onTime,
    lateMs: occ.lateMs,
    lateLabel: occ.lateMs !== "" && Number(occ.lateMs) > 0 ? formatTaskDuration_(occ.lateMs) : "",
    msgId: occ.msgId,
    hasProof: !!occ.proofFileId
  };
  return view;
}

/** Streak and completion rate for one routine, over its materialised history. */
function routineStats_(occurrences, nowMs) {
  var todayKey = taskTodayKey_(nowMs);
  var past = [];
  for (var i = 0; i < occurrences.length; i++) {
    var o = occurrences[i];
    if (!o.dateKey || o.dateKey > todayKey) continue;
    // Today is not a miss until it is actually late. An open day that still has
    // hours left on the clock is neither a success nor a failure, so it neither
    // extends the streak nor ends it.
    if (o.dateKey === todayKey &&
        (o.status === TASK_STATUS_OPEN || o.status === TASK_STATUS_WAITING) &&
        occurrenceDisplayStatus_(o, nowMs) !== "Overdue") continue;
    past.push(o);
  }
  past.sort(function (a, b) { return a.dateKey < b.dateKey ? 1 : (a.dateKey > b.dateKey ? -1 : 0); });

  var completed = 0;
  var counted = 0;
  var streak = 0;
  var streakBroken = false;
  for (var j = 0; j < past.length; j++) {
    var status = past[j].status;
    if (status === TASK_STATUS_SKIPPED) continue; // neutral: neither helps nor breaks
    if (status === TASK_STATUS_COMPLETED) {
      completed++; counted++;
      if (!streakBroken) streak++;
    } else {
      counted++;
      streakBroken = true; // an open/overdue past day ends the streak
    }
  }
  return {
    streak: streak,
    completed: completed,
    counted: counted,
    completionRate: counted > 0 ? Math.round((completed / counted) * 100) : null
  };
}

/** Goal progress: fraction of its step-occurrences that are completed. */
function goalProgress_(occurrences) {
  var total = 0;
  var done = 0;
  for (var i = 0; i < occurrences.length; i++) {
    var occ = occurrences[i];
    if (occ.stepIndex === "") continue;
    if (occ.meta && occ.meta.removedStep) continue;      // history, not current scope
    if (occ.status === TASK_STATUS_CANCELLED || occ.status === TASK_STATUS_SKIPPED) continue;
    total++;
    if (occ.status === TASK_STATUS_COMPLETED) done++;
  }
  return { done: done, total: total, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/**
 * Everything the /tasks UI renders, computed for a moment in Tashkent time.
 * The Today view is split into what needs attention now, what is overdue,
 * what is coming up and what was completed today.
 */
function buildTaskViews_(doc, nowMs) {
  var now = nowMs === undefined ? Date.now() : nowMs;
  var todayKey = taskTodayKey_(now);
  var tasks = readTaskRows_(doc);
  var occurrences = readOccurrenceRows_(doc);

  var taskById = {};
  for (var t = 0; t < tasks.length; t++) taskById[tasks[t].id] = tasks[t];

  var overdue = [];
  var dueToday = [];
  var waitingProof = [];
  var upcoming = [];
  var completedToday = [];

  var horizonKey = taskDateKeyAddDays_(todayKey, TASK_GENERATION_HORIZON_DAYS);

  for (var i = 0; i < occurrences.length; i++) {
    var occ = occurrences[i];
    // Goal steps stay in the Maqsadlar tab, by progress. Bugun is reserved for
    // dated work, and a step has no date - this is the documented rule, not an
    // oversight. They are still announced to the group by the scheduler.
    if (occ.taskType === "goal") continue;
    var view = decorateOccurrence_(occ, now);

    if (occ.status === TASK_STATUS_COMPLETED) {
      var cp = occ.completedAt ? taskTzParts_(Date.parse(occ.completedAt)).dateKey : "";
      if (cp === todayKey) completedToday.push(view);
      continue;
    }
    if (occ.status === TASK_STATUS_CANCELLED || occ.status === TASK_STATUS_SKIPPED) continue;

    if (view.displayStatus === "Overdue") { overdue.push(view); continue; }
    if (occ.status === TASK_STATUS_WAITING) { waitingProof.push(view); continue; }

    // Open and not overdue.
    var key = occ.dateKey || todayKey;
    if (key <= todayKey) dueToday.push(view);
    else if (key <= horizonKey) upcoming.push(view);
    else upcoming.push(view);
  }

  var byPriorityThenDue = function (a, b) {
    var pr = TASK_PRIORITIES.indexOf(b.priority) - TASK_PRIORITIES.indexOf(a.priority);
    if (pr !== 0) return pr;
    var ad = a.dueAt === "" ? Infinity : a.dueAt;
    var bd = b.dueAt === "" ? Infinity : b.dueAt;
    return ad - bd;
  };
  overdue.sort(function (a, b) { return (a.dueAt || 0) - (b.dueAt || 0); });
  dueToday.sort(byPriorityThenDue);
  upcoming.sort(function (a, b) {
    return String(a.dateKey || "").localeCompare(String(b.dateKey || "")) || byPriorityThenDue(a, b);
  });
  completedToday.sort(function (a, b) { return String(b.completedAt).localeCompare(String(a.completedAt)); });

  var taskSummaries = tasks.map(function (task) {
    var taskOccs = occurrencesForTask_(occurrences, task.id);
    var summary = {
      id: task.id,
      type: task.type,
      title: task.title,
      description: task.description,
      responsible: task.responsible,
      priority: task.priority,
      photoRequired: task.photoRequired,
      status: task.status,
      reminderTimes: task.reminderTimes,
      remindDaily: task.remindDaily,
      dueTime: task.dueTime,
      deadlineKey: task.deadlineKey,
      deadlineTime: task.deadlineTime,
      startKey: task.startKey,
      endKey: task.endKey,
      recurrence: task.recurrence,
      recurrenceLabel: describeRecurrence_(task),
      steps: task.steps,
      createdAt: task.createdAt
    };
    if (task.type === "routine") {
      summary.stats = routineStats_(taskOccs, now);
      var todayOcc = null;
      for (var o = 0; o < taskOccs.length; o++) if (taskOccs[o].dateKey === todayKey) todayOcc = taskOccs[o];
      summary.todayOccurrence = todayOcc ? decorateOccurrence_(todayOcc, now) : null;
    }
    if (task.type === "goal") {
      summary.progress = goalProgress_(taskOccs);
      summary.stepOccurrences = taskOccs
        .filter(function (o) { return o.stepIndex !== "" && !(o.meta && o.meta.removedStep); })
        .sort(function (a, b) { return Number(a.stepIndex) - Number(b.stepIndex); })
        .map(function (o) { return decorateOccurrence_(o, now); });
    }
    if (task.type === "once") {
      var once = taskOccs[0];
      if (once) summary.occurrence = decorateOccurrence_(once, now);
    }
    return summary;
  });

  // A recent-completed feed for the Completed tab: newest first, capped.
  var recentCompleted = [];
  for (var rc = 0; rc < occurrences.length; rc++) {
    if (occurrences[rc].status === TASK_STATUS_COMPLETED) recentCompleted.push(occurrences[rc]);
  }
  recentCompleted.sort(function (a, b) { return String(b.completedAt).localeCompare(String(a.completedAt)); });
  recentCompleted = recentCompleted.slice(0, 50).map(function (o) { return decorateOccurrence_(o, now); });

  return {
    todayKey: todayKey,
    nowLabel: formatTaskInstant_(now),
    today: {
      overdue: overdue,
      needsAttention: dueToday,
      waitingProof: waitingProof,
      upcoming: upcoming,
      completedToday: completedToday
    },
    recentCompleted: recentCompleted,
    tasks: taskSummaries,
    counts: {
      overdue: overdue.length,
      dueToday: dueToday.length,
      waitingProof: waitingProof.length,
      upcoming: upcoming.length,
      completedToday: completedToday.length
    }
  };
}

/** A short human description of a routine's cadence, in Uzbek. */
function describeRecurrence_(task) {
  if (task.type !== "routine") return "";
  var r = task.recurrence || {};
  var weekdayNames = ["Yak", "Du", "Se", "Chor", "Pay", "Jum", "Shan"];
  if (r.freq === "daily") return r.interval > 1 ? ("Har " + r.interval + " kunda") : "Har kuni";
  if (r.freq === "weekly") {
    var days = (r.weekdays && r.weekdays.length ? r.weekdays : [taskWeekdayOfKey_(task.startKey)])
      .map(function (d) { return weekdayNames[d] || d; }).join(", ");
    return (r.interval > 1 ? ("Har " + r.interval + " haftada: ") : "Har hafta: ") + days;
  }
  if (r.freq === "monthly") {
    var day = r.monthDay === "last" ? "oxirgi kuni" : (r.monthDay + "-kuni");
    return (r.interval > 1 ? ("Har " + r.interval + " oyda ") : "Har oy ") + day;
  }
  if (r.freq === "custom") return "Har " + r.intervalDays + " kunda";
  return "";
}

// ----- apps-script/18_tasks_service.gs -----------------------------------------

// ============================================================
// Tasks — Telegram namespace
// ------------------------------------------------------------
// Task messages and callbacks are handled in complete isolation from the
// private `/yangi` accounting flow:
//
//   * `/yangi` only ever runs in a PRIVATE chat with the single authorized
//     user; this handler only ever acts on the configured Tasks GROUP.
//   * Task callbacks use their own `t_done:` namespace, distinct from the
//     `bot_type:`/`bot_ten:`/`bot_curr:` accounting callbacks.
//   * A task callback never writes a financial record, and an accounting
//     update never reaches this handler.
//
// Completion is gated by the webhook secret (checked in doPost) and by the
// callback originating in the configured Tasks group. Anyone in that group may
// press the button; who pressed it is recorded.
// ============================================================

var TASK_CALLBACK_PREFIX = "t_";
var TASK_DONE_CALLBACK = "t_done:";
var TASK_DONE_BUTTON_TEXT = "✅ Ish bajarildi";

function taskDoneMarkup_(occurrenceId) {
  return { inline_keyboard: [[{ text: TASK_DONE_BUTTON_TEXT, callback_data: TASK_DONE_CALLBACK + occurrenceId }]] };
}

function taskClearedMarkup_() {
  return { inline_keyboard: [] };
}

function taskPriorityEmoji_(priority) {
  if (priority === "urgent") return "🔴";
  if (priority === "high") return "🟠";
  if (priority === "low") return "⚪️";
  return "🔵";
}

function taskDisplayName_(from) {
  if (!from) return "Noma'lum";
  var name = [from.first_name, from.last_name].filter(function (p) { return p; }).join(" ").trim();
  if (name) return name;
  if (from.username) return "@" + from.username;
  return String(from.id || "Noma'lum");
}

// --------------------------------------------------------- message building
//
// Every task card is sent with parse_mode HTML, so a long description can use
// Telegram's expandable blockquote. That means EVERY interpolated value has to
// go through escapeTelegramHtml_ - a task titled "Ali & Vali <test>" would
// otherwise make Telegram reject the whole send with a 400.

// A description shorter than this reads better as a plain line than as a
// collapsed quote nobody bothers to open.
var TASK_CARD_DESC_INLINE_MAX = 150;
// Matches the description cap in normalizeTaskInput_.
var TASK_CARD_DESC_MAX_CHARS = 2000;
// Descending budgets tried when the assembled card would overflow.
var TASK_CARD_DESC_BUDGETS = [TASK_CARD_DESC_MAX_CHARS, 900, 400, 180];

/** Clips raw text to `budget` characters, preferring a word boundary. */
function clipTaskText_(text, budget) {
  var raw = String(text === null || text === undefined ? "" : text).trim();
  if (raw.length <= budget) return raw;
  var cut = raw.slice(0, budget);
  var atWord = cut.replace(/\s+\S*$/, "");
  // A single unbroken word has no boundary to fall back to.
  return (atWord.length > budget * 0.6 ? atWord : cut) + "…";
}

/**
 * The description block of a card, as HTML.
 *
 * Long descriptions go into an expandable blockquote: the card stays scannable
 * in a busy group and the full text is one tap away, collapsed by Telegram
 * itself rather than truncated by us.
 *
 * The budget is applied to the RAW text, before escaping. Escaping can multiply
 * length ("&" becomes "&amp;"), and clipping already-escaped HTML risks cutting
 * an entity - or a tag - in half, which Telegram rejects outright.
 */
function taskCardDescriptionBlock_(description, budget) {
  var limit = budget === undefined ? TASK_CARD_DESC_MAX_CHARS : budget;
  var clipped = clipTaskText_(description, limit);
  if (!clipped) return "";
  var safe = escapeTelegramHtml_(clipped);
  if (clipped.length <= TASK_CARD_DESC_INLINE_MAX) return "📝 " + safe;
  return "<blockquote expandable>" + safe + "</blockquote>";
}

/**
 * Appends the description to a card, shrinking it until the whole message fits
 * inside Telegram's limit. A description that cannot be made to fit is dropped
 * entirely rather than cut mid-tag.
 */
function withTaskDescription_(headLines, description) {
  var head = headLines.join("\n");
  for (var i = 0; i < TASK_CARD_DESC_BUDGETS.length; i++) {
    var block = taskCardDescriptionBlock_(description, TASK_CARD_DESC_BUDGETS[i]);
    if (!block) return head;
    var text = head + "\n" + block;
    if (text.length <= TELEGRAM_MAX_TEXT_LENGTH) return text;
  }
  return head;
}

/** The task title, bounded and escaped, whatever the sheet actually holds. */
function taskCardTitle_(title) {
  return escapeTelegramHtml_(clipTaskText_(title, 200));
}

function buildTaskCardBody_(occ) {
  var lines = [];
  lines.push("👤 Mas'ul: " + escapeTelegramHtml_(clipTaskText_(occ.responsible, 200) || "—"));
  if (occ.dueAt !== "" && isFinite(occ.dueAt)) {
    lines.push("📅 Muddat: " + formatTaskInstant_(occ.dueAt));
  } else if (occ.dateKey) {
    lines.push("📅 Sana: " + formatTaskDateKey_(occ.dateKey));
  } else {
    lines.push("📅 Muddat: belgilanmagan");
  }
  lines.push("📷 Rasm tasdiqi: " + (occ.photoRequired ? "Ha" : "Yo'q"));
  return lines.join("\n");
}

/** The message posted when a task/occurrence first appears in the group. */
function buildTaskOccurrenceMessage_(occ, description) {
  return withTaskDescription_([
    "🆕 " + taskPriorityEmoji_(occ.priority) + " Yangi vazifa",
    "",
    "📌 " + taskCardTitle_(occ.title),
    buildTaskCardBody_(occ)
  ], description);
}

/** The message posted as a reminder for an open occurrence. */
function buildTaskReminderMessage_(occ, description) {
  return withTaskDescription_([
    "🔔 " + taskPriorityEmoji_(occ.priority) + " Eslatma",
    "",
    "📌 " + taskCardTitle_(occ.title),
    buildTaskCardBody_(occ)
  ], description);
}

/**
 * The message an occurrence's card is edited into once it reaches an end state.
 *
 * No description here: a finished card is about the outcome - who did it, when,
 * and whether it was on time - not about the brief.
 *
 * Every value is escaped and length-bounded, so this is always valid HTML and
 * always well inside the limit; there is deliberately no slice() on the result,
 * because slicing assembled HTML is what cuts a tag in half.
 */
function buildTaskStatusMessage_(occ, nowMs, description) {
  var display = occurrenceDisplayStatus_(occ, nowMs === undefined ? Date.now() : nowMs);
  var title = taskCardTitle_(occ.title);
  var who = escapeTelegramHtml_(clipTaskText_(occ.completedByName, 200) || "—");

  if (occ.status === TASK_STATUS_COMPLETED) {
    var lines = ["✅ Bajarildi", "", "📌 " + title];
    lines.push("👤 Bajardi: " + who);
    if (occ.completedAt) lines.push("🕒 " + formatTaskInstant_(Date.parse(occ.completedAt)));
    if (occ.onTime === false && occ.lateMs !== "" && Number(occ.lateMs) > 0) {
      lines.push("⚠️ " + formatTaskDuration_(occ.lateMs) + " kech bajarildi");
    } else if (occ.onTime === true) {
      lines.push("⏱ O'z vaqtida");
    }
    if (occ.proofFileId) lines.push("📷 Rasm bilan tasdiqlangan");
    return lines.join("\n");
  }

  if (occ.status === TASK_STATUS_WAITING) {
    return ["⏳ Rasm kutilmoqda", "", "📌 " + title,
      "👤 " + who + " bajarildi deb belgiladi.",
      "📷 Tasdiqlash uchun rasm yuboring."].join("\n");
  }

  if (occ.status === TASK_STATUS_CANCELLED) {
    return ["🚫 Bekor qilindi", "", "📌 " + title].join("\n");
  }
  if (occ.status === TASK_STATUS_SKIPPED) {
    return ["⏭ O'tkazib yuborildi", "", "📌 " + title].join("\n");
  }
  // Still open (a reopened card, say): it is a task card again, description included.
  return buildTaskOccurrenceMessage_(occ, description);
}

/**
 * The ForceReply prompt asking one named person for the proof photo.
 *
 * Titles are capped at 200 characters upstream, so nothing here is truncated -
 * slicing an HTML string could cut an entity in half.
 */
function buildTaskProofPromptMessage_(occ, options) {
  var name = escapeTelegramHtml_((options && options.userName) || occ.completedByName || "");
  var id = options && options.userId ? String(options.userId) : "";
  var mention = id ? '<a href="tg://user?id=' + id + '">' + name + '</a>' : name;
  return "📷 " + mention + ", \"" + escapeTelegramHtml_(occ.title) +
    "\" ni tasdiqlash uchun shu xabarga javob (reply) qilib rasm yuboring.";
}

// ------------------------------------------------------------- completion

/**
 * Marks an occurrence complete, recording who, when, whether it was on time,
 * and any photo proof. Remaining reminders stop automatically because the
 * scheduler and the reminder job both act only on still-open occurrences.
 *
 * Returns the updated occurrence object (already persisted).
 */
function completeTaskOccurrence_(doc, occ, options) {
  var opts = options || {};
  var nowMs = opts.nowMs === undefined ? Date.now() : opts.nowMs;

  occ.status = TASK_STATUS_COMPLETED;
  occ.completedById = String(opts.byId || "");
  occ.completedByName = String(opts.byName || "");
  occ.completedAt = new Date(nowMs).toISOString();
  occ.proofAwaitingUserId = "";
  if (opts.proofFileId) occ.proofFileId = String(opts.proofFileId);
  if (opts.proofMsgId) occ.proofMsgId = String(opts.proofMsgId);
  occ.meta = occ.meta || {};
  occ.meta.source = opts.source || "telegram";
  // A stale prompt pointer must not be able to match a later photo.
  occ.meta.proofPromptMsgId = "";

  if (occ.dueAt !== "" && isFinite(occ.dueAt)) {
    if (nowMs > occ.dueAt) { occ.onTime = false; occ.lateMs = nowMs - occ.dueAt; }
    else { occ.onTime = true; occ.lateMs = 0; }
  } else {
    occ.onTime = true; occ.lateMs = "";
  }

  writeOccurrenceRow_(doc, occ);
  appendAuditRow_(doc, "task_occurrence_completed",
    occ.id + " by:" + (occ.completedByName || occ.completedById) + " onTime:" + occ.onTime);

  // Keep the group message current instead of posting a duplicate.
  if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });

  // Goals derive their progress from their step occurrences.
  if (occ.taskType === "goal") maybeCompleteGoal_(doc, occ.taskId, nowMs);

  return occ;
}

/** Completes the parent goal when every one of its steps is done. */
function maybeCompleteGoal_(doc, taskId, nowMs) {
  var task = findTask_(doc, taskId);
  if (!task || task.type !== "goal" || task.status === TASK_DEF_COMPLETED) return;
  var progress = goalProgress_(occurrencesForTask_(readOccurrenceRows_(doc), taskId));
  if (progress.total > 0 && progress.done >= progress.total) {
    task.status = TASK_DEF_COMPLETED;
    task.updatedAt = new Date(nowMs).toISOString();
    updateTaskRow_(doc, task);
    appendAuditRow_(doc, "task_goal_completed", taskId);
    var chatId = getTasksGroupChatId_();
    if (chatId) {
      try {
        sendTelegramMessage_(chatId, "🎯 Maqsad bajarildi: " + task.title + " (100%)");
      } catch (error) {
        debugLog_(doc, "task_goal_notify_failed", String(error));
      }
    }
  }
}

// --------------------------------------------------------- update routing

/**
 * True when a Telegram update belongs to the task namespace and must be
 * handled here instead of by the accounting `/yangi` flow. Deliberately
 * narrow: task callbacks, and photo/reply messages inside the Tasks group.
 */
function isTaskTelegramUpdate_(update) {
  if (!update) return false;
  if (update.callback_query) {
    return String(update.callback_query.data || "").indexOf(TASK_CALLBACK_PREFIX) === 0;
  }
  var message = update.message;
  if (!message) return false;
  var tasksGroup = getTasksGroupChatId_();
  if (!tasksGroup) return false;
  if (String(message.chat && message.chat.id) !== String(tasksGroup)) return false;
  return !!(message.photo || message.reply_to_message);
}

function handleTaskTelegramUpdate_(update, doc, configSheet) {
  try {
    if (update.callback_query) {
      handleTaskCallback_(update.callback_query, doc);
    } else if (update.message) {
      handleTaskGroupMessage_(update.message, doc);
    }
    // Best-effort: reflect the change on the group message promptly. Never
    // throws into the webhook response — Telegram must always get a 200.
    drainJobQueueQuietly_(doc, null);
  } catch (error) {
    debugLog_(doc, "task_update_error", String(error));
  }
  return okHtmlOutput_();
}

function handleTaskCallback_(callback, doc) {
  var data = String(callback.data || "");
  if (data.indexOf(TASK_DONE_CALLBACK) !== 0) {
    // isTaskTelegramUpdate_ claims the whole `t_` namespace before any chat or
    // user check runs, so this is the one branch reachable by anybody at all.
    // Refuse it explicitly rather than answering it as though it were a button
    // this bot offers — nothing but t_done: is ever sent.
    answerCallbackQuery_(callback.id, "Bu tugma bu yerda ishlamaydi.");
    return;
  }

  var tasksGroup = getTasksGroupChatId_();
  var chatId = callback.message && callback.message.chat ? callback.message.chat.id : "";
  // Isolation gate: task completions only count inside the configured group.
  if (!tasksGroup || String(chatId) !== String(tasksGroup)) {
    answerCallbackQuery_(callback.id, "Bu tugma bu yerda ishlamaydi.");
    return;
  }

  var occurrenceId = data.slice(TASK_DONE_CALLBACK.length);
  var occ = findOccurrence_(doc, occurrenceId);
  if (!occ) { answerCallbackQuery_(callback.id, "Vazifa topilmadi."); return; }
  if (occ.status === TASK_STATUS_COMPLETED) { answerCallbackQuery_(callback.id, "Allaqachon bajarilgan."); return; }
  if (occ.status === TASK_STATUS_CANCELLED) { answerCallbackQuery_(callback.id, "Bu vazifa bekor qilingan."); return; }
  if (occ.status === TASK_STATUS_SKIPPED) { answerCallbackQuery_(callback.id, "Bu vazifa o'tkazib yuborilgan."); return; }

  var from = callback.from || {};

  if (occ.status === TASK_STATUS_WAITING) {
    // The proof is somebody's to deliver. A second presser must not be able to
    // take the task from them, or to overwrite who is recorded as doing it.
    if (String(occ.proofAwaitingUserId) === String(from.id)) {
      enqueueTaskJob_(doc, "task_proof_prompt", occ.id, {
        occurrenceId: occ.id, userId: String(from.id), userName: taskDisplayName_(from)
      });
      answerCallbackQuery_(callback.id, "📷 Rasm kutilmoqda — so'ralgan xabarga javob qiling.");
    } else {
      answerCallbackQuery_(callback.id,
        (occ.completedByName || "Boshqa foydalanuvchi") + " tasdiqlamoqda.");
    }
    return;
  }

  if (occ.photoRequired) {
    occ.status = TASK_STATUS_WAITING;
    occ.proofAwaitingUserId = String(from.id || "");
    occ.completedByName = taskDisplayName_(from);   // provisional; confirmed on proof
    occ.meta = occ.meta || {};
    occ.meta.proofPromptMsgId = "";
    occ.meta.proofRequestedAt = new Date().toISOString();
    writeOccurrenceRow_(doc, occ);

    enqueueTaskJob_(doc, "task_proof_prompt", occ.id, {
      occurrenceId: occ.id, userId: String(from.id || ""), userName: taskDisplayName_(from)
    });
    answerCallbackQuery_(callback.id, "📷 Iltimos, so'ralgan xabarga rasm bilan javob bering.");
    if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
    return;
  }

  completeTaskOccurrence_(doc, occ, {
    byId: from.id, byName: taskDisplayName_(from), source: "telegram"
  });
  answerCallbackQuery_(callback.id, "✅ Bajarildi.");
}

/**
 * A photo in the Tasks group.
 *
 * Proof is only proof of the thing that was asked for: the photo has to be a
 * reply to that occurrence's prompt (or to its card), and it has to come from
 * the person who claimed it. Guessing "probably their most recent pending
 * task" is how an unrelated photo silently completed the wrong job.
 */
function handleTaskGroupMessage_(message, doc) {
  if (!message.photo || !message.photo.length) return;
  var from = message.from || {};
  var replyTo = message.reply_to_message ? String(message.reply_to_message.message_id) : "";

  var pendingForUser = 0;
  var target = null;
  var claimedByOther = null;
  var rows = readOccurrenceRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.status !== TASK_STATUS_WAITING) continue;
    if (String(occ.proofAwaitingUserId) === String(from.id)) pendingForUser++;
    if (!replyTo) continue;
    var meta = occ.meta || {};
    var answersThis = String(meta.proofPromptMsgId || "") === replyTo || String(occ.msgId || "") === replyTo;
    if (!answersThis) continue;
    if (String(occ.proofAwaitingUserId) === String(from.id)) target = occ;
    else claimedByOther = occ;
  }

  if (!target) {
    if (claimedByOther) {
      trySendTaskGroupMessage_(doc, "⚠️ Bu vazifani " +
        (claimedByOther.completedByName || "boshqa foydalanuvchi") + " tasdiqlamoqda.");
    } else if (pendingForUser > 0) {
      trySendTaskGroupMessage_(doc,
        "⚠️ Rasmni qabul qilish uchun so'ralgan xabarga javob (reply) qilib yuboring.");
    }
    return;   // an unrelated photo is just a photo
  }

  var largest = message.photo[message.photo.length - 1] || {};
  completeTaskOccurrence_(doc, target, {
    byId: from.id,
    byName: taskDisplayName_(from),
    source: "telegram",
    proofFileId: largest.file_id || "",
    proofMsgId: message.message_id
  });
  trySendTaskGroupMessage_(doc, "✅ Rasm qabul qilindi — \"" + target.title + "\" bajarildi.");
}

/** Group chatter is never worth failing a webhook over. */
function trySendTaskGroupMessage_(doc, text) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) return;
  try {
    sendTelegramMessage_(chatId, text);
  } catch (error) {
    debugLog_(doc, "task_group_notice_failed", String(error));
  }
}

// ----- apps-script/19_tasks_scheduler.gs ---------------------------------------

// ============================================================
// Tasks — scheduler, jobs and web API
// ------------------------------------------------------------
// Reuses the existing Omad_Job_Queue for every Telegram send, so a task
// message inherits the same claim-under-lock, exponential backoff and
// deduplication as the accounting reports. The scheduler only ever *decides*
// what is due and enqueues it; the queue does the sending.
//
// Duplicate protection is layered:
//   * a reminder slot is marked sent the moment it is enqueued (under the
//     script lock), so a second scheduler pass — or one that overlaps — cannot
//     enqueue it again, and a completed occurrence never re-fires;
//   * the queue itself refuses a second identical pending job.
//
// That layering is what lets the production trigger do the whole cycle in one
// tick (processPendingTelegramJobs: scan, enqueue, drain) while the manual
// processTaskSchedules entry point stays available: running both, in any order
// and any number of times, cannot produce a second reminder.
// ============================================================

var TASK_REMINDER_MAX_LATE_MS = 3 * 60 * 60 * 1000; // don't blast reminders missed by >3h
var TASK_PROOF_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;  // a claim whose prompt never went out
// How many days of "already reminded" markers a rolling-daily occurrence keeps.
// Long enough that nothing the scheduler still consults can be dropped, short
// enough that Reminders_Sent_JSON stays far inside one spreadsheet cell.
var TASK_REMINDER_HISTORY_DAYS = 14;

function enqueueTaskJob_(doc, type, relatedId, payload) {
  return enqueueJob_(doc, type, relatedId, payload || {});
}

function isTaskJobType_(type) {
  return type === "task_notify" || type === "task_reminder" ||
    type === "task_update_message" || type === "task_proof_prompt";
}

function runTaskJob_(doc, job) {
  if (job.type === "task_notify") return runTaskNotifyJob_(doc, job);
  if (job.type === "task_reminder") return runTaskReminderJob_(doc, job);
  if (job.type === "task_update_message") return runTaskUpdateMessageJob_(doc, job);
  if (job.type === "task_proof_prompt") return runTaskProofPromptJob_(doc, job);
  throw new Error("Unknown task job type: " + job.type);
}

/**
 * Asks the user who claimed a photo-proof task to reply with the photo.
 *
 * ForceReply with `selective` plus a mention targets exactly that person, so
 * the reply the group is asked for is unambiguous and the photo that comes
 * back can be matched to this prompt and no other. Sending it as a job means a
 * Telegram outage retries with the queue's backoff instead of leaving the
 * occurrence waiting for a message that was never delivered.
 */
function runTaskProofPromptJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ) return;
  if (occ.status !== TASK_STATUS_WAITING) return;                                  // already resolved
  if (String(occ.proofAwaitingUserId) !== String(job.payload.userId || "")) return; // superseded

  var sent = sendTelegramMessage_(
    chatId,
    buildTaskProofPromptMessage_(occ, job.payload),
    { force_reply: true, selective: true },
    "HTML",
    { replyToMessageId: occ.msgId }
  );
  var promptId = extractTelegramMessageId_(sent);
  if (promptId) {
    occ.meta = occ.meta || {};
    occ.meta.proofPromptMsgId = String(promptId);
    writeOccurrenceRow_(doc, occ);
  }
}

/**
 * Puts an occurrence back the way it was when the prompt asking for its photo
 * could not be delivered. Waiting for a photo nobody was ever asked for is a
 * lie the group cannot act on.
 */
function releaseStuckProofPrompt_(doc, job) {
  var occ = findOccurrence_(doc, String((job.payload || {}).occurrenceId || ""));
  if (!occ || occ.status !== TASK_STATUS_WAITING) return;
  if (occ.meta && occ.meta.proofPromptMsgId) return;   // it did go out
  occ.status = TASK_STATUS_OPEN;
  occ.proofAwaitingUserId = "";
  occ.completedByName = "";
  occ.meta = occ.meta || {};
  occ.meta.proofPromptMsgId = "";
  occ.meta.proofRequestedAt = "";
  writeOccurrenceRow_(doc, occ);
  appendAuditRow_(doc, "task_proof_prompt_released", occ.id);
  if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
}

function runTaskNotifyJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ) return; // deleted before it went out

  // The definition can be paused between enqueue and send; the queue must not
  // deliver a message the admin has already stopped.
  var notifyTask = findTask_(doc, occ.taskId);
  if (notifyTask && (notifyTask.status === TASK_DEF_PAUSED || notifyTask.status === TASK_DEF_CANCELLED)) return;

  // The card carries the task's brief; the lookup above already has it, so this
  // costs nothing extra. Cards are HTML so a long description can be collapsed.
  var notifyDescription = notifyTask ? notifyTask.description : "";

  // If it already reached an end state before the card was sent, send the
  // status card (no button) rather than a stale "new task" with a live button.
  if (occ.status !== TASK_STATUS_OPEN) {
    var response = sendTelegramMessage_(chatId,
      buildTaskStatusMessage_(occ, Date.now(), notifyDescription), taskClearedMarkup_(), "HTML");
    var doneId = extractTelegramMessageId_(response);
    if (doneId && !occ.msgId) { occ.msgId = String(doneId); writeOccurrenceRow_(doc, occ); }
    return;
  }

  var sent = sendTelegramMessage_(chatId,
    buildTaskOccurrenceMessage_(occ, notifyDescription), taskDoneMarkup_(occ.id), "HTML");
  var msgId = extractTelegramMessageId_(sent);
  if (msgId) { occ.msgId = String(msgId); writeOccurrenceRow_(doc, occ); }
}

function runTaskReminderJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ) return;
  // Completion (or cancellation/skip) between enqueue and send stops the ping.
  if (occ.status !== TASK_STATUS_OPEN) return;

  // The definition can be paused between enqueue and send; the queue must not
  // deliver a message the admin has already stopped.
  var remindTask = findTask_(doc, occ.taskId);
  if (remindTask && (remindTask.status === TASK_DEF_PAUSED || remindTask.status === TASK_DEF_CANCELLED)) return;

  sendTelegramMessage_(chatId,
    buildTaskReminderMessage_(occ, remindTask ? remindTask.description : ""),
    taskDoneMarkup_(occ.id), "HTML");
}

function runTaskUpdateMessageJob_(doc, job) {
  var chatId = getTasksGroupChatId_();
  if (!chatId) throw new Error("Telegram Tasks group ID o'rnatilmagan.");
  var occ = findOccurrence_(doc, String(job.payload.occurrenceId || ""));
  if (!occ || !occ.msgId) return;

  // The button is live only while the task is genuinely open. While a proof is
  // pending it belongs to one person, and pressing it again is not how they
  // deliver it.
  var showButton = occ.status === TASK_STATUS_OPEN;
  // Matches the parse mode the card was first sent with; an edit that dropped
  // HTML would show the markup as literal text.
  var updateTask = findTask_(doc, occ.taskId);
  editTelegramMessage_(chatId, occ.msgId,
    buildTaskStatusMessage_(occ, Date.now(), updateTask ? updateTask.description : ""),
    showButton ? taskDoneMarkup_(occ.id) : taskClearedMarkup_(), "HTML");
}

// ---------------------------------------------------------------- scheduler

/**
 * Whether the scheduler may still speak for a task. A paused routine must not
 * announce or remind - not even for the occurrences that were already
 * materialised on to the sheet before it was paused - and an occurrence whose
 * definition has gone is not something to keep pinging a group about.
 */
function isTaskSendable_(taskStatus) {
  return taskStatus === TASK_DEF_ACTIVE;
}

/** True when any reminder slot has already been acted on for this occurrence. */
function hasAnyReminderSent_(occ) {
  var sent = occ.remindersSent || {};
  for (var key in sent) if (Object.prototype.hasOwnProperty.call(sent, key)) return true;
  return false;
}

/**
 * Whether an occurrence's reminder times roll forward day by day rather than
 * belonging to one fixed calendar day.
 *
 * Two things roll: a one-time task the admin asked to be reminded about daily
 * ("har kuni, vazifa bajarilguncha"), and anything with no date at all — a
 * goal step, or a deadline-less one-time task. A routine does not: each of its
 * days is a separate occurrence that owns its own reminders, so rolling them
 * would mean reminding about Monday's work on Tuesday.
 */
function taskRemindsDaily_(occ) {
  return !!occ.remindDaily && (occ.taskType === "once" || !occ.dateKey);
}

/**
 * Which reminder dates apply to an occurrence right now.
 *
 * A rolling occurrence is always reminded about *today* — whether its deadline
 * is still days away, is today, or went past weeks ago — and stops the moment
 * the occurrence leaves Open. On the deadline day today's key *is* the
 * occurrence's dateKey, so it resolves to the same slot either way and the
 * sent-marker still deduplicates it.
 *
 * Everything else keeps a single fixed day: the routine's day, or the one-time
 * task's deadline when daily reminders were not asked for.
 */
function taskReminderDatesFor_(occ, todayKey) {
  if (taskRemindsDaily_(occ)) return [todayKey];
  if (occ.dateKey) return [occ.dateKey];       // routine day / one-time deadline day
  return [];
}

/**
 * Drops sent-markers for days the scheduler will never look at again.
 *
 * A rolling occurrence writes one marker per reminder time per day for as long
 * as it stays open, and `Reminders_Sent_JSON` is a single spreadsheet cell. Only
 * days older than the retention window are dropped, and never the occurrence's
 * own dateKey, so no marker that is still consulted can be removed and no
 * reminder can be revived by pruning.
 */
function pruneReminderMarkers_(occ, todayKey) {
  var cutoff = taskDateKeyAddDays_(todayKey, -TASK_REMINDER_HISTORY_DAYS);
  if (!cutoff) return false;
  var sent = occ.remindersSent || {};
  var dropped = false;
  for (var slotKey in sent) {
    if (!Object.prototype.hasOwnProperty.call(sent, slotKey)) continue;
    var dateKey = slotKey.split(" ")[0];
    if (dateKey === occ.dateKey || dateKey >= cutoff) continue;
    delete sent[slotKey];
    dropped = true;
  }
  return dropped;
}

/**
 * The full scheduler pass: materialise due occurrences, announce new ones and
 * fire any reminders that have come due. Everything mutating runs under the
 * script lock so two passes cannot double-send.
 */
function runTaskScheduler_(doc, nowMs) {
  var now = nowMs === undefined ? Date.now() : nowMs;
  var todayKey = taskTodayKey_(now);

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (error) { return { notified: 0, reminders: 0, generated: 0 }; }

  var generated = 0;
  var notified = 0;
  var reminders = 0;
  try {
    var tasks = readTaskRows_(doc);
    var statusByTaskId = {};
    for (var t = 0; t < tasks.length; t++) statusByTaskId[tasks[t].id] = tasks[t].status;

    // One scan of the occurrence sheet for the whole pass, and one append for
    // everything it decides to create. A daily routine used to cost a full
    // scan per task, every five minutes, for ever.
    var ctx = { occurrences: readOccurrenceRows_(doc), pending: [] };
    for (var g = 0; g < tasks.length; g++) {
      if (tasks[g].status === TASK_DEF_ACTIVE) {
        generated += materializeTaskOccurrences_(doc, tasks[g], now, ctx).length;
      }
    }
    if (ctx.pending.length) appendOccurrenceRows_(doc, ctx.pending);

    // Includes what was just appended, with the row numbers assigned to those
    // very objects - so a writeOccurrenceRow_ later in this pass lands on the
    // right row.
    var occurrences = ctx.occurrences;
    for (var i = 0; i < occurrences.length; i++) {
      var occ = occurrences[i];

      // A paused (or cancelled, or orphaned) definition goes quiet immediately,
      // including for occurrences that were materialised before the pause.
      if (!isTaskSendable_(statusByTaskId[occ.taskId])) continue;

      // Backstop: a claim whose prompt never made it out, and whose job is gone
      // (queue row purged, script killed mid-flight). 30 minutes is comfortably
      // past the queue's own retry ladder, so this never races it.
      if (occ.status === TASK_STATUS_WAITING && !(occ.meta && occ.meta.proofPromptMsgId)) {
        var requestedAt = Date.parse((occ.meta && occ.meta.proofRequestedAt) || "") || 0;
        if (requestedAt && now - requestedAt > TASK_PROOF_PROMPT_TIMEOUT_MS) {
          releaseStuckProofPrompt_(doc, { payload: { occurrenceId: occ.id } });
          continue;
        }
      }

      // Announce.
      if (!occ.notifiedAt && occ.status === TASK_STATUS_OPEN) {
        // A goal step and a deadline-less one-time task are the same thing to
        // the group: something to do now, with no date attached.
        var due = occ.taskType === "once" || occ.taskType === "goal" ||
          (occ.dateKey && occ.dateKey <= todayKey);
        if (due) {
          enqueueTaskJob_(doc, "task_notify", occ.id, { occurrenceId: occ.id });
          occ.notifiedAt = new Date(now).toISOString();
          writeOccurrenceRow_(doc, occ);
          notified++;
        }
      }

      // Remind.
      if (occ.status === TASK_STATUS_OPEN && occ.reminderTimes.length) {
        var dates = taskReminderDatesFor_(occ, todayKey);
        // A rolling occurrence accumulates a marker a day; trim the ones no
        // date list will ever name again before adding today's.
        var changed = taskRemindsDaily_(occ) ? pruneReminderMarkers_(occ, todayKey) : false;
        for (var d = 0; d < dates.length; d++) {
          for (var r = 0; r < occ.reminderTimes.length; r++) {
            var slotKey = dates[d] + " " + occ.reminderTimes[r];
            if (occ.remindersSent[slotKey]) continue;
            var instant = taskInstantMs_(dates[d], occ.reminderTimes[r]);
            if (!isFinite(instant) || now < instant) continue;
            if (now - instant <= TASK_REMINDER_MAX_LATE_MS) {
              enqueueTaskJob_(doc, "task_reminder", occ.id, { occurrenceId: occ.id, slot: slotKey });
              reminders++;
            } else {
              debugLog_(doc, "task_reminder_skipped_stale", occ.id + " " + slotKey);
            }
            occ.remindersSent[slotKey] = new Date(now).toISOString();
            changed = true;
          }
        }
        if (changed) writeOccurrenceRow_(doc, occ);
      }
    }
  } finally {
    lock.releaseLock();
  }

  return { notified: notified, reminders: reminders, generated: generated };
}

/**
 * Manual entry point: scan, then drain the queue.
 *
 * Kept for the operator who wants to force a cycle from the editor, and for
 * any trigger created before `processPendingTelegramJobs` absorbed the scan.
 * It is no longer required as a second production trigger, and running it
 * alongside one cannot duplicate anything.
 */
function processTaskSchedules() {
  resetRequestMemos_();
  var doc = SpreadsheetApp.getActiveSpreadsheet();
  runTaskScheduler_(doc, Date.now());
  return processPendingJobs_(doc, JOB_QUEUE_MANUAL_BATCH);
}

// ---------------------------------------------------------------- web API

// The panel does one read per load and one per mutation. Signed-in traffic is
// bounded by AUTHENTICATED_REQUEST_LIMIT, per user; this remains as the
// documented shape of the board's own load.
var TASK_READ_RATE_LIMIT = 30;

/** A task view may be reused for this long; the key also carries the minute. */
var TASK_VIEW_TTL_SECONDS = 90;

function isTaskReadAction_(action) {
  return action === "get_tasks";
}

function isTaskMutationAction_(action) {
  return action === "save_task" || action === "cancel_task" ||
    action === "pause_routine" || action === "resume_routine" ||
    action === "skip_occurrence" || action === "complete_occurrence" ||
    action === "reopen_occurrence";
}

function isTaskAction_(action) {
  return isTaskReadAction_(action) || isTaskMutationAction_(action);
}

function handleTaskAction_(action, payload, doc) {
  // The task board is internal company information: who is responsible for
  // what, when it is due, and who has been missing deadlines. Reads are gated
  // exactly like mutations, and both are omad_admin only. A failed attempt is
  // throttled inside the gate; a signed-in one is not, so a stranger hammering
  // the endpoint can no longer close the board for the person using it.
  var auth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
  if (!auth.ok) return authRefusal_(auth);

  if (isTaskReadAction_(action)) {
    return jsonOutput_({
      status: "success",
      view: cachedTaskView_(doc),
      config: { tasksGroupConfigured: !!getTasksGroupChatId_() }
    });
  }

  return runTaskAction_(action, payload, doc);
}

/**
 * The board view, reused within the minute it was built for.
 *
 * `Overdue` is derived on read from the current time, so the cache key carries
 * the minute as well as the task revision: an entry can be a few seconds stale
 * about the clock and never more, and any write to a task or an occurrence
 * makes it unreachable immediately. The view is rebuilt from the sheets on a
 * miss, so losing the cache costs a sheet pass and nothing else.
 */
function cachedTaskView_(doc) {
  var now = Date.now();
  var minute = Math.floor(now / 60000);
  return cachedSummary_("task_view_" + minute, CACHE_SCOPE_TASKS, TASK_VIEW_TTL_SECONDS, function () {
    return buildTaskViews_(doc, now);
  });
}

/**
 * A task mutation that has already been authorized.
 *
 * Split out so the Mini App can reach exactly this code behind verified
 * Telegram initData instead of the admin key. Everything below the gate — the
 * occurrence bookkeeping, the inline scheduler pass, the group cards — is the
 * same engine for both callers, which is what stops the two surfaces drifting.
 */
function runTaskAction_(action, payload, doc) {
  var result;
  if (action === "save_task") result = saveTaskAction_(doc, payload);
  else if (action === "cancel_task") result = cancelTaskAction_(doc, payload);
  else if (action === "pause_routine") result = setRoutinePausedAction_(doc, payload, true);
  else if (action === "resume_routine") result = setRoutinePausedAction_(doc, payload, false);
  else if (action === "skip_occurrence") result = skipOccurrenceAction_(doc, payload);
  else if (action === "complete_occurrence") result = completeOccurrenceAction_(doc, payload);
  else result = reopenOccurrenceAction_(doc, payload);

  if (result.status === "success") {
    recordLastOperation_(doc, action);
    // Announce/refresh promptly, then let the trigger handle the rest.
    try { runTaskScheduler_(doc, Date.now()); } catch (error) { debugLog_(doc, "task_scheduler_inline_failed", String(error)); }
    drainJobQueueQuietly_(doc, payload);
    result.view = buildTaskViews_(doc, Date.now());
    result.config = { tasksGroupConfigured: !!getTasksGroupChatId_() };
  }
  return jsonOutput_(result);
}

/**
 * Whether the caller actually said anything about a field.
 *
 * The difference between "leave this alone" and "clear this" is the whole
 * safety of an edit. A payload that never mentions `recurrence` is a client
 * editing a title; a payload carrying `recurrence: null` is a client asking
 * for a default. Only the second may overwrite what is stored.
 */
function taskFieldSupplied_(payload, field) {
  return !!payload && Object.prototype.hasOwnProperty.call(payload, field) &&
    payload[field] !== undefined;
}

/** Builds a validated task object from a web payload. Returns {task} or {error}. */
function normalizeTaskInput_(payload, existing) {
  // The type decides which columns mean anything and what an occurrence even
  // is. There is no safe migration from one shape to another - a once-task's
  // single occurrence and a routine's dated history are not interchangeable -
  // so an existing task keeps the type it was created with.
  var type = existing ? existing.type : (TASK_TYPES.indexOf(String(payload.type)) !== -1 ? String(payload.type) : "");
  if (TASK_TYPES.indexOf(type) === -1) return { error: "Vazifa turi noto'g'ri." };

  var title = String(payload.title || (existing ? existing.title : "")).trim();
  if (!title) return { error: "Sarlavha kiritilmagan." };
  if (title.length > 200) return { error: "Sarlavha juda uzun." };

  var nowIso = new Date().toISOString();

  /**
   * Text that can be cleared.
   *
   * `payload.description || existing.description` cannot tell "did not mention
   * it" from "asked for it to be empty", and resolves both to the stored text.
   * So a description or a responsible could be written but never deleted: the
   * field was cleared on the form, the save reported success, and the old
   * value came back on the next render. The schedule fields below already draw
   * this distinction; text was the one place that did not.
   */
  var keptText = function (field, fallback, limit) {
    var value = taskFieldSupplied_(payload, field) ? payload[field] : fallback;
    if (value === null || value === undefined) return "";
    return String(value).slice(0, limit);
  };

  var task = {
    id: existing ? existing.id : ("task_" + Utilities.getUuid().split("-").join("")),
    type: type,
    title: title,
    description: keptText("description", existing ? existing.description : "", 2000),
    responsible: keptText("responsible", existing ? existing.responsible : "", 200),
    priority: normalizeTaskPriority_(payload.priority !== undefined ? payload.priority : (existing ? existing.priority : "normal")),
    photoRequired: payload.photoRequired !== undefined ? !!payload.photoRequired : (existing ? existing.photoRequired : false),
    reminderTimes: normalizeTaskTimes_(payload.reminderTimes !== undefined ? payload.reminderTimes : (existing ? existing.reminderTimes : [])),
    remindDaily: payload.remindDaily !== undefined ? !!payload.remindDaily : (existing ? existing.remindDaily : false),
    dueTime: "",
    deadlineKey: "",
    deadlineTime: "",
    startKey: "",
    endKey: "",
    status: existing ? existing.status : TASK_DEF_ACTIVE,
    steps: [],
    recurrence: {},
    createdAt: existing ? existing.createdAt : nowIso,
    updatedAt: nowIso,
    // Bounded the way 14_ledger.gs already bounds the same concept.
    createdBy: existing ? existing.createdBy : String(payload.createdBy || "admin").slice(0, 120),
    // A new task may carry caller metadata; the Telegram wizard uses it for the
    // durable idempotency key it has no Request_ID column for. An edit keeps
    // whatever the row already had, so the web UI — which sends neither field —
    // behaves exactly as before.
    meta: existing ? existing.meta
      : (payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta) ? payload.meta : {})
  };

  // Schedule fields fall back to what is stored whenever the caller did not
  // mention them. Without this, editing a title through any client that sends
  // only the fields it shows silently rewrote the schedule: a weekly Monday
  // routine came back daily, and a deadline came back empty, because an absent
  // field and a cleared field were treated identically.
  var keep = function (field, fallback) {
    return taskFieldSupplied_(payload, field) ? payload[field] : fallback;
  };

  if (type === "once") {
    var deadlineKey = keep("deadlineKey", existing ? existing.deadlineKey : "");
    var deadlineTime = keep("deadlineTime", existing ? existing.deadlineTime : "");
    if (deadlineKey && !isTaskDateKey_(deadlineKey)) return { error: "Muddat sanasi noto'g'ri." };
    if (deadlineTime && !isTaskTimeKey_(deadlineTime)) return { error: "Muddat vaqti noto'g'ri." };
    task.deadlineKey = isTaskDateKey_(deadlineKey) ? String(deadlineKey) : "";
    task.deadlineTime = isTaskTimeKey_(deadlineTime) ? String(deadlineTime) : "";
  } else if (type === "routine") {
    // An edit that does not mention the cadence keeps the cadence. Sending
    // `recurrence` explicitly still replaces it, so the web editor is
    // unchanged.
    task.recurrence = taskFieldSupplied_(payload, "recurrence")
      ? normalizeTaskRecurrence_(payload.recurrence)
      : (existing && existing.recurrence && existing.recurrence.freq
        ? normalizeTaskRecurrence_(existing.recurrence)
        : normalizeTaskRecurrence_(payload.recurrence));

    task.startKey = isTaskDateKey_(payload.startKey) ? String(payload.startKey) : (existing && existing.startKey ? existing.startKey : taskTodayKey_(Date.now()));

    var endKey = keep("endKey", existing ? existing.endKey : "");
    if (endKey && !isTaskDateKey_(endKey)) return { error: "Tugash sanasi noto'g'ri." };
    task.endKey = isTaskDateKey_(endKey) ? String(endKey) : "";
    if (task.endKey && task.endKey < task.startKey) return { error: "Tugash sanasi boshlanish sanasidan oldin." };

    var dueTime = keep("dueTime", existing ? existing.dueTime : "");
    task.dueTime = isTaskTimeKey_(dueTime) ? String(dueTime) : "";
  } else if (type === "goal") {
    task.steps = taskFieldSupplied_(payload, "steps")
      ? normalizeGoalSteps_(payload.steps)
      : (existing ? (existing.steps || []) : []);
    if (task.steps.length === 0) return { error: "Maqsad uchun kamida bitta qadam kiriting." };
  }

  return { task: task };
}

function saveTaskAction_(doc, payload) {
  var existing = payload.id ? findTask_(doc, payload.id) : null;
  if (payload.id && !existing) return { status: "error", message: "Vazifa topilmadi." };
  if (existing && payload.type && String(payload.type) !== existing.type) {
    return { status: "error", message: "Vazifa turini o'zgartirib bo'lmaydi. Yangi vazifa yarating." };
  }

  var normalized = normalizeTaskInput_(payload, existing);
  if (normalized.error) return { status: "error", message: normalized.error };
  var task = normalized.task;
  var nowMs = Date.now();
  var todayKey = taskTodayKey_(nowMs);
  var previousSteps = existing ? (existing.steps || []) : [];

  if (task.type === "goal") task.steps = mergeGoalSteps_(previousSteps, task.steps);

  if (existing) {
    task.rowNumber = existing.rowNumber;
    updateTaskRow_(doc, task);
    if (task.type === "routine") reconcileRoutineOccurrences_(doc, task, todayKey);
    else if (task.type === "once") reconcileOnceOccurrence_(doc, task);
    else reconcileGoalOccurrences_(doc, task, previousSteps);
    appendAuditRow_(doc, "task_updated", task.id + " " + task.type);
  } else {
    appendTaskRow_(doc, task);
    appendAuditRow_(doc, "task_created", task.id + " " + task.type);
  }

  materializeTaskOccurrences_(doc, task, nowMs);
  // Removing the last unfinished step is a completion just as much as ticking
  // it off is.
  if (task.type === "goal") maybeCompleteGoal_(doc, task.id, nowMs);
  return { status: "success", taskId: task.id };
}

/**
 * Pushes an edited one-time task on to the occurrence that is still live.
 *
 * The occurrence is what people actually see and complete; leaving it on the
 * old deadline, the old owner and the old photo rule is the difference between
 * an edit and a lie. History (completed / cancelled / skipped) is never
 * rewritten.
 */
function reconcileOnceOccurrence_(doc, task) {
  var rows = occurrencesForTask_(readOccurrenceRows_(doc), task.id);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.status === TASK_STATUS_COMPLETED || occ.status === TASK_STATUS_CANCELLED ||
        occ.status === TASK_STATUS_SKIPPED) continue;

    occ.title = task.title;
    occ.responsible = task.responsible || "";
    occ.priority = task.priority || "normal";
    occ.photoRequired = !!task.photoRequired;
    occ.reminderTimes = task.reminderTimes || [];
    occ.remindDaily = !!task.remindDaily;
    occ.dateKey = task.deadlineKey || "";
    occ.dueAt = task.deadlineKey ? taskInstantMs_(task.deadlineKey, task.deadlineTime || "23:59") : "";
    writeOccurrenceRow_(doc, occ);
    if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
  }
}

/**
 * Pairs the submitted step list with the steps that already exist, so an
 * occurrence keeps belonging to the same piece of work across an edit.
 *
 * Matching order matters:
 *   1. an id the client sent back - unambiguous;
 *   2. an unchanged title - survives inserting or deleting a step in the middle,
 *      which position alone cannot;
 *   3. the same position - which is what a plain rename looks like once the
 *      unchanged titles have been claimed;
 *   4. anything still unmatched is genuinely new and gets a fresh id.
 */
function mergeGoalSteps_(existingSteps, incomingSteps) {
  var existing = Array.isArray(existingSteps) ? existingSteps : [];
  var incoming = Array.isArray(incomingSteps) ? incomingSteps : [];
  var byId = {};
  var used = {};
  for (var e = 0; e < existing.length; e++) if (existing[e].id) byId[existing[e].id] = existing[e];

  var out = new Array(incoming.length);
  var pending = [];

  for (var i = 0; i < incoming.length; i++) {
    var id = incoming[i].id;
    if (id && byId[id] && !used[id]) { used[id] = true; out[i] = { id: id }; }
    else pending.push(i);
  }
  for (var t = 0; t < pending.length; t++) {
    var ti = pending[t];
    for (var x = 0; x < existing.length; x++) {
      if (!existing[x].id || used[existing[x].id]) continue;
      if (existing[x].title === incoming[ti].title) { used[existing[x].id] = true; out[ti] = { id: existing[x].id }; break; }
    }
  }
  for (var p = 0; p < pending.length; p++) {
    var pi = pending[p];
    if (out[pi]) continue;
    var atPosition = existing[pi];
    if (atPosition && atPosition.id && !used[atPosition.id]) { used[atPosition.id] = true; out[pi] = { id: atPosition.id }; }
  }
  for (var n = 0; n < out.length; n++) {
    if (!out[n]) out[n] = { id: newGoalStepId_() };
    out[n].title = incoming[n].title;
    if (incoming[n].photoRequired !== undefined) out[n].photoRequired = incoming[n].photoRequired;
  }
  return out;
}

/**
 * Re-points a goal's step-occurrences at the edited step list.
 *
 * Completed work is never deleted or re-scored: a step that disappears keeps
 * its row (and its proof, and who did it) and is simply taken out of the
 * goal's progress. An unfinished step that disappears is cancelled, so the
 * group card is withdrawn rather than left hanging.
 */
function reconcileGoalOccurrences_(doc, task, previousSteps) {
  var rows = occurrencesForTask_(readOccurrenceRows_(doc), task.id);
  var idByOldIndex = {};
  for (var p = 0; p < previousSteps.length; p++) idByOldIndex[p] = previousSteps[p].id || "";
  var newIndexById = {};
  for (var n = 0; n < task.steps.length; n++) newIndexById[task.steps[n].id] = n;

  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.stepIndex === "") continue;
    occ.meta = occ.meta || {};
    var stepId = occ.meta.stepId || idByOldIndex[Number(occ.stepIndex)] || "";
    var newIndex = (stepId && newIndexById[stepId] !== undefined) ? newIndexById[stepId] : undefined;

    if (newIndex === undefined) {
      occ.meta.removedStep = true;
      if (occ.status === TASK_STATUS_OPEN || occ.status === TASK_STATUS_WAITING) {
        occ.status = TASK_STATUS_CANCELLED;
        occ.proofAwaitingUserId = "";
      }
      writeOccurrenceRow_(doc, occ);
      if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
      continue;
    }

    var step = task.steps[newIndex];
    occ.meta.stepId = step.id;
    delete occ.meta.removedStep;
    occ.stepIndex = newIndex;
    occ.title = goalStepTitle_(task, step, newIndex);
    if (occ.status !== TASK_STATUS_COMPLETED) {
      occ.responsible = task.responsible || "";
      occ.priority = task.priority || "normal";
      occ.photoRequired = effectiveStepPhotoRequired_(task, step);
      occ.reminderTimes = task.reminderTimes || [];
      occ.remindDaily = goalRemindDaily_(task);
    }
    writeOccurrenceRow_(doc, occ);
    if (occ.msgId && occ.status === TASK_STATUS_OPEN) {
      enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
    }
  }
}

/**
 * Re-plans a routine after an edit.
 *
 * Anything from today forward that nobody has seen is replaced outright, so a
 * changed cadence, owner or due time takes effect. Anything already announced
 * is history in progress: its fields are refreshed in place, and it is only
 * withdrawn when the new schedule no longer contains its day.
 */
function reconcileRoutineOccurrences_(doc, task, todayKey) {
  deleteOccurrenceRowsWhere_(doc, function (occ) {
    return occ.taskId === String(task.id) &&
      occ.status === TASK_STATUS_OPEN &&
      !occ.notifiedAt && !occ.msgId && !hasAnyReminderSent_(occ) &&
      occ.dateKey && occ.dateKey >= todayKey;
  });

  var rows = occurrencesForTask_(readOccurrenceRows_(doc), task.id);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (!occ.dateKey || occ.dateKey < todayKey) continue;   // the past is history
    if (occ.status !== TASK_STATUS_OPEN) continue;          // waiting/done/skipped stay put

    if (!routineOccursOnKey_(task.recurrence, task.startKey, task.endKey, occ.dateKey)) {
      occ.status = TASK_STATUS_CANCELLED;
      writeOccurrenceRow_(doc, occ);
      if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
      continue;
    }

    occ.title = task.title;
    occ.responsible = task.responsible || "";
    occ.priority = task.priority || "normal";
    occ.photoRequired = !!task.photoRequired;
    occ.reminderTimes = task.reminderTimes || [];
    occ.remindDaily = !!task.remindDaily;
    occ.dueAt = task.dueTime ? taskInstantMs_(occ.dateKey, task.dueTime) : "";
    writeOccurrenceRow_(doc, occ);
    if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
  }
}

/** Removes upcoming routine occurrences that have neither been sent nor acted on. */
function pruneReplaceableRoutineOccurrences_(doc, taskId, todayKey) {
  deleteOccurrenceRowsWhere_(doc, function (occ) {
    return occ.taskId === String(taskId) &&
      occ.status === TASK_STATUS_OPEN &&
      !occ.notifiedAt && !occ.msgId && !hasAnyReminderSent_(occ) &&
      occ.dateKey && occ.dateKey > todayKey;
  });
}

function deleteOccurrenceRowsWhere_(doc, predicate) {
  var sheet = doc.getSheetByName(TASK_OCCURRENCES_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var rows = readOccurrenceRows_(doc);
  var toDelete = [];
  for (var i = 0; i < rows.length; i++) if (predicate(rows[i])) toDelete.push(rows[i].rowNumber);
  toDelete.sort(function (a, b) { return b - a; }); // bottom-up so row numbers stay valid
  for (var d = 0; d < toDelete.length; d++) sheet.deleteRow(toDelete[d]);
  return toDelete.length;
}

function cancelTaskAction_(doc, payload) {
  var task = findTask_(doc, payload.id);
  if (!task) return { status: "error", message: "Vazifa topilmadi." };
  task.status = TASK_DEF_CANCELLED;
  task.updatedAt = new Date().toISOString();
  updateTaskRow_(doc, task);

  var rows = occurrencesForTask_(readOccurrenceRows_(doc), task.id);
  for (var i = 0; i < rows.length; i++) {
    var occ = rows[i];
    if (occ.status === TASK_STATUS_OPEN || occ.status === TASK_STATUS_WAITING) {
      occ.status = TASK_STATUS_CANCELLED;
      writeOccurrenceRow_(doc, occ);
      if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
    }
  }
  appendAuditRow_(doc, "task_cancelled", task.id);
  return { status: "success" };
}

function setRoutinePausedAction_(doc, payload, paused) {
  var task = findTask_(doc, payload.id);
  if (!task) return { status: "error", message: "Vazifa topilmadi." };
  if (task.type !== "routine") return { status: "error", message: "Faqat takrorlanuvchi vazifani to'xtatish mumkin." };
  if (task.status === TASK_DEF_CANCELLED) return { status: "error", message: "Bekor qilingan vazifa." };
  task.status = paused ? TASK_DEF_PAUSED : TASK_DEF_ACTIVE;
  task.updatedAt = new Date().toISOString();
  updateTaskRow_(doc, task);

  if (paused) {
    // Pre-generated days nobody has seen are not history; leaving them on the
    // sheet would keep a paused routine visible in "Kelgusi" and would revive
    // it the moment the guard is bypassed. Announced days, completed days and
    // skipped days are history and stay exactly as they are.
    pruneReplaceableRoutineOccurrences_(doc, task.id, taskTodayKey_(Date.now()));
  }

  appendAuditRow_(doc, paused ? "routine_paused" : "routine_resumed", task.id);
  return { status: "success" };
}

/** An occurrence dated after today - work that has not come round yet. */
function isFutureOccurrence_(occ, todayKey) {
  return !!occ.dateKey && occ.dateKey > todayKey;
}

function skipOccurrenceAction_(doc, payload) {
  var occ = findOccurrence_(doc, payload.occurrenceId);
  if (!occ) return { status: "error", message: "Vazifa topilmadi." };
  if (occ.status === TASK_STATUS_COMPLETED) return { status: "error", message: "Allaqachon bajarilgan." };
  // Skipping ahead is legitimate ("nobody is in on Friday"), it just has to be
  // deliberate rather than a misclick on a card in the Kelgusi list.
  var todayKey = taskTodayKey_(Date.now());
  if (isFutureOccurrence_(occ, todayKey) && payload.confirmFuture !== true) {
    return { status: "error", needsFutureConfirm: true, dateKey: occ.dateKey,
      message: "Kelgusi kunni (" + formatTaskDateKey_(occ.dateKey) + ") o'tkazib yuborishni tasdiqlang." };
  }
  occ.status = TASK_STATUS_SKIPPED;
  writeOccurrenceRow_(doc, occ);
  if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
  appendAuditRow_(doc, "task_occurrence_skipped", occ.id);
  return { status: "success" };
}

function completeOccurrenceAction_(doc, payload) {
  var occ = findOccurrence_(doc, payload.occurrenceId);
  if (!occ) return { status: "error", message: "Vazifa topilmadi." };
  if (occ.status === TASK_STATUS_COMPLETED) return { status: "success" }; // idempotent
  if (occ.status === TASK_STATUS_CANCELLED) return { status: "error", message: "Bekor qilingan vazifa." };
  if (isFutureOccurrence_(occ, taskTodayKey_(Date.now()))) {
    return { status: "error",
      message: "Kelgusi kun uchun vazifani oldindan bajarilgan deb belgilab bo'lmaydi." };
  }

  // A caller with a verified identity is recorded as themselves. The admin
  // panel has no identity beyond the key, so it keeps its old label.
  var byId = String(payload.completedById || "");
  var byName = String(payload.completedBy || payload.completedByName || "").trim() ||
    (byId ? byId : "Admin (panel)");
  var source = String(payload.completedSource || "web");

  // A task that asks for a photo does not become done because a button was
  // pressed - that is the rule the group cards already enforce. Any client
  // that can name a person can start the proof flow instead of bypassing it;
  // one that cannot has no one to ask, so it completes as before.
  if (occ.photoRequired && occ.status !== TASK_STATUS_WAITING && byId) {
    occ.status = TASK_STATUS_WAITING;
    occ.proofAwaitingUserId = byId;
    occ.completedByName = byName;                  // provisional; confirmed on proof
    occ.meta = occ.meta || {};
    occ.meta.proofPromptMsgId = "";
    occ.meta.proofRequestedAt = new Date().toISOString();
    writeOccurrenceRow_(doc, occ);

    enqueueTaskJob_(doc, "task_proof_prompt", occ.id, {
      occurrenceId: occ.id, userId: byId, userName: byName
    });
    if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
    appendAuditRow_(doc, "task_proof_requested", occ.id + " by:" + byName);
    return {
      status: "success", awaitingProof: true,
      message: "📷 Rasm kutilmoqda — guruhda so'ralgan xabarga javob bering."
    };
  }

  completeTaskOccurrence_(doc, occ, { byId: byId, byName: byName, source: source });
  return { status: "success" };
}

function reopenOccurrenceAction_(doc, payload) {
  var occ = findOccurrence_(doc, payload.occurrenceId);
  if (!occ) return { status: "error", message: "Vazifa topilmadi." };
  occ.status = TASK_STATUS_OPEN;
  occ.completedById = "";
  occ.completedByName = "";
  occ.completedAt = "";
  occ.onTime = "";
  occ.lateMs = "";
  occ.proofFileId = "";
  occ.proofMsgId = "";
  occ.proofAwaitingUserId = "";
  writeOccurrenceRow_(doc, occ);
  if (occ.msgId) enqueueTaskJob_(doc, "task_update_message", occ.id, { occurrenceId: occ.id });
  if (occ.taskType === "goal") {
    var task = findTask_(doc, occ.taskId);
    if (task && task.status === TASK_DEF_COMPLETED) {
      task.status = TASK_DEF_ACTIVE;
      task.updatedAt = new Date().toISOString();
      updateTaskRow_(doc, task);
    }
  }
  appendAuditRow_(doc, "task_occurrence_reopened", occ.id);
  return { status: "success" };
}

// ----- apps-script/19a_tasks_wizard.gs -----------------------------------------

// ============================================================
// Tasks — the /yangi "Vazifa" wizard
// ------------------------------------------------------------
// Creating a task from the private Telegram bot, one question at a time.
//
// This is the single place where the private accounting conversation and the
// task module meet, so the boundary is drawn deliberately:
//
//   * every callback uses the `bot_vz` prefix, so it is dispatched from inside
//     handleOmadTelegramUpdate_ and inherits the private-chat check and the
//     authorization gate. A `t_` prefix would instead have been claimed by
//     isTaskTelegramUpdate_, which applies neither.
//   * the session reuses the accounting key ("yangi_" + fromId) with a
//     `flow: "task"` discriminator, so there is one session per user, one TTL
//     and one cleanup path — and typing /yangi already wipes it.
//   * neither entry point receives `configSheet`. "The wizard never reads
//     financial config" is therefore enforced by the function signatures rather
//     than by discipline: getActiveTenantNames_ is simply not callable here.
//
// The wizard writes tasks and nothing else. It never touches a transaction, a
// tenant, a rate or a backup.
//
// Wizard messages are plain text with no parse_mode. Titles, names and step
// text are free-form user input, and staying out of HTML mode removes the
// whole escaping bug class from this surface. The *group* cards are HTML —
// that is buildTaskOccurrenceMessage_'s job, and it escapes them.
// ============================================================

var WIZARD_FLOW = "task";

// A serialised session lives in the script cache, which rejects values over
// ~100 KB. Every free-text field is capped well below that, so this is a
// backstop that turns "the draft silently vanished" into something the user
// can act on.
var WIZARD_MAX_STATE_CHARS = 8000;
var WIZARD_SESSION_TTL_SECONDS = 21600; // matches the accounting flow

var WIZARD_MAX_TITLE = 200;
var WIZARD_MAX_DESC = 2000;
var WIZARD_MAX_NAME = 200;
// 20 steps means 20 occurrences, 20 notify jobs and up to 20 group messages
// from a single confirm. That is the ceiling, not a target.
var WIZARD_MAX_STEPS = 20;
var WIZARD_MAX_RESP_CHOICES = 6;

var WIZARD_TIME_PRESETS = ["09:00", "12:00", "18:00", "20:00"];
var WIZARD_REMINDER_PRESETS = ["08:00", "09:00", "12:00", "18:00", "20:00"];
var WIZARD_MONTHDAY_PRESETS = ["1", "5", "10", "15", "25"];
// Uzbek weekday labels against JS weekday numbers (0 = Sunday), Monday first.
var WIZARD_WEEKDAYS = [["Du", 1], ["Se", 2], ["Chor", 3], ["Pay", 4], ["Jum", 5], ["Shan", 6], ["Yak", 0]];

var WIZARD_PRIORITY_LABELS = {
  low: "⚪️ Past", normal: "🔵 Oddiy", high: "🟠 Yuqori", urgent: "🔴 Shoshilinch"
};

var WIZARD_EXPIRED_MESSAGE = "⌛️ Sessiya tugagan. /yangi bilan qaytadan boshlang.";
var WIZARD_STALE_BUTTON_MESSAGE = "Bu tugma eskirgan.";
var WIZARD_TOO_BIG_MESSAGE = "Juda ko'p ma'lumot. Matnni qisqartiring.";
var WIZARD_CANCELLED_MESSAGE = "❌ Bekor qilindi.";

// ------------------------------------------------------------------ session

/**
 * Writes the session back, refusing anything that would no longer fit in the
 * script cache. Returns false instead of losing the draft silently.
 */
function putWizardState_(cache, key, state) {
  var serialised = JSON.stringify(state);
  if (serialised.length > WIZARD_MAX_STATE_CHARS) return false;
  cache.put(key, serialised, WIZARD_SESSION_TTL_SECONDS);
  return true;
}

/**
 * The one way out. Every exit path — cancel, expiry, success, post-save error
 * — funnels through here, so no cache key is ever left behind.
 */
function finishWizard_(cache, key) {
  cache.remove(key);
}

/** The live wizard session, or null when there is not one. */
function readWizardState_(cache, key) {
  var state = safeParseJSON_(cache.get(key), null);
  return state && state.flow === WIZARD_FLOW ? state : null;
}

function newWizardDraft_(type) {
  return {
    type: type,
    title: "",
    description: "",
    responsible: "",
    priority: "normal",
    photoRequired: false,
    deadlineKey: "",
    deadlineTime: "",
    recurrence: { freq: "daily", interval: 1, weekdays: [], monthDay: 1, intervalDays: 1 },
    startKey: "",
    endKey: "",
    dueTime: "",
    steps: [],
    reminderTimes: [],
    // Only ever set from the vz_remdaily answer, and only asked when a
    // one-time task has both a deadline and reminder times. Everything else
    // derives it at save time rather than pretending the user chose.
    remindDaily: false
  };
}

// ------------------------------------------------------------------ parsing

/**
 * A typed date, accepted only when it is a real calendar day.
 *
 * isTaskDateKey_ is purely syntactic — "2026-13-45" satisfies it — and an
 * invalid startKey is silently replaced with today by normalizeTaskInput_,
 * which would create a routine nobody asked for. Round-tripping through the
 * day anchor is what proves the date exists: Date.UTC rolls 2026-13-45 over
 * into 2027-02-14, and the comparison catches it.
 */
function wizardParseDate_(value) {
  var text = String(value || "").trim().replace(/[.\/]/g, "-");
  if (!isTaskDateKey_(text)) return "";
  var anchor = taskKeyAnchorMs_(text);
  if (!isFinite(anchor)) return "";
  return taskKeyFromAnchorMs_(anchor) === text ? text : "";
}

/** A typed clock time normalised to HH:MM, or "" when it is not one. */
function wizardParseTime_(value) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return "";
  var normalised = taskPad2_(m[1]) + ":" + m[2];
  return isTaskTimeKey_(normalised) ? normalised : "";
}

// ------------------------------------------------------------------ choices

/**
 * Names already used on other tasks, most recent first.
 *
 * Deliberately NOT getActiveTenantNames_: that reads Omad_Tenants, and the
 * wizard must never touch accounting config. `configSheet` is not even in
 * scope here, which is what makes the rule structural rather than a promise.
 */
function wizardResponsibleChoices_(doc) {
  var rows = readTaskRows_(doc);
  var seen = {};
  var out = [];
  for (var i = rows.length - 1; i >= 0 && out.length < WIZARD_MAX_RESP_CHOICES; i--) {
    var name = String(rows[i].responsible || "").trim();
    if (!name || seen[name]) continue;
    seen[name] = true;
    out.push(name);
  }
  return out;
}

// ------------------------------------------------------------ the step order

/**
 * The step that follows `from`, given what the draft already knows.
 *
 * Kept as one function so the shape of the conversation is readable in one
 * place instead of being scattered across twenty handlers.
 */
function wizardNextStep_(state, from) {
  var draft = state.draft || {};
  switch (from) {
    case "vz_type": return "vz_title";
    case "vz_title": return "vz_desc";
    case "vz_desc": return "vz_resp";
    case "vz_resp": return "vz_pri";
    case "vz_resp_text": return "vz_pri";
    case "vz_pri": return "vz_photo";
    case "vz_photo":
      if (draft.type === "once") return "vz_date";
      if (draft.type === "routine") return "vz_freq";
      return "vz_steps";

    // once — a task with no deadline has no time to ask about either.
    case "vz_date": return draft.deadlineKey ? "vz_time" : "vz_reminders";
    case "vz_time": return "vz_reminders";

    // routine
    case "vz_freq":
      if (draft.recurrence.freq === "weekly") return "vz_weekdays";
      if (draft.recurrence.freq === "monthly") return "vz_monthday";
      if (draft.recurrence.freq === "custom") return "vz_interval";
      return "vz_start";
    case "vz_weekdays": return "vz_start";
    case "vz_monthday": return "vz_start";
    case "vz_interval": return "vz_start";
    case "vz_start": return "vz_end";
    case "vz_end": return "vz_duetime";
    case "vz_duetime": return "vz_reminders";

    // goal
    case "vz_steps": return "vz_reminders";

    case "vz_reminders": return wizardAsksRemindDaily_(draft) ? "vz_remdaily" : "vz_confirm";
    case "vz_remdaily": return "vz_confirm";
  }
  return "vz_confirm";
}

/**
 * Whether the draft needs the "how should these repeat?" question.
 *
 * Only a dated one-time task has two honest answers: every day until it is
 * done, or once on the deadline day. A deadline-less one has no deadline day
 * to attach a reminder to, a routine's reminders belong to the day they were
 * scheduled for, and a goal's repeat daily by definition — asking there would
 * offer a choice that does not exist.
 */
function wizardAsksRemindDaily_(draft) {
  return draft.type === "once" && !!draft.deadlineKey && draft.reminderTimes.length > 0;
}

/** Per-step setup that has to happen as the step is entered, not rendered. */
function wizardOnEnterStep_(state, doc) {
  if (state.step === "vz_resp") {
    // Captured once, so the list cannot shift between render and press and
    // turn bot_vz_resp:<i> into a different person.
    state.respChoices = wizardResponsibleChoices_(doc);
  } else if (state.respChoices) {
    delete state.respChoices;
  }
}

// ---------------------------------------------------------------- rendering

function wizardButton_(text, data) {
  return { text: text, callback_data: data };
}

function wizardSkipButton_(what, label) {
  return wizardButton_(label || "⏭ O'tkazish", "bot_vz_skip:" + what);
}

/** A row of preset clock times plus the manual-entry escape, for one family. */
function wizardTimeRows_(prefix, presets) {
  var row = [];
  for (var i = 0; i < presets.length; i++) row.push(wizardButton_(presets[i], prefix + presets[i]));
  return [row, [wizardButton_("✍️ Vaqt", prefix + "other")]];
}

function wizardPriorityLabel_(priority) {
  return WIZARD_PRIORITY_LABELS[priority] || WIZARD_PRIORITY_LABELS.normal;
}

/**
 * The prompt and keyboard for wherever the conversation currently is.
 * Pure: everything it needs is already on the session.
 */
function wizardStepView_(state) {
  var draft = state.draft || {};
  var step = state.step;
  var rows;
  var i;

  if (step === "vz_type") {
    return {
      text: "Vazifa turini tanlang:",
      keyboard: { inline_keyboard: [[
        wizardButton_("📝 Bir martalik", "bot_vz_t:once"),
        wizardButton_("🔁 Muntazam", "bot_vz_t:routine"),
        wizardButton_("🎯 Maqsad", "bot_vz_t:goal")
      ]] }
    };
  }

  if (step === "vz_title") return { text: "📌 Vazifa sarlavhasini kiriting:", keyboard: null };

  if (step === "vz_desc") {
    return {
      text: "📝 Tavsif kiriting:",
      keyboard: { inline_keyboard: [[wizardSkipButton_("desc")]] }
    };
  }

  if (step === "vz_resp") {
    rows = [];
    var choices = state.respChoices || [];
    for (i = 0; i < choices.length; i++) rows.push([wizardButton_(choices[i], "bot_vz_resp:" + i)]);
    rows.push([wizardButton_("✍️ Boshqa ism", "bot_vz_resp_other"), wizardSkipButton_("resp")]);
    return { text: "👤 Mas'ul kim?", keyboard: { inline_keyboard: rows } };
  }

  if (step === "vz_resp_text") return { text: "👤 Mas'ul ismini kiriting:", keyboard: null };

  if (step === "vz_pri") {
    return {
      text: "🎚 Muhimlik darajasi:",
      keyboard: { inline_keyboard: [
        [wizardButton_(WIZARD_PRIORITY_LABELS.low, "bot_vz_pri:low"),
         wizardButton_(WIZARD_PRIORITY_LABELS.normal, "bot_vz_pri:normal")],
        [wizardButton_(WIZARD_PRIORITY_LABELS.high, "bot_vz_pri:high"),
         wizardButton_(WIZARD_PRIORITY_LABELS.urgent, "bot_vz_pri:urgent")]
      ] }
    };
  }

  if (step === "vz_photo") {
    return {
      text: "📷 Rasm tasdiqi talab qilinsinmi?",
      keyboard: { inline_keyboard: [[
        wizardButton_("Ha", "bot_vz_photo:1"), wizardButton_("Yo'q", "bot_vz_photo:0")
      ]] }
    };
  }

  if (step === "vz_date") {
    return {
      text: "📅 Muddat sanasi:",
      keyboard: { inline_keyboard: [
        [wizardButton_("Bugun", "bot_vz_date:today"), wizardButton_("Ertaga", "bot_vz_date:tomorrow")],
        [wizardButton_("✍️ Sana kiriting", "bot_vz_date:other"), wizardSkipButton_("date", "⏭ Muddatsiz")]
      ] }
    };
  }

  if (step === "vz_date_text" || step === "vz_start_text" || step === "vz_end_text") {
    return { text: "📅 Sanani YYYY-MM-DD ko'rinishida kiriting (masalan 2026-08-15):", keyboard: null };
  }

  if (step === "vz_time") {
    rows = wizardTimeRows_("bot_vz_time:", WIZARD_TIME_PRESETS);
    rows[1].push(wizardSkipButton_("time", "⏭ Vaqtsiz"));
    return { text: "🕓 Muddat vaqti:", keyboard: { inline_keyboard: rows } };
  }

  if (step === "vz_time_text" || step === "vz_duetime_text" || step === "vz_rem_text") {
    return { text: "🕓 Vaqtni HH:MM ko'rinishida kiriting (masalan 20:00):", keyboard: null };
  }

  if (step === "vz_freq") {
    return {
      text: "🔁 Qanchalik tez-tez takrorlansin?",
      keyboard: { inline_keyboard: [
        [wizardButton_("Har kuni", "bot_vz_freq:daily"), wizardButton_("Hafta kunlari", "bot_vz_freq:weekly")],
        [wizardButton_("Oylik", "bot_vz_freq:monthly"), wizardButton_("Har N kunda", "bot_vz_freq:custom")]
      ] }
    };
  }

  if (step === "vz_weekdays") {
    var picked = draft.recurrence.weekdays || [];
    var toggles = [];
    for (i = 0; i < WIZARD_WEEKDAYS.length; i++) {
      var wd = WIZARD_WEEKDAYS[i][1];
      var mark = picked.indexOf(wd) !== -1 ? "✅ " : "";
      toggles.push(wizardButton_(mark + WIZARD_WEEKDAYS[i][0], "bot_vz_wd:" + wd));
    }
    rows = [toggles.slice(0, 4), toggles.slice(4)];
    // Offering "done" with nothing selected would only produce a refusal.
    if (picked.length) rows.push([wizardButton_("✅ Tayyor", "bot_vz_wd_done")]);
    return { text: "📆 Hafta kunlarini tanlang:", keyboard: { inline_keyboard: rows } };
  }

  if (step === "vz_monthday") {
    var dayRow = [];
    for (i = 0; i < WIZARD_MONTHDAY_PRESETS.length; i++) {
      dayRow.push(wizardButton_(WIZARD_MONTHDAY_PRESETS[i] + "-kun", "bot_vz_md:" + WIZARD_MONTHDAY_PRESETS[i]));
    }
    return {
      text: "📆 Oyning qaysi kuni?",
      keyboard: { inline_keyboard: [
        dayRow,
        [wizardButton_("Oxirgi kun", "bot_vz_md:last"), wizardButton_("✍️ Kun", "bot_vz_md:other")]
      ] }
    };
  }

  if (step === "vz_monthday_text") return { text: "📆 Kun raqamini kiriting (1-31):", keyboard: null };

  if (step === "vz_interval") return { text: "🔢 Necha kunda bir marta? Raqam kiriting:", keyboard: null };

  if (step === "vz_start") {
    return {
      text: "▶️ Boshlanish sanasi:",
      keyboard: { inline_keyboard: [[
        wizardButton_("Bugundan", "bot_vz_start:today"), wizardButton_("✍️ Sana", "bot_vz_start:other")
      ]] }
    };
  }

  if (step === "vz_end") {
    return {
      text: "⏹ Tugash sanasi:",
      keyboard: { inline_keyboard: [[
        wizardSkipButton_("end", "⏭ Tugashsiz"), wizardButton_("✍️ Sana", "bot_vz_end:other")
      ]] }
    };
  }

  if (step === "vz_duetime") {
    rows = wizardTimeRows_("bot_vz_due:", WIZARD_TIME_PRESETS);
    rows[1].push(wizardSkipButton_("duetime", "⏭ Vaqtsiz"));
    return { text: "🕓 Kunlik muddat vaqti:", keyboard: { inline_keyboard: rows } };
  }

  if (step === "vz_steps") {
    var lines = ["🎯 Bosqichlarni birma-bir yuboring. Tugagach ✅ Tayyor."];
    if (draft.steps.length) {
      lines.push("");
      for (i = 0; i < draft.steps.length; i++) lines.push((i + 1) + ". " + draft.steps[i]);
    }
    rows = [];
    if (draft.steps.length) {
      rows.push([wizardButton_("↩️ Oxirgi qadamni o'chirish", "bot_vz_step_undo")]);
      // Absent until there is at least one step, so normalizeTaskInput_'s
      // "kamida bitta qadam" refusal is unreachable rather than reported late.
      rows.push([wizardButton_("✅ Tayyor", "bot_vz_step_done")]);
    }
    return { text: lines.join("\n"), keyboard: rows.length ? { inline_keyboard: rows } : null };
  }

  if (step === "vz_reminders") {
    var chosen = draft.reminderTimes || [];
    var remRow = [];
    for (i = 0; i < WIZARD_REMINDER_PRESETS.length; i++) {
      var time = WIZARD_REMINDER_PRESETS[i];
      remRow.push(wizardButton_((chosen.indexOf(time) !== -1 ? "✅ " : "") + time, "bot_vz_rem:" + time));
    }
    rows = [remRow, [wizardButton_("✍️ Boshqa vaqt", "bot_vz_rem_other")]];
    rows.push([chosen.length
      ? wizardButton_("✅ Tayyor", "bot_vz_rem_done")
      : wizardSkipButton_("reminders")]);
    return { text: "🔔 Eslatma vaqtlari:", keyboard: { inline_keyboard: rows } };
  }

  if (step === "vz_remdaily") {
    return {
      text: "🔔 Eslatmalar qanday takrorlansin?",
      keyboard: { inline_keyboard: [
        [wizardButton_("🔁 Har kuni, bajarilguncha", "bot_vz_rd:daily")],
        [wizardButton_("📅 Faqat muddat kunida", "bot_vz_rd:deadline")]
      ] }
    };
  }

  if (step === "vz_confirm") {
    return {
      text: buildWizardSummary_(draft),
      keyboard: { inline_keyboard: [[
        wizardButton_("✅ Saqlash", "bot_vz_save"), wizardButton_("❌ Bekor", "bot_vz_cancel")
      ]] }
    };
  }

  return { text: WIZARD_EXPIRED_MESSAGE, keyboard: null };
}

/** The review card: everything the draft says, in the order it was asked. */
function buildWizardSummary_(draft) {
  var lines = ["Tekshirib, saqlang:", ""];
  lines.push("📌 " + draft.title);

  var meta = [];
  if (draft.responsible) meta.push("👤 " + draft.responsible);
  meta.push(wizardPriorityLabel_(draft.priority));
  meta.push("📷 " + (draft.photoRequired ? "Ha" : "Yo'q"));
  lines.push(meta.join(" · "));

  if (draft.description) lines.push("📝 " + draft.description);

  if (draft.type === "once") {
    lines.push(draft.deadlineKey
      ? "📅 " + formatTaskDateKey_(draft.deadlineKey) + (draft.deadlineTime ? " " + draft.deadlineTime : "")
      : "📅 Muddatsiz");
  } else if (draft.type === "routine") {
    lines.push("🔁 " + describeRecurrence_({
      type: "routine", recurrence: draft.recurrence, startKey: draft.startKey
    }));
    lines.push("▶️ " + formatTaskDateKey_(draft.startKey) +
      (draft.endKey ? " — " + formatTaskDateKey_(draft.endKey) : ""));
    if (draft.dueTime) lines.push("🕓 " + draft.dueTime);
  } else {
    lines.push("🎯 Bosqichlar:");
    for (var i = 0; i < draft.steps.length; i++) lines.push("  " + (i + 1) + ". " + draft.steps[i]);
  }

  if (draft.reminderTimes.length) {
    // The repeat rule is as much a decision as the times are, so the review
    // card states it rather than leaving the user to assume one. A routine has
    // no rule to state: each day's occurrence carries its own reminders.
    var repeat = draft.type === "routine" ? ""
      : (wizardRemindDaily_(draft) ? " · har kuni" : " · muddat kunida");
    lines.push("🔔 " + draft.reminderTimes.join(", ") + repeat);
  }
  return lines.join("\n");
}

/**
 * What `remindDaily` will be saved as.
 *
 * A dated one-time task carries the answer the user gave at vz_remdaily. Every
 * other shape has only one reading that does anything: reminders on something
 * with no deadline day can only mean "every day until it is done", which is the
 * same rule goalRemindDaily_ applies to a goal's steps.
 */
function wizardRemindDaily_(draft) {
  if (draft.type === "routine") return false;
  if (wizardAsksRemindDaily_(draft)) return !!draft.remindDaily;
  return draft.reminderTimes.length > 0;
}

// ------------------------------------------------------------- step movement

/**
 * Renders the current step, editing `editMsgId` when the previous interaction
 * was a button press and sending a fresh card when it was typed text (the old
 * prompt is no longer the last message in the chat).
 */
function renderWizardStep_(state, chatId, key, cache, editMsgId, note) {
  var view = wizardStepView_(state);
  var text = note ? (note + "\n\n" + view.text) : view.text;

  if (editMsgId) {
    editTelegramMessage_(chatId, editMsgId, text, view.keyboard || { inline_keyboard: [] });
    state.msgId = editMsgId;
  } else {
    var sent = extractTelegramMessageId_(sendTelegramMessage_(chatId, text, view.keyboard || undefined));
    if (sent) state.msgId = sent;
  }

  if (!putWizardState_(cache, key, state)) {
    finishWizard_(cache, key);
    sendTelegramMessage_(chatId, WIZARD_TOO_BIG_MESSAGE);
  }
}

/** Moves to whatever follows `fromStep` and renders it. */
function advanceWizard_(state, fromStep, chatId, key, cache, editMsgId, doc) {
  state.step = wizardNextStep_(state, fromStep);
  wizardOnEnterStep_(state, doc);
  renderWizardStep_(state, chatId, key, cache, editMsgId);
}

/**
 * Re-renders where the user actually is, with a note explaining why.
 *
 * Used for invalid input and for a tap on a card that has been superseded. It
 * never mutates the draft, which is what makes correctness independent of
 * which card happened to be tapped.
 */
function repromptWizard_(state, chatId, key, cache, note) {
  renderWizardStep_(state, chatId, key, cache, 0, note);
}

// ------------------------------------------------------------------ callbacks

/**
 * Every `bot_vz` button. Reached only from processOmadCallback_, so the
 * private-chat check and gate #1 have already run; authorization is re-checked
 * here for the same reason the accounting steps re-check it.
 */
function handleTaskWizardCallback_(callback, chatId, key, cache, data, doc, fromId) {
  if (!isAuthorizedTelegramUser_(fromId)) {
    sendTelegramMessage_(chatId, TELEGRAM_UNAUTHORIZED_MESSAGE);
    return;
  }

  var msgId = (callback.message && callback.message.message_id) || 0;
  var state;

  // The entry button is the only one allowed to start from nothing.
  if (data === "bot_vz_type") {
    state = {
      flow: WIZARD_FLOW,
      sessionId: Utilities.getUuid().split("-").join(""),
      step: "vz_type",
      msgId: msgId,
      draft: newWizardDraft_("")
    };
    renderWizardStep_(state, chatId, key, cache, msgId);
    return;
  }

  state = readWizardState_(cache, key);
  if (!state) {
    // Deliberately NOT resurrected. processOmadCallback_ rebuilds a missing
    // accounting session from the button that arrived; a wizard draft cannot
    // be rebuilt that way, and a half-empty one would create a junk task.
    //
    // Answered with a new message rather than by editing the card: the tapped
    // card may be the finished "✅ Vazifa yaratildi" one, and a redelivered
    // press must not overwrite the outcome with an expiry notice.
    sendTelegramMessage_(chatId, WIZARD_EXPIRED_MESSAGE);
    return;
  }

  if (data === "bot_vz_cancel") {
    finishWizard_(cache, key);
    if (msgId) editTelegramMessage_(chatId, msgId, WIZARD_CANCELLED_MESSAGE, { inline_keyboard: [] });
    else sendTelegramMessage_(chatId, WIZARD_CANCELLED_MESSAGE);
    return;
  }

  var draft = state.draft;

  if (data.indexOf("bot_vz_t:") === 0) {
    if (state.step !== "vz_type") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var type = data.slice("bot_vz_t:".length);
    if (TASK_TYPES.indexOf(type) === -1) return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    state.draft = newWizardDraft_(type);
    return advanceWizard_(state, "vz_type", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_skip:") === 0) {
    return handleWizardSkip_(state, data.slice("bot_vz_skip:".length), chatId, key, cache, msgId, doc);
  }

  if (data === "bot_vz_resp_other") {
    if (state.step !== "vz_resp") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    state.step = "vz_resp_text";
    return renderWizardStep_(state, chatId, key, cache, msgId);
  }

  if (data.indexOf("bot_vz_resp:") === 0) {
    if (state.step !== "vz_resp") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var picked = (state.respChoices || [])[Number(data.slice("bot_vz_resp:".length))];
    if (!picked) return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    draft.responsible = picked;
    return advanceWizard_(state, "vz_resp", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_pri:") === 0) {
    if (state.step !== "vz_pri") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    draft.priority = normalizeTaskPriority_(data.slice("bot_vz_pri:".length));
    return advanceWizard_(state, "vz_pri", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_photo:") === 0) {
    if (state.step !== "vz_photo") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    draft.photoRequired = data.slice("bot_vz_photo:".length) === "1";
    return advanceWizard_(state, "vz_photo", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_date:") === 0) {
    if (state.step !== "vz_date") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var which = data.slice("bot_vz_date:".length);
    if (which === "other") {
      state.step = "vz_date_text";
      return renderWizardStep_(state, chatId, key, cache, msgId);
    }
    var today = taskTodayKey_(Date.now());
    draft.deadlineKey = which === "tomorrow" ? taskDateKeyAddDays_(today, 1) : today;
    return advanceWizard_(state, "vz_date", chatId, key, cache, msgId, doc);
  }

  // The value carries its own colon, so it is read by length — never split(":").
  if (data.indexOf("bot_vz_time:") === 0) {
    if (state.step !== "vz_time") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var timeValue = data.slice("bot_vz_time:".length);
    if (timeValue === "other") {
      state.step = "vz_time_text";
      return renderWizardStep_(state, chatId, key, cache, msgId);
    }
    draft.deadlineTime = wizardParseTime_(timeValue);
    return advanceWizard_(state, "vz_time", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_freq:") === 0) {
    if (state.step !== "vz_freq") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    draft.recurrence.freq = data.slice("bot_vz_freq:".length);
    return advanceWizard_(state, "vz_freq", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_wd:") === 0) {
    if (state.step !== "vz_weekdays") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var weekday = Number(data.slice("bot_vz_wd:".length));
    var at = draft.recurrence.weekdays.indexOf(weekday);
    if (at === -1) draft.recurrence.weekdays.push(weekday);
    else draft.recurrence.weekdays.splice(at, 1);
    draft.recurrence.weekdays.sort(function (a, b) { return a - b; });
    return renderWizardStep_(state, chatId, key, cache, msgId);
  }

  if (data === "bot_vz_wd_done") {
    if (state.step !== "vz_weekdays") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    if (!draft.recurrence.weekdays.length) {
      return renderWizardStep_(state, chatId, key, cache, msgId, "Kamida bitta kun tanlang.");
    }
    return advanceWizard_(state, "vz_weekdays", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_md:") === 0) {
    if (state.step !== "vz_monthday") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var monthDay = data.slice("bot_vz_md:".length);
    if (monthDay === "other") {
      state.step = "vz_monthday_text";
      return renderWizardStep_(state, chatId, key, cache, msgId);
    }
    draft.recurrence.monthDay = monthDay === "last" ? "last" : Number(monthDay);
    return advanceWizard_(state, "vz_monthday", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_start:") === 0) {
    if (state.step !== "vz_start") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    if (data.slice("bot_vz_start:".length) === "other") {
      state.step = "vz_start_text";
      return renderWizardStep_(state, chatId, key, cache, msgId);
    }
    draft.startKey = taskTodayKey_(Date.now());
    return advanceWizard_(state, "vz_start", chatId, key, cache, msgId, doc);
  }

  if (data === "bot_vz_end:other") {
    if (state.step !== "vz_end") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    state.step = "vz_end_text";
    return renderWizardStep_(state, chatId, key, cache, msgId);
  }

  if (data.indexOf("bot_vz_due:") === 0) {
    if (state.step !== "vz_duetime") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var dueValue = data.slice("bot_vz_due:".length);
    if (dueValue === "other") {
      state.step = "vz_duetime_text";
      return renderWizardStep_(state, chatId, key, cache, msgId);
    }
    draft.dueTime = wizardParseTime_(dueValue);
    return advanceWizard_(state, "vz_duetime", chatId, key, cache, msgId, doc);
  }

  if (data === "bot_vz_step_undo") {
    if (state.step !== "vz_steps") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    draft.steps.pop();
    return renderWizardStep_(state, chatId, key, cache, msgId);
  }

  if (data === "bot_vz_step_done") {
    if (state.step !== "vz_steps") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    if (!draft.steps.length) {
      return renderWizardStep_(state, chatId, key, cache, msgId, "Kamida bitta bosqich kiriting.");
    }
    return advanceWizard_(state, "vz_steps", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_rem:") === 0) {
    if (state.step !== "vz_reminders") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var reminder = data.slice("bot_vz_rem:".length);
    var remAt = draft.reminderTimes.indexOf(reminder);
    if (remAt === -1) draft.reminderTimes.push(reminder);
    else draft.reminderTimes.splice(remAt, 1);
    draft.reminderTimes.sort();
    return renderWizardStep_(state, chatId, key, cache, msgId);
  }

  if (data === "bot_vz_rem_other") {
    if (state.step !== "vz_reminders") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    state.step = "vz_rem_text";
    return renderWizardStep_(state, chatId, key, cache, msgId);
  }

  if (data === "bot_vz_rem_done") {
    if (state.step !== "vz_reminders") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    return advanceWizard_(state, "vz_reminders", chatId, key, cache, msgId, doc);
  }

  if (data.indexOf("bot_vz_rd:") === 0) {
    if (state.step !== "vz_remdaily") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    var repeatMode = data.slice("bot_vz_rd:".length);
    if (repeatMode !== "daily" && repeatMode !== "deadline") {
      return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    }
    draft.remindDaily = repeatMode === "daily";
    return advanceWizard_(state, "vz_remdaily", chatId, key, cache, msgId, doc);
  }

  if (data === "bot_vz_save") {
    if (state.step !== "vz_confirm") return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
    return handleWizardSave_(state, chatId, key, cache, doc, fromId);
  }

  repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
}

/** Every "⏭ O'tkazish" button, which is simply "leave the field empty". */
function handleWizardSkip_(state, what, chatId, key, cache, msgId, doc) {
  var expected = {
    desc: "vz_desc", resp: "vz_resp", date: "vz_date", time: "vz_time",
    end: "vz_end", duetime: "vz_duetime", reminders: "vz_reminders"
  }[what];
  if (!expected || state.step !== expected) {
    return repromptWizard_(state, chatId, key, cache, WIZARD_STALE_BUTTON_MESSAGE);
  }
  // Skipping the deadline also skips its time; wizardNextStep_ reads the empty
  // deadlineKey and routes past vz_time on its own.
  return advanceWizard_(state, expected, chatId, key, cache, msgId, doc);
}

// ---------------------------------------------------------------- free text

/**
 * Every typed answer while a wizard session is live. Reached only from
 * processOmadTextStep_, below the private-chat check and gates #1 and #3.
 */
function handleTaskWizardText_(text, chatId, key, cache, state, doc, fromId) {
  if (!isAuthorizedTelegramUser_(fromId)) {
    sendTelegramMessage_(chatId, TELEGRAM_UNAUTHORIZED_MESSAGE);
    return;
  }

  var value = String(text || "").trim();
  var draft = state.draft;

  // /bekor only ever matters while a wizard session exists, which is exactly
  // when control reaches here. The accounting flow never sees it.
  if (value === "/bekor") {
    finishWizard_(cache, key);
    sendTelegramMessage_(chatId, WIZARD_CANCELLED_MESSAGE);
    return;
  }

  // A slash command is never an answer. This matters most at vz_title, where
  // it would otherwise quietly become the task's name. (/yangi never reaches
  // here — handleOmadTelegramUpdate_ claims it and restarts the session.)
  if (value.indexOf("/") === 0) {
    return repromptWizard_(state, chatId, key, cache, "Buyruq o'rniga javob kiriting yoki /bekor bilan to'xtating.");
  }

  switch (state.step) {
    case "vz_title":
      if (!value) return repromptWizard_(state, chatId, key, cache, "Sarlavha bo'sh bo'lmasin.");
      if (value.length > WIZARD_MAX_TITLE) {
        return repromptWizard_(state, chatId, key, cache, "Sarlavha juda uzun (" + WIZARD_MAX_TITLE + " belgigacha).");
      }
      draft.title = value;
      return advanceWizard_(state, "vz_title", chatId, key, cache, 0, doc);

    case "vz_desc":
      if (!value) return repromptWizard_(state, chatId, key, cache, "Tavsif bo'sh bo'lmasin.");
      if (value.length > WIZARD_MAX_DESC) {
        return repromptWizard_(state, chatId, key, cache, "Tavsif juda uzun (" + WIZARD_MAX_DESC + " belgigacha).");
      }
      draft.description = value;
      return advanceWizard_(state, "vz_desc", chatId, key, cache, 0, doc);

    case "vz_resp_text":
      if (!value) return repromptWizard_(state, chatId, key, cache, "Ism bo'sh bo'lmasin.");
      if (value.length > WIZARD_MAX_NAME) {
        return repromptWizard_(state, chatId, key, cache, "Ism juda uzun.");
      }
      draft.responsible = value;
      return advanceWizard_(state, "vz_resp_text", chatId, key, cache, 0, doc);

    case "vz_date_text":
      var deadline = wizardParseDate_(value);
      if (!deadline) return repromptWizard_(state, chatId, key, cache, "Sana noto'g'ri.");
      draft.deadlineKey = deadline;
      return advanceWizard_(state, "vz_date", chatId, key, cache, 0, doc);

    case "vz_time_text":
      var deadlineTime = wizardParseTime_(value);
      if (!deadlineTime) return repromptWizard_(state, chatId, key, cache, "Vaqt noto'g'ri.");
      draft.deadlineTime = deadlineTime;
      return advanceWizard_(state, "vz_time", chatId, key, cache, 0, doc);

    case "vz_monthday_text":
      var day = Number(value);
      if (!isFinite(day) || day < 1 || day > 31) {
        return repromptWizard_(state, chatId, key, cache, "Kun 1 dan 31 gacha bo'lishi kerak.");
      }
      draft.recurrence.monthDay = Math.floor(day);
      return advanceWizard_(state, "vz_monthday", chatId, key, cache, 0, doc);

    case "vz_interval":
      var days = Number(value);
      if (!isFinite(days) || days < 1) {
        return repromptWizard_(state, chatId, key, cache, "Kamida 1 kun bo'lishi kerak.");
      }
      draft.recurrence.intervalDays = Math.floor(days);
      return advanceWizard_(state, "vz_interval", chatId, key, cache, 0, doc);

    case "vz_start_text":
      var startKey = wizardParseDate_(value);
      if (!startKey) return repromptWizard_(state, chatId, key, cache, "Sana noto'g'ri.");
      draft.startKey = startKey;
      return advanceWizard_(state, "vz_start", chatId, key, cache, 0, doc);

    case "vz_end_text":
      var endKey = wizardParseDate_(value);
      if (!endKey) return repromptWizard_(state, chatId, key, cache, "Sana noto'g'ri.");
      if (draft.startKey && endKey < draft.startKey) {
        return repromptWizard_(state, chatId, key, cache, "Tugash sanasi boshlanish sanasidan oldin.");
      }
      draft.endKey = endKey;
      return advanceWizard_(state, "vz_end", chatId, key, cache, 0, doc);

    case "vz_duetime_text":
      var dueTime = wizardParseTime_(value);
      if (!dueTime) return repromptWizard_(state, chatId, key, cache, "Vaqt noto'g'ri.");
      draft.dueTime = dueTime;
      return advanceWizard_(state, "vz_duetime", chatId, key, cache, 0, doc);

    case "vz_rem_text":
      var reminder = wizardParseTime_(value);
      if (!reminder) return repromptWizard_(state, chatId, key, cache, "Vaqt noto'g'ri.");
      if (draft.reminderTimes.indexOf(reminder) === -1) draft.reminderTimes.push(reminder);
      draft.reminderTimes.sort();
      state.step = "vz_reminders";
      return renderWizardStep_(state, chatId, key, cache, 0);

    case "vz_steps":
      if (!value) return repromptWizard_(state, chatId, key, cache, "Bosqich nomi bo'sh bo'lmasin.");
      if (value.length > WIZARD_MAX_TITLE) {
        return repromptWizard_(state, chatId, key, cache, "Bosqich nomi juda uzun.");
      }
      if (draft.steps.length >= WIZARD_MAX_STEPS) {
        return repromptWizard_(state, chatId, key, cache, "Bosqichlar soni chegarasi: " + WIZARD_MAX_STEPS + ".");
      }
      draft.steps.push(value);
      return renderWizardStep_(state, chatId, key, cache, 0);
  }

  // Text arrived at a button-only step: re-send the step rather than swallow it.
  return repromptWizard_(state, chatId, key, cache, "Quyidagi tugmalardan birini tanlang.");
}

// -------------------------------------------------------------------- saving

/** The web-API payload the draft describes. */
function wizardTaskPayload_(draft, fromId, requestId) {
  var payload = {
    type: draft.type,
    title: draft.title,
    description: draft.description,
    responsible: draft.responsible,
    priority: draft.priority,
    photoRequired: draft.photoRequired,
    reminderTimes: draft.reminderTimes,
    createdBy: ("telegram:" + fromId).slice(0, 60),
    meta: { source: "telegram", tgRequestId: requestId }
  };

  if (draft.type === "once") {
    payload.deadlineKey = draft.deadlineKey;
    payload.deadlineTime = draft.deadlineTime;
    // A dated task carries the answer given at vz_remdaily; a deadline-less one
    // has no deadline day to attach a reminder to, so its times can only mean
    // "every day until it is done". Never inferred for a dated task.
    payload.remindDaily = wizardRemindDaily_(draft);
  } else if (draft.type === "routine") {
    payload.recurrence = draft.recurrence;
    payload.startKey = draft.startKey;
    payload.endKey = draft.endKey;
    payload.dueTime = draft.dueTime;
  } else {
    payload.steps = draft.steps;
  }
  return payload;
}

/**
 * The durable half of the idempotency story.
 *
 * Tasks have no Request_ID column, so the conversation's id is carried in
 * Meta_JSON instead. This is what catches a redelivery that arrives after the
 * task was written but before the session could be removed.
 */
function findTaskByTelegramRequestId_(doc, requestId) {
  if (!requestId) return null;
  var rows = readTaskRows_(doc);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].meta && String(rows[i].meta.tgRequestId || "") === String(requestId)) return rows[i];
  }
  return null;
}

/**
 * Creates the task, exactly once.
 *
 * Two layers do the work. The script lock serialises concurrent deliveries, so
 * a second one only ever runs after the first has finished; it then finds the
 * task by the conversation's request id and reports the same success instead of
 * creating a second. Removing the session on success turns every later
 * redelivery into an ordinary expiry.
 *
 * There is deliberately no "currently saving" flag. Under the lock it could
 * only ever be observed by a delivery arriving after a run died mid-save — and
 * in the sub-case where that matters (died before the row was written) refusing
 * to retry is worse than retrying, because the retry is what finally creates
 * the task the user asked for.
 */
function handleWizardSave_(state, chatId, key, cache, doc, fromId) {
  var requestId = "tg_" + fromId + "_" + state.sessionId;
  var payload = wizardTaskPayload_(state.draft, fromId, requestId);

  if (state.msgId) {
    editTelegramMessage_(chatId, state.msgId, "⏳ Saqlanmoqda...", { inline_keyboard: [] });
  }

  var taskId = "";
  var duplicate = false;
  var gone = false;
  var failure = "";

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (lockError) {
    // Busy, not broken: the draft is intact and pressing again works.
    return repromptWizard_(state, chatId, key, cache, "⏳ Tizim band. Biroz kutib, qayta urinib ko'ring.");
  }
  try {
    // The durable key is checked first: it is the only test that still works
    // after the session has gone.
    var already = findTaskByTelegramRequestId_(doc, requestId);
    if (already) {
      taskId = already.id;
      duplicate = true;
    } else {
      var fresh = readWizardState_(cache, key);
      if (!fresh) {
        gone = true;
      } else {
        var result = saveTaskAction_(doc, payload);
        if (result.status === "success") {
          taskId = result.taskId;
        } else {
          // The draft survives, so the user can fix it or cancel.
          failure = String(result.message || "Saqlanmadi.");
        }
      }
    }
  } finally {
    lock.releaseLock();
  }

  if (failure) {
    state.step = "vz_confirm";
    return repromptWizard_(state, chatId, key, cache, "⚠️ " + failure);
  }
  if (gone || !taskId) {
    if (state.msgId) editTelegramMessage_(chatId, state.msgId, WIZARD_EXPIRED_MESSAGE, { inline_keyboard: [] });
    return;
  }

  finishWizard_(cache, key);
  if (!duplicate) {
    // saveTaskAction_'s own audit row records only the id and type, and
    // createdBy has until now always been the literal "admin".
    appendAuditRow_(doc, "task_created_via_telegram", taskId + " by:" + fromId);
  }

  // runTaskScheduler_ takes the script lock itself, so announcing happens after
  // releaseLock() — never nested. Re-announcing a duplicate is harmless: the
  // scheduler only announces occurrences whose Notified_At is still empty,
  // which is exactly the "saved but died before announcing" case.
  try {
    runTaskScheduler_(doc, Date.now());
  } catch (error) {
    debugLog_(doc, "task_wizard_schedule_failed", String(error));
  }
  drainJobQueueQuietly_(doc, null);

  if (state.msgId) {
    // "yuboriladi" (will be sent), never "yuborildi" (was sent): only one job
    // drains inline, a future-dated routine announces nothing today, and with
    // no Tasks group configured the card never goes out at all.
    editTelegramMessage_(chatId, state.msgId, "✅ Vazifa yaratildi va guruhga yuboriladi.", { inline_keyboard: [] });
  }
}

// ----- apps-script/20_api.gs ---------------------------------------------------

// ============================================================
// API routing
// ------------------------------------------------------------
// The only two entry points Apps Script exposes. They validate, dispatch and
// format responses; all business logic lives in the modules above.
// ============================================================

// ------------------------------------------------------------- role sets
//
// Every gated action names the roles that may perform it, here, in one place.
// The three web "roles" used to be a choice of which page opened: the server
// saw one key and one permission level, so a café seller who edited two
// localStorage values could read the ledger and run a migration. These lists
// are what make the roles real, and they are enforced on the server where a
// browser cannot reach them.

/** Anybody who is signed in, whichever role they hold. */
var AUTH_ROLES_ANY = [AUTH_ROLE_OMAD_ADMIN, AUTH_ROLE_CAFE_ADMIN, AUTH_ROLE_CAFE_SELLER];

/** The accounting, the settings, the migration, the maintenance, the tasks. */
var AUTH_ROLES_OMAD_ADMIN = [AUTH_ROLE_OMAD_ADMIN];

/** Reading the café: the till, the café manager, and the owner. */
var AUTH_ROLES_CAFE_READ = [AUTH_ROLE_OMAD_ADMIN, AUTH_ROLE_CAFE_ADMIN, AUTH_ROLE_CAFE_SELLER];

/** Editing the catalogue: prices, recipes, categories, the daily target. */
var AUTH_ROLES_CAFE_ADMIN = [AUTH_ROLE_OMAD_ADMIN, AUTH_ROLE_CAFE_ADMIN];

/** Ringing up, voiding and closing the day. */
var AUTH_ROLES_CAFE_SELL = [AUTH_ROLE_OMAD_ADMIN, AUTH_ROLE_CAFE_SELLER];

function doPost(e) {
  // Anything memoised for the life of a request starts empty. Apps Script
  // gives each execution a fresh global scope so this is already true in
  // production, but saying it here means the guarantee is in the code rather
  // than in an assumption about the runtime -- and it is what makes the memos
  // safe under a test harness that serves many requests from one load.
  resetRequestMemos_();

  var doc = SpreadsheetApp.getActiveSpreadsheet();
  var isTelegramWebhook = false;

  try {
    var payload = JSON.parse((e.postData && e.postData.contents) || "{}");
    var action = payload.action;
    var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");

    // ---- Telegram webhook -------------------------------------------------
    if (!action && (payload.message || payload.callback_query)) {
      isTelegramWebhook = true;
      // Apps Script cannot read request headers, so Telegram's
      // X-Telegram-Bot-Api-Secret-Token is not observable here. The safest
      // mechanism actually available is a high-entropy secret in the webhook
      // URL itself, which is exactly what setWebhook stores and only Telegram
      // ever learns. Requests without it are dropped before any state changes.
      if (!isVerifiedTelegramWebhookRequest_(e)) {
        debugLog_(doc, "telegram_webhook_rejected", "missing or invalid webhook secret");
        return okHtmlOutput_();
      }
      // Task callbacks and Tasks-group photo/reply messages are handled in
      // their own namespace, entirely separate from the private /yangi flow.
      // Everything else falls through to the accounting handler unchanged.
      if (isTaskTelegramUpdate_(payload)) {
        return handleTaskTelegramUpdate_(payload, doc, configSheet);
      }
      return handleOmadTelegramUpdate_(payload, doc, configSheet);
    }

    // ---- Telegram Mini App ------------------------------------------------
    // Placed before everything else so a mini_* action can never fall through
    // into a handler with a different gate. Authorized by verified Telegram
    // initData only; the admin key is neither sent to it nor accepted from it.
    if (isMiniAppAction_(action)) {
      return handleMiniAppAction_(action, payload, doc);
    }

    // ---- Sign in ----------------------------------------------------------
    // The only unauthenticated action there is. It is routed after the Mini
    // App and before everything else so nothing can reach a gated handler
    // through it, and it never answers with anything but a token.
    if (action === 'login') {
      return jsonOutput_(loginAction_(payload));
    }

    // ---- Task management --------------------------------------------------
    if (isTaskAction_(action)) {
      return handleTaskAction_(action, payload, doc);
    }

    // ---- Session & account ------------------------------------------------
    // verify_access is what a page calls on load to find out whether its stored
    // session is still good and which role it carries, so every signed-in role
    // may call it.
    if (action === 'verify_access' || action === 'change_password') {
      var sessionAuth = authorizeWebRequest_(payload, AUTH_ROLES_ANY);
      if (!sessionAuth.ok) return authRefusal_(sessionAuth);
      if (action === 'change_password') return jsonOutput_(changePasswordAction_(sessionAuth, payload));
      return jsonOutput_({
        status: "success", role: sessionAuth.role, username: sessionAuth.username,
        home: AUTH_ROLE_HOME[sessionAuth.role] || "login.html",
        bootstrap: !!sessionAuth.bootstrap
      });
    }

    if (action === 'set_user_password' || action === 'list_users') {
      var accountAuth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!accountAuth.ok) return authRefusal_(accountAuth);
      if (action === 'list_users') return jsonOutput_({ status: "success", users: listAuthUsers_() });
      return jsonOutput_(setUserPasswordAction_(payload));
    }

    // ---- Authenticated reads ----------------------------------------------
    // The financial ledger, the tenant list and the whole café state are the
    // business's private data, and the two reads are gated differently: a café
    // seller has no business reading the ledger, and could previously do so by
    // editing one localStorage value.
    if (action === 'get_omad_data') {
      var omadReadAuth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!omadReadAuth.ok) return authRefusal_(omadReadAuth);
      return jsonOutput_(readOmadPayload_(doc, configSheet));
    }

    if (action === 'get_cafe_data') {
      var cafeReadAuth = authorizeWebRequest_(payload, AUTH_ROLES_CAFE_READ);
      if (!cafeReadAuth.ok) return authRefusal_(cafeReadAuth);
      return jsonOutput_(readCafePayloadForScope_(doc, configSheet, payload));
    }

    // ---- Omad ledger ------------------------------------------------------
    // Financial writes are omad_admin only. They were reachable by anyone who
    // knew the /exec URL, which meant anyone could rewrite the whole ledger.
    if (action === 'migrate_omad' || action === 'save_omad') {
      var saveAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!saveAccess.ok) return authRefusal_(saveAccess);
      return saveOmadAction_(action, payload, doc, configSheet);
    }

    if (action === 'tenant_paid_expense') {
      var pairAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!pairAccess.ok) return authRefusal_(pairAccess);
      return tenantPaidExpenseAction_(payload, doc, configSheet);
    }

    // ---- Append-only ledger -----------------------------------------------
    if (isLedgerAction_(action)) {
      var ledgerAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!ledgerAccess.ok) return authRefusal_(ledgerAccess);
      return ledgerAction_(action, payload, doc);
    }

    // ---- Retry queue ------------------------------------------------------
    if (action === 'get_job_queue_status') {
      var queueAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!queueAccess.ok) return authRefusal_(queueAccess);
      return jsonOutput_({ status: "success", queue: buildJobQueueStatus_(doc) });
    }

    if (action === 'process_jobs') {
      var jobsAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!jobsAccess.ok) return authRefusal_(jobsAccess);
      var processed = processPendingJobs_(doc, JOB_QUEUE_MANUAL_BATCH);
      return jsonOutput_({ status: "success", processed: processed, queue: buildJobQueueStatus_(doc) });
    }

    // ---- Telegram settings ------------------------------------------------
    // The view carries no secret, but it does carry the authorized user id and
    // both group chat ids -- enough to know exactly who and where to target.
    if (action === 'get_telegram_settings') {
      var settingsAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!settingsAccess.ok) return authRefusal_(settingsAccess);
      return jsonOutput_({ status: "success", settings: buildTelegramSettingsView_() });
    }

    if (isTelegramAdminAction_(action)) {
      return telegramAdminAction_(action, payload);
    }

    // ---- System & data ----------------------------------------------------
    // Counts and event names only, but the audit tail names tasks, people and
    // operations, and the counts describe the size of the business.
    if (action === 'get_system_status') {
      var statusAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!statusAccess.ok) return authRefusal_(statusAccess);
      return jsonOutput_({ status: "success", system: buildSystemStatus_(doc) });
    }

    if (action === 'create_backup' || action === 'retry_failed_jobs') {
      var systemAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!systemAccess.ok) return authRefusal_(systemAccess);
      var systemResult = action === 'create_backup'
        ? createManualBackup_(doc)
        : retryFailedJobs_(doc);
      systemResult.system = buildSystemStatus_(doc);
      return jsonOutput_(systemResult);
    }

    // ---- Maintenance ------------------------------------------------------
    if (isMaintenanceAction_(action)) {
      return maintenanceAction_(action, payload, doc);
    }

    // ---- Health & Mini App configuration ----------------------------------
    if (action === 'get_health' || action === 'configure_mini_app') {
      var healthAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!healthAccess.ok) return authRefusal_(healthAccess);
      if (action === 'configure_mini_app') return jsonOutput_(configureMiniApp_(payload));
      return jsonOutput_({ status: "success", health: buildHealthReport_(doc) });
    }

    // ---- Migration --------------------------------------------------------
    if (action === 'get_migration_status') {
      var migrationRead = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!migrationRead.ok) return authRefusal_(migrationRead);
      return jsonOutput_({ status: "success", migration: getMigrationStatus_(doc) });
    }

    if (isMigrationAction_(action)) {
      var migrationAccess = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
      if (!migrationAccess.ok) return authRefusal_(migrationAccess);
      return migrationAction_(action, payload, doc);
    }

    // ---- Café -------------------------------------------------------------
    var cafeResponse = handleCafeAction_(action, payload, doc, configSheet);
    if (cafeResponse) return cafeResponse;

    return jsonOutput_({ status: "error", message: "Unknown action" });
  } catch (error) {
    if (isTelegramWebhook) {
      // Never return a non-200 to Telegram: it would redeliver the update.
      try {
        debugLog_(doc, "telegram_webhook_error", error.toString());
      } catch (logError) {}
      return okHtmlOutput_();
    }
    return jsonOutput_({ status: "error", message: error.toString() });
  }
}

/**
 * The GET surface, which is now entirely inert.
 *
 * Nothing readable is served over GET at all: a GET puts its parameters in the
 * URL, and the URL is the one place an access key must never be, so every
 * authenticated read is a POST. This exists to answer the browser, the uptime
 * check and the curious with the same sentence.
 */
function doGet(e) {
  // Nothing here reads System_Config today. It is reset anyway so that "every
  // entry point starts with empty memos" stays true of the code rather than of
  // one reading of it.
  resetRequestMemos_();

  var action = (e && e.parameter && e.parameter.action) || "";

  if (action === 'get_tasks') {
    // A GET puts its parameters in the URL, which is exactly where an admin key
    // must never be. Task reads are POST-only.
    return jsonOutput_({
      status: "error",
      message: "Vazifalar ma'lumoti faqat POST va admin kaliti bilan olinadi."
    });
  }

  // `get_omad` and `get_cafe` used to answer here, unauthenticated, and that
  // was the whole exposure: the /exec URL is hardcoded in pages served from a
  // public site, so everyone who had seen the frontend could read the ledger,
  // the tenant list and every café sale with its margin. They are gone. The
  // authenticated replacements are get_omad_data / get_cafe_data over POST,
  // where the key travels in the body instead of the URL.
  //
  // Nothing is special-cased for them: an unknown action falls through to the
  // banner below, so they are indistinguishable from any other name someone
  // might try.
  return ContentService.createTextOutput("System Database is Active.");
}

/**
 * Saves the Omad state and queues the report the browser asked for.
 * The financial write and the report are deliberately separate: the report is
 * a retryable job that can never fail the save and can never duplicate it.
 */
function saveOmadAction_(action, payload, doc, configSheet) {
  var reportError = validateOmadTelegramReport_(payload.telegramReport);
  if (reportError) return jsonOutput_({ status: "error", message: reportError });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    backupOmadState_(doc, configSheet, action);
    safeSaveOmad_(doc, configSheet, payload);
  } finally {
    lock.releaseLock();
  }

  recordLastOperation_(doc, action);

  var queuedJobId = "";
  try {
    queuedJobId = queueOmadTransactionReport_(doc, payload.telegramReport);
  } catch (queueError) {
    debugLog_(doc, "report_enqueue_failed", String(queueError));
  }
  drainJobQueueQuietly_(doc, payload);

  return jsonOutput_({ status: "success", reportJobId: queuedJobId || "" });
}

/**
 * One tenant-paid expense: two linked rows, one group, one report.
 *
 * The backup happens before the write for the same reason every other Omad
 * write takes one. The report is queued afterwards and, as everywhere else,
 * failing to queue it never undoes a pair that is already stored.
 */
function tenantPaidExpenseAction_(payload, doc, configSheet) {
  backupOmadState_(doc, configSheet, "tenant_paid_expense");

  var result = createTenantPaidExpense_(doc, payload);
  if (result.status !== "success") return jsonOutput_(result);

  recordLastOperation_(doc, "tenant_paid_expense");

  if (!result.duplicate) {
    try {
      result.reportJobId = enqueueJob_(doc, "omad_transaction_report", result.groupId, {
        groupId: result.groupId,
        baseId: String((result.transactions[0] || {}).id || "").split("_")[0],
        // An edited pair keeps its group message, so the report is edited in
        // place rather than a second one appearing beside a stale first.
        messageId: String(result.messageId || "")
      }) || "";
    } catch (queueError) {
      result.reportJobId = "";
      debugLog_(doc, "report_enqueue_failed", String(queueError));
    }
    drainJobQueueQuietly_(doc, payload);
  }

  return jsonOutput_(result);
}

function isTelegramAdminAction_(action) {
  return action === 'save_telegram_settings' ||
         action === 'test_telegram_connection' ||
         action === 'send_telegram_test_message' ||
         action === 'configure_telegram_webhook';
}

/**
 * Rate limited and length-checked *before* the admin key is compared, so the
 * endpoint cannot be used to brute-force the key or to hammer Telegram.
 */
function telegramAdminAction_(action, payload) {
  var throttled = enforceRateLimit_("tg_admin", TELEGRAM_ADMIN_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  if (throttled) return jsonOutput_({ status: "error", message: throttled });

  var lengthError = validateTelegramPayloadLengths_(payload);
  if (lengthError) return jsonOutput_({ status: "error", message: lengthError });

  var auth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
  if (!auth.ok) return authRefusal_(auth);

  if (action === 'save_telegram_settings') return jsonOutput_(saveTelegramSettings_(payload));
  if (action === 'test_telegram_connection') return jsonOutput_(testTelegramConnection_());
  if (action === 'send_telegram_test_message') return jsonOutput_(sendTelegramTestMessage_());
  return jsonOutput_(configureTelegramWebhook_(payload));
}

/**
 * Everything omad_admin.html needs on load, in one round trip.
 *
 * `migration` used to be a second request the page fired immediately after
 * this one, which on Apps Script is another cold-start-and-lock round trip
 * before the dashboard can decide whether the ledger is live. It is four
 * Script Property reads, so it rides along.
 */
function readOmadPayload_(doc, configSheet) {
  return {
    status: "success",
    transactions: readOmadTransactions_(doc),
    tenants: normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), [])),
    rates: safeParseJSON_(getConfig(configSheet, "Omad_Rates"), { "Fevral": 12500 }),
    templateExpenses: normalizeTemplateExpenses_(
      safeParseJSON_(getConfig(configSheet, "Omad_Template_Expenses"), [])),
    migration: getMigrationStatus_(doc)
  };
}

function isMaintenanceAction_(action) {
  return action === 'audit_transaction_dates' ||
         action === 'fix_transaction_dates' ||
         action === 'backfill_entry_group_ids' ||
         action === 'purge_telegram_debug_secrets' ||
         action === 'audit_telegram_secret_exposure' ||
         action === 'rotate_telegram_webhook_secret';
}

/**
 * One-off repairs to live data and live configuration.
 *
 * Every one of these reads the whole ledger, rewrites stored rows or changes a
 * credential, so all of them take the admin key — including the audit, which
 * would otherwise report on financial rows to anyone who asked.
 */
function maintenanceAction_(action, payload, doc) {
  var auth = authorizeWebRequest_(payload, AUTH_ROLES_OMAD_ADMIN);
  if (!auth.ok) return authRefusal_(auth);

  if (action === 'audit_transaction_dates') {
    return jsonOutput_({ status: "success", audit: auditTransactionDates_(doc) });
  }
  if (action === 'fix_transaction_dates') {
    return jsonOutput_(fixTransposedTransactionDates_(doc, { dryRun: payload.dryRun === true }));
  }
  if (action === 'backfill_entry_group_ids') {
    return jsonOutput_(backfillEntryGroupIds_(doc));
  }
  if (action === 'purge_telegram_debug_secrets') {
    return jsonOutput_(purgeTelegramDebugSecrets_(doc));
  }
  if (action === 'audit_telegram_secret_exposure') {
    return jsonOutput_(auditTelegramSecretExposure_(doc));
  }
  return jsonOutput_(rotateTelegramWebhookSecret_(payload));
}

function isMigrationAction_(action) {
  return action === 'preview_omad_migration' ||
         action === 'apply_omad_migration' ||
         action === 'verify_omad_migration' ||
         action === 'cutover_omad_migration' ||
         action === 'rollback_omad_migration';
}

/**
 * Every migration step is admin-key protected: they read the whole ledger and
 * three of them change which sheet the app reads from.
 */
function migrationAction_(action, payload, doc) {
  var options = {
    fallbackYear: Number(payload.fallbackYear) || 0,
    allowUnresolved: payload.allowUnresolved === true
  };

  if (action === 'preview_omad_migration') {
    return jsonOutput_({ status: "success", preview: previewOmadMigration_(doc, options) });
  }
  if (action === 'apply_omad_migration') {
    var applied = applyOmadMigration_(doc, options);
    applied.migration = getMigrationStatus_(doc);
    return jsonOutput_(applied);
  }
  if (action === 'verify_omad_migration') {
    return jsonOutput_({ status: "success", verification: verifyOmadMigration_(doc) });
  }
  if (action === 'cutover_omad_migration') {
    var cutover = cutoverOmadMigration_(doc);
    cutover.migration = getMigrationStatus_(doc);
    return jsonOutput_(cutover);
  }
  var rolledBack = rollbackOmadMigration_(doc);
  rolledBack.migration = getMigrationStatus_(doc);
  return jsonOutput_(rolledBack);
}

function isLedgerAction_(action) {
  return action === 'create_transaction' ||
         action === 'correct_transaction' ||
         action === 'cancel_transaction' ||
         action === 'list_transactions' ||
         action === 'get_transaction' ||
         action === 'get_transaction_history';
}

/**
 * Individual transaction operations. They require the migrated ledger, because
 * the legacy sheet has no status column and therefore cannot record a
 * correction or a cancellation without losing the original.
 */
function ledgerAction_(action, payload, doc) {
  if (action === 'list_transactions') {
    return jsonOutput_({
      status: "success",
      transactions: isLedgerActive_(doc)
        ? listActiveTransactions_(doc, {
            period: payload.period || "",
            tenant: payload.tenant || "",
            type: payload.type || ""
          })
        : readOmadTransactions_(doc)
    });
  }

  if (action === 'get_transaction') {
    var found = getTransaction_(doc, payload.transactionId);
    if (!found) return jsonOutput_({ status: "error", message: "Tranzaksiya topilmadi." });
    return jsonOutput_({ status: "success", transaction: found });
  }

  if (action === 'get_transaction_history') {
    var history = getTransactionHistory_(doc, payload.transactionId);
    if (!history) return jsonOutput_({ status: "error", message: "Tranzaksiya topilmadi." });
    return jsonOutput_({ status: "success", history: history });
  }

  if (!isLedgerActive_(doc)) {
    return jsonOutput_({
      status: "error",
      message: "Yangi tranzaksiya tizimi hali yoqilmagan. Avval ma'lumotlarni ko'chiring."
    });
  }

  var result;
  if (action === 'create_transaction') result = createTransaction_(doc, payload);
  else if (action === 'correct_transaction') result = correctTransaction_(doc, payload);
  else result = cancelTransaction_(doc, payload);

  if (result.status === "success") {
    recordLastOperation_(doc, action);
    // The financial record is committed. Reporting is a separate retryable job,
    // and even failing to *queue* it must not undo a save the caller was about
    // to be told succeeded.
    try {
      result.reportJobId = queueLedgerReport_(doc, action, result) || "";
    } catch (queueError) {
      result.reportJobId = "";
      result.reportQueueError = redactSecrets_(queueError).slice(0, 300);
      debugLog_(doc, "report_enqueue_failed", String(queueError));
    }
    drainJobQueueQuietly_(doc, payload);
  }
  return jsonOutput_(result);
}

/** Queues the Telegram report that matches the operation just performed. */
function queueLedgerReport_(doc, action, result) {
  if (result.duplicate) return "";
  var transaction = result.transaction || {};

  if (action === 'cancel_transaction') {
    if (!transaction.msgId) return "";
    return enqueueJob_(doc, "omad_transaction_delete_report", transaction.id, {
      messageId: String(transaction.msgId)
    });
  }

  return enqueueJob_(doc, "omad_transaction_report", transaction.id, {
    groupId: String(transaction.groupId || ""),
    baseId: String(transaction.id).split("_")[0],
    messageId: String(transaction.msgId || "")
  });
}

// ----- apps-script/21_miniapp_auth.gs ------------------------------------------

// ============================================================
// Telegram Mini App authentication
// ------------------------------------------------------------
// The Mini App is opened from inside Telegram, which hands the page a signed
// `initData` string. Telegram signs it with a key derived from the bot token,
// so a caller who does not hold the bot token cannot produce a valid one — and
// the bot token never leaves Script Properties.
//
// This is the ONLY thing that authorizes a Mini App request. In particular it
// never trusts:
//
//   - a user id in the URL or the payload
//   - a username (changeable, and re-registrable by someone else)
//   - `initDataUnsafe` (the client-side copy, unsigned by definition)
//   - anything stored in the browser
//
// There is no second user database. The verified numeric id is compared
// against TELEGRAM_AUTHORIZED_USER_ID — the same property that decides who may
// run /yangi and file a task from the bot.
// ============================================================

/**
 * How old a signed payload may be.
 *
 * Telegram refreshes `initData` when the Mini App is opened, but not while it
 * stays open, so this is a session length rather than a request lifetime: too
 * short and a Mini App left open in the background stops working mid-edit.
 * A day is long enough for that and short enough that a captured payload —
 * which would already require access to the authorized user's device — is not
 * usable indefinitely.
 */
var MINI_APP_MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

/** Rate limit for verification attempts, so the endpoint cannot be hammered. */
var MINI_APP_RATE_LIMIT = 60;

var MINI_APP_OPEN_IN_TELEGRAM_MESSAGE = "Bu sahifani Telegram bot orqali oching.";
var MINI_APP_FORBIDDEN_MESSAGE = "⛔️ Sizda bu ilovadan foydalanish huquqi yo'q.";

/** Percent-decoding for one `application/x-www-form-urlencoded` component. */
function decodeQueryComponent_(value) {
  var text = String(value === null || value === undefined ? "" : value).split("+").join(" ");
  try {
    return decodeURIComponent(text);
  } catch (error) {
    // A malformed escape is not a reason to throw: it simply will not match
    // the signature, which is the answer we want anyway.
    return text;
  }
}

/**
 * initData as an ordered list of raw `key=value` pairs.
 *
 * The values must be compared *decoded* but signed *decoded* too, per
 * Telegram's rules: the data-check string is built from decoded values.
 */
function parseInitDataPairs_(initData) {
  var text = String(initData || "");
  if (!text) return [];
  var parts = text.split("&");
  var pairs = [];
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var split = parts[i].indexOf("=");
    if (split === -1) continue;
    pairs.push({
      key: decodeQueryComponent_(parts[i].slice(0, split)),
      value: decodeQueryComponent_(parts[i].slice(split + 1))
    });
  }
  return pairs;
}

function bytesToHex_(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i++) {
    // Apps Script signature bytes are signed; & 0xff brings them back.
    var part = (bytes[i] & 0xff).toString(16);
    out += part.length === 1 ? "0" + part : part;
  }
  return out;
}

/**
 * Compares two hex digests without leaking where they first differ.
 *
 * secretsMatch_ already does this for the webhook secret; this keeps the same
 * property for a value an attacker can submit repeatedly.
 */
function hexDigestsMatch_(a, b) {
  var left = String(a || "").toLowerCase();
  var right = String(b || "").toLowerCase();
  if (left.length !== right.length) return false;
  var difference = 0;
  for (var i = 0; i < left.length; i++) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * Verifies Telegram's signature over initData.
 *
 * Returns `{ ok, user, authDate, reason }`. `reason` is a short machine
 * readable code; nothing it contains is ever derived from a secret.
 */
function verifyTelegramInitData_(initData, nowMs) {
  var token = getBotToken_();
  if (!token) return { ok: false, reason: "bot_token_missing" };

  var pairs = parseInitDataPairs_(initData);
  if (pairs.length === 0) return { ok: false, reason: "missing_init_data" };

  var hash = "";
  var checkPairs = [];
  for (var i = 0; i < pairs.length; i++) {
    if (pairs[i].key === "hash") { hash = pairs[i].value; continue; }
    checkPairs.push(pairs[i]);
  }
  if (!hash) return { ok: false, reason: "missing_hash" };

  checkPairs.sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0); });
  var lines = [];
  for (var j = 0; j < checkPairs.length; j++) {
    lines.push(checkPairs[j].key + "=" + checkPairs[j].value);
  }
  var dataCheckString = lines.join("\n");

  // secret_key = HMAC_SHA256(bot_token, "WebAppData"), then the digest of the
  // data-check string under that key. Both steps are HMAC(message, key).
  var secretKey = Utilities.computeHmacSha256Signature(token, "WebAppData");
  var digest = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(dataCheckString).getBytes(), secretKey);

  if (!hexDigestsMatch_(bytesToHex_(digest), hash)) return { ok: false, reason: "bad_signature" };

  var authDate = 0;
  for (var k = 0; k < checkPairs.length; k++) {
    if (checkPairs[k].key === "auth_date") authDate = Number(checkPairs[k].value) || 0;
  }
  if (!authDate) return { ok: false, reason: "missing_auth_date" };

  var now = Math.floor((nowMs === undefined ? Date.now() : nowMs) / 1000);
  // A payload dated in the future is as wrong as one that is too old.
  if (authDate > now + 300) return { ok: false, reason: "auth_date_in_future" };
  if (now - authDate > MINI_APP_MAX_AUTH_AGE_SECONDS) return { ok: false, reason: "stale" };

  var user = null;
  for (var u = 0; u < checkPairs.length; u++) {
    if (checkPairs[u].key === "user") user = safeParseJSON_(checkPairs[u].value, null);
  }
  if (!user || (user.id === undefined || user.id === null || user.id === "")) {
    return { ok: false, reason: "missing_user" };
  }

  return { ok: true, user: user, authDate: authDate, reason: "" };
}

/**
 * Authorizes one Mini App request.
 *
 * Signature first, then identity: a valid signature proves the payload came
 * from Telegram, and only then does the verified numeric id decide whether
 * this particular person may see anything.
 */
function authorizeMiniAppRequest_(payload) {
  var throttled = enforceRateLimit_("mini_auth", MINI_APP_RATE_LIMIT, TELEGRAM_RATE_WINDOW_SECONDS);
  if (throttled) return { ok: false, message: throttled };

  var verified = verifyTelegramInitData_((payload && payload.initData) || "");
  if (!verified.ok) {
    return {
      ok: false,
      reason: verified.reason,
      // Nothing here tells a caller how to forge a better attempt.
      message: verified.reason === "stale"
        ? "Sessiya muddati tugadi. Ilovani qaytadan oching."
        : MINI_APP_OPEN_IN_TELEGRAM_MESSAGE
    };
  }

  if (!isAuthorizedTelegramUser_(verified.user.id)) {
    return { ok: false, reason: "not_authorized", message: MINI_APP_FORBIDDEN_MESSAGE };
  }

  return {
    ok: true,
    userId: String(verified.user.id),
    user: {
      id: String(verified.user.id),
      firstName: String(verified.user.first_name || "").slice(0, 100),
      username: String(verified.user.username || "").slice(0, 100)
    }
  };
}

// ----- apps-script/22_miniapp_api.gs -------------------------------------------

// ============================================================
// Telegram Mini App API
// ------------------------------------------------------------
// Every action here is authorized by authorizeMiniAppRequest_ and by nothing
// else. The admin key is never sent to the Mini App and is not accepted from
// it — a phone screen is the wrong place for the key that also unlocks the
// settings and the maintenance actions.
//
// Nothing in this file re-implements a calculation. Figures come from
// 05a_calculations.gs, tenant debt from 06_tenants.gs, tasks from
// 17_tasks_store.gs and the tenant-paid pair from 08a_tenant_paid.gs, so the
// Mini App cannot drift from the numbers the web app and the reports show.
//
// The responses are *summaries*. The café state alone is a third of a
// megabyte; sending it to a phone to be totalled there would be slow and would
// be a second implementation of the same arithmetic.
// ============================================================

var MINI_APP_RECENT_TRANSACTIONS = 15;
var MINI_APP_RECENT_SALES = 10;
var MINI_APP_RECENT_CLOSINGS = 5;

/**
 * How long a Mini App summary may be reused.
 *
 * Short, and secondary: the cache key carries the data revision, so any write
 * to the ledger, the tenant list, the rates or the café makes the stored
 * answer unreachable at once. This is the backstop for a write path that has
 * not been taught to bump — a minute of staleness on a *display* summary, on a
 * phone, where the only alternative was rescanning the whole ledger for a
 * screen that had not changed.
 */
var MINI_APP_SUMMARY_TTL_SECONDS = 60;

/**
 * Fields the caller may never contribute to — the answer to "who did this".
 *
 * The task engine reads all of these straight off the payload. A Mini App
 * request carries a signature that proves which Telegram account is calling,
 * so that account is the only possible author; any value arriving under these
 * names is somebody else's name being typed into an audit trail. They are
 * deleted from the payload before it reaches the engine, and the verified
 * values are written back afterwards.
 */
var MINI_IDENTITY_FIELDS = {
  completedById: true,
  completedBy: true,
  completedByName: true,
  completedSource: true,
  createdBy: true,
  proofAwaitingUserId: true
};

function isMiniAppAction_(action) {
  return String(action || "").indexOf("mini_") === 0;
}

function handleMiniAppAction_(action, payload, doc) {
  var auth = authorizeMiniAppRequest_(payload);
  if (!auth.ok) {
    return jsonOutput_({ status: "error", authorized: false, reason: auth.reason || "", message: auth.message });
  }

  var configSheet = doc.getSheetByName("System_Config") || doc.insertSheet("System_Config");

  // The first screen is Omad, so the first request answers Omad completely and
  // nothing else. It used to also build the café summary and the whole task
  // view — two more full sheet reads for tabs the user had not opened, and in
  // the task case for counts no screen ever rendered. Café and Tasks are
  // fetched when their tab is first opened.
  if (action === 'mini_home' || action === 'mini_omad') {
    var response = miniOmadSnapshot_(doc, configSheet, payload.period);
    if (action === 'mini_home') response = Object.assign({ user: auth.user }, response);
    return jsonOutput_(response);
  }

  if (action === 'mini_cafe') {
    return jsonOutput_({
      status: "success", authorized: true,
      cafe: cachedSummary_("mini_cafe", CACHE_SCOPE_CAFE, MINI_APP_SUMMARY_TTL_SECONDS, function () {
        return buildMiniCafeSummary_(doc, configSheet);
      })
    });
  }

  if (action === 'mini_tasks') {
    return jsonOutput_({
      status: "success", authorized: true,
      view: cachedTaskView_(doc),
      config: { tasksGroupConfigured: !!getTasksGroupChatId_() }
    });
  }

  if (action === 'mini_save_transaction') return miniSaveTransaction_(doc, configSheet, payload);
  if (action === 'mini_tenant_paid') return miniTenantPaid_(doc, configSheet, payload);
  if (action === 'mini_task_action') return miniTaskAction_(doc, payload, auth);

  // Sending the group card is a Telegram round trip, and a phone on a slow
  // connection should not be holding a spinner through it. The write returns
  // as soon as the record is stored, and the client calls this afterwards
  // without waiting for the answer, so the card still appears in seconds
  // instead of waiting for the next five-minute trigger tick. Losing this
  // request costs nothing: the job stays queued and the trigger sends it.
  if (action === 'mini_flush_reports') {
    return jsonOutput_({ status: "success", authorized: true, sent: drainJobQueueQuietly_(doc, null) });
  }

  return jsonOutput_({ status: "error", message: "Unknown action" });
}

// ------------------------------------------------------------------- reading

/**
 * The whole Omad tab, cached against the accounting revision.
 *
 * The opening screen was a full scan of the historical ledger every time the
 * Mini App was opened, and opening it again a minute later scanned it again to
 * produce byte-for-byte the same answer. The scan still happens — it is the
 * only way to be right — but only once per period per change to the data.
 *
 * The user identity is deliberately *not* part of this: the summary is the
 * business's figures, the same for whoever is authorized to see them, and only
 * one person is. `user` is attached outside the cache so the stored value can
 * never carry somebody's name into somebody else's response.
 */
function miniOmadSnapshot_(doc, configSheet, requestedPeriod) {
  var period = isCanonicalPeriod_(requestedPeriod) ? String(requestedPeriod) : "";
  return cachedSummary_("mini_omad_" + period, CACHE_SCOPE_OMAD, MINI_APP_SUMMARY_TTL_SECONDS,
    function () {
      var ctx = miniOmadContext_(doc, configSheet, requestedPeriod);
      return {
        status: "success", authorized: true,
        omad: buildMiniOmadSummary_(ctx),
        tenants: buildMiniTenantStatus_(ctx),
        transactions: buildMiniRecentEntries_(ctx)
      };
    });
}

/**
 * Everything the Omad screens read, fetched once per request.
 *
 * The three builders below each used to call `readOmadTransactions_` for
 * themselves, so answering one Mini App request read the whole ledger three
 * times over — and the tenant list and the rate table with it. They are the
 * same rows every time inside a single request, so they are read once here and
 * passed down.
 */
function miniOmadContext_(doc, configSheet, requestedPeriod) {
  var period = isCanonicalPeriod_(requestedPeriod) ? String(requestedPeriod) : currentPeriod_();
  var transactions = readOmadTransactions_(doc);
  return {
    doc: doc,
    // Resolved once here so the summary, the tenant list and the pre-aggregated
    // totals cannot end up describing different months.
    period: period,
    requestedPeriod: requestedPeriod,
    transactions: transactions,
    tenants: normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), [])),
    rates: getOmadRates_(),
    // The summary and the per-tenant list both need what each tenant paid, and
    // each was walking the ledger once per tenant to find out. One pass here
    // serves both.
    paidTotals: tenantPaidTotals_(transactions, period),
    ledgerActive: isLedgerActive_(doc)
  };
}

/** The month figures, the balances and the tenant debt total, for one period. */
function buildMiniOmadSummary_(ctx) {
  var period = ctx.period;
  var transactions = ctx.transactions;
  var tenants = ctx.tenants;
  var rates = ctx.rates;
  var actuals = calculateActuals_(transactions, period);

  // calculateTenantBalance_ reports a signed difference: negative is owed.
  // Debt and surplus are derived here rather than re-deriving the rent rules.
  var debt = 0;
  var paidTenants = 0;
  for (var i = 0; i < tenants.length; i++) {
    var balance = calculateTenantBalance_(transactions, tenants[i], period, ctx.paidTotals);
    if (balance.difference < 0) debt += -balance.difference;
    else if (balance.expected > 0) paidTenants++;
  }

  var entry = getPeriodRate_(rates, period);
  return {
    period: period,
    periodLabel: formatPeriodLabel_(period),
    income: actuals.income,
    expense: actuals.expense,
    net: actuals.net,
    cash: actuals.cash,
    bank: actuals.bank,
    total: actuals.total,
    tenantDebt: Math.round(debt),
    tenantCount: tenants.length,
    tenantsSettled: paidTenants,
    rate: { buy: entry.buy, sell: entry.sell },
    ledgerActive: ctx.ledgerActive
  };
}

/** Per-tenant expected / paid / debt for the period, smallest debt last. */
function buildMiniTenantStatus_(ctx) {
  var period = ctx.period;
  var transactions = ctx.transactions;
  var tenants = ctx.tenants;

  var rows = [];
  for (var i = 0; i < tenants.length; i++) {
    if (tenants[i].active === false) continue;
    var balance = calculateTenantBalance_(transactions, tenants[i], period, ctx.paidTotals);
    rows.push({
      name: tenants[i].name,
      expected: Math.round(balance.expected),
      paid: Math.round(balance.paid),
      debt: Math.round(balance.difference < 0 ? -balance.difference : 0),
      surplus: Math.round(balance.difference > 0 ? balance.difference : 0)
    });
  }
  rows.sort(function (a, b) { return b.debt - a.debt; });
  return rows;
}

/**
 * Recent activity as *business actions* rather than rows.
 *
 * The Mini App shows the same thing the history tab does: a tenant-paid pair
 * is one entry, and the several lines of one payment are one entry with a
 * total, so the reader is never asked to pair rows up themselves.
 */
function buildMiniRecentEntries_(ctx) {
  var transactions = ctx.transactions;
  // Unlike the summary, an unrecognised period here means "no filter" rather
  // than "this month", so the list is never silently empty.
  var period = isCanonicalPeriod_(ctx.requestedPeriod) ? String(ctx.requestedPeriod) : "";
  var rates = ctx.rates;

  var order = [];
  var groups = {};
  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    if (period && transactionPeriod_(t) !== period) continue;
    var key = String(t.groupId || "");
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(t);
  }

  var entries = [];
  for (var g = 0; g < order.length; g++) {
    var rows = groups[order[g]];
    var first = rows[0];
    var total = 0;
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].type === "Income") total += transactionUZS_(rows[r], rates);
    }
    var tenantPaid = isTenantPaidGroup_(rows);
    var income = null;
    for (var q = 0; q < rows.length; q++) if (rows[q].type === "Income") { income = rows[q]; break; }
    var lead = tenantPaid ? (income || first) : first;
    if (!tenantPaid) {
      total = 0;
      for (var s = 0; s < rows.length; s++) total += transactionUZS_(rows[s], rates);
    }

    entries.push({
      groupId: order[g],
      id: lead.id,
      kind: tenantPaid ? ENTRY_KIND_TENANT_PAID : "",
      type: lead.type,
      tenant: lead.tenant,
      period: transactionPeriod_(lead),
      periodLabel: formatPeriodLabel_(transactionPeriod_(lead)),
      date: typeof lead.date === "object" && lead.date ? formatLedgerDate_(lead.date) : String(lead.date || ""),
      amountUZS: Math.round(total),
      currency: lead.currency,
      amount: lead.amount,
      lines: rows.length,
      comment: String(lead.comment || "").slice(0, 300)
    });
  }

  // Newest first, by the timestamp the ids encode.
  entries.sort(function (a, b) {
    return (Number(String(b.id).split("_")[0]) || 0) - (Number(String(a.id).split("_")[0]) || 0);
  });
  return entries.slice(0, MINI_APP_RECENT_TRANSACTIONS);
}

/**
 * Today and this month, from the café sheets. Monitoring only.
 *
 * This is a read of totals, so it reads totals. It used to go through
 * `readCafeState_`, which parses the receipt JSON of every sale ever made
 * because the admin screen edits receipts — several hundred JSON.parse calls
 * to produce a line count for the ten most recent, plus the recipe list and
 * the category list, which nothing on this screen shows.
 */
function buildMiniCafeSummary_(doc, configSheet) {
  var sales = readCafeSalesLean_(doc);
  var closeReports = readCafeClosingsLean_(doc);
  var inventory = safeParseJSON_(getConfigOnce_(configSheet, "Cafe_Inventory"), []);
  var settings = safeParseJSON_(getConfigOnce_(configSheet, "Cafe_Settings"), { dailyTarget: 0 });

  var todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  var monthKey = todayKey.slice(0, 7);

  var today = { revenue: 0, profit: 0, count: 0 };
  var month = { revenue: 0, profit: 0, count: 0 };
  var recentSales = [];

  for (var i = 0; i < sales.length; i++) {
    var sale = sales[i];
    var key = cafeDateKey_(sale.date);
    var revenue = Number(sale.total) || 0;
    var profit = Number(sale.profit) || 0;

    if (key.indexOf(monthKey) === 0) { month.revenue += revenue; month.profit += profit; month.count++; }
    if (key === todayKey) { today.revenue += revenue; today.profit += profit; today.count++; }
  }

  // Only the rows that are actually shown have their receipt parsed, and only
  // to count its lines.
  for (var s = Math.max(0, sales.length - MINI_APP_RECENT_SALES); s < sales.length; s++) {
    var recent = sales[s];
    var items = cafeReceiptItems_(recent.itemsRaw);
    recentSales.push({
      id: String(recent.id || ""),
      date: cafeDateKey_(recent.date),
      seller: String(recent.seller || ""),
      total: Number(recent.total) || 0,
      profit: Number(recent.profit) || 0,
      items: items.length
    });
  }
  recentSales.reverse();

  var closings = [];
  for (var c = Math.max(0, closeReports.length - MINI_APP_RECENT_CLOSINGS); c < closeReports.length; c++) {
    var close = closeReports[c];
    closings.push({
      date: cafeDateKey_(close.date),
      seller: String(close.seller || ""),
      revenue: Number(close.totalRevenue) || 0,
      profit: Number(close.totalProfit) || 0
    });
  }
  closings.reverse();

  var inventoryValue = 0;
  var lowStock = [];
  for (var v = 0; v < inventory.length; v++) {
    var item = inventory[v];
    var qty = Number(item.qty) || 0;
    var value = Number(item.totalCost);
    inventoryValue += isFinite(value) && value > 0 ? value : qty * (Number(item.unitCost) || 0);
    if (item.type === "product" && qty <= 3) {
      lowStock.push({ name: String(item.name || ""), qty: qty, unit: String(item.unit || "") });
    }
  }

  var target = Number((settings || {}).dailyTarget) || 0;
  return {
    today: { revenue: Math.round(today.revenue), profit: Math.round(today.profit), sales: today.count },
    month: { revenue: Math.round(month.revenue), profit: Math.round(month.profit), sales: month.count, label: monthKey },
    target: {
      daily: target,
      progress: target > 0 ? Math.min(100, Math.round((today.revenue / target) * 100)) : 0
    },
    inventory: {
      value: Math.round(inventoryValue),
      items: inventory.length,
      lowStock: lowStock.slice(0, 8)
    },
    recentSales: recentSales,
    recentClosings: closings
  };
}

/**
 * The calendar day a café record belongs to.
 *
 * Sales carry an ISO timestamp; older rows can carry whatever the sheet made
 * of them. Both are reduced to a yyyy-MM-dd key in the script timezone so
 * "today" means the same thing here as it does in the POS.
 */
function cafeDateKey_(value) {
  if (value && typeof value === "object" && typeof value.getFullYear === "function") {
    return isNaN(value.getTime()) ? "" : Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  var text = String(value || "");
  if (!text) return "";
  var parsed = new Date(text);
  if (isNaN(parsed.getTime())) return text.slice(0, 10);
  return Utilities.formatDate(parsed, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

// ------------------------------------------------------------------ writing

/**
 * One income or expense from the Mini App.
 *
 * Written through the same append path the /yangi bot uses, so the row shape,
 * the idempotency and the queued group report are identical. The Mini App is
 * a client of the accounting rules, never a second copy of them.
 */
function miniSaveTransaction_(doc, configSheet, payload) {
  var type = payload.type === "Expense" ? "Expense" : "Income";
  var amount = Number(payload.amount);
  var period = isCanonicalPeriod_(payload.period) ? String(payload.period) : currentPeriod_();
  var tenant = String(payload.tenant || "").trim();
  var requestId = String(payload.requestId || "").trim();
  var groupId = String(payload.groupId || "").trim();

  if (!tenant) return jsonOutput_({ status: "error", message: "Obyekt tanlanmagan." });
  if (!isFinite(amount) || amount <= 0) return jsonOutput_({ status: "error", message: "Summa musbat raqam bo'lishi kerak." });
  if (amount > 1e15) return jsonOutput_({ status: "error", message: "Summa juda katta." });
  if (payload.currency !== "UZS" && payload.currency !== "USD") return jsonOutput_({ status: "error", message: "Valyuta noto'g'ri." });
  if (payload.method !== "Naqd" && payload.method !== "Bank") return jsonOutput_({ status: "error", message: "To'lov usuli noto'g'ri." });
  if (!requestId || requestId.length > 128) return jsonOutput_({ status: "error", message: "requestId talab qilinadi." });
  if (String(payload.comment || "").length > 2000) return jsonOutput_({ status: "error", message: "Izoh juda uzun." });
  // An income has to land on a tenant; only an expense may come from a bucket.
  if (type === "Income" && isExpenseSourceName_(tenant)) {
    return jsonOutput_({ status: "error", message: "Kirim uchun ijarachi tanlang." });
  }
  // ...and it has to be a tenant that exists. An income credits a balance, so
  // an unrecognised name invents debt against nobody -- the same rule the
  // tenant-paid pair already enforces, applied to the ordinary entry too.
  if (type === "Income") {
    var known = findConfiguredTenant_(
      normalizeTenantList_(safeParseJSON_(getConfig(configSheet, "Omad_Tenants"), [])), tenant);
    if (!known) {
      return jsonOutput_({ status: "error", message: "Bunday ijarachi ro'yxatda yo'q: " + tenant });
    }
  }

  if (isLedgerActive_(doc)) {
    var created = createTransaction_(doc, {
      requestId: requestId, groupId: groupId || newEntryGroupId_(), period: period,
      tenant: tenant, type: type, amount: amount, currency: payload.currency,
      method: payload.method, comment: String(payload.comment || ""),
      createdBy: "miniapp", source: TX_SOURCE_TELEGRAM
    });
    if (created.status === "success" && !created.duplicate) {
      queueMiniTransactionReport_(doc, created.transaction);
    }
    if (created.status === "success") recordLastOperation_(doc, "mini_save_transaction");
    return jsonOutput_(created);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var transaction;
  var duplicate = false;
  try {
    var existing = findTransactionByRequestId_(doc, requestId);
    if (existing) {
      transaction = normalizeTransaction_(existing);
      duplicate = true;
    } else {
      backupOmadState_(doc, configSheet, "miniapp_entry");
      transaction = normalizeTransaction_({
        id: new Date().getTime() + "_0",
        tenant: tenant, month: period, type: type, amount: amount,
        currency: payload.currency, method: payload.method,
        date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy"),
        comment: String(payload.comment || ""), msgId: "", requestId: requestId,
        groupId: groupId || newEntryGroupId_()
      });
      appendOmadTransaction_(doc, transaction);
    }
  } finally {
    lock.releaseLock();
  }

  recordLastOperation_(doc, "mini_save_transaction");
  if (!duplicate) queueMiniTransactionReport_(doc, transaction);
  // The report is queued, not sent: see `mini_flush_reports`.

  return jsonOutput_({ status: "success", duplicate: duplicate, transaction: transaction });
}

/** Queueing a report must never undo a transaction that is already stored. */
function queueMiniTransactionReport_(doc, transaction) {
  try {
    enqueueJob_(doc, "omad_transaction_report", transaction.id, {
      groupId: String(transaction.groupId || ""),
      baseId: String(transaction.id).split("_")[0],
      messageId: ""
    });
  } catch (queueError) {
    debugLog_(doc, "report_enqueue_failed", String(queueError));
  }
}

/** The tenant-paid pair, through exactly the same code path the web app uses. */
function miniTenantPaid_(doc, configSheet, payload) {
  var input = {
    requestId: payload.requestId, groupId: payload.groupId,
    tenant: payload.tenant, period: payload.period, amount: payload.amount,
    currency: payload.currency, method: payload.method, comment: payload.comment,
    createdBy: "miniapp", source: TX_SOURCE_TELEGRAM
  };

  // The snapshot exists to undo a rewrite. On the ledger there is no rewrite to
  // undo -- a write is an append and a correction is another append, with the
  // audit row already recording it -- so copying the entire ledger into a cell
  // before each entry bought nothing and grew with the ledger.
  //
  // The legacy sheet is genuinely rewritten in place, so it keeps its snapshot.
  // What changes there is the order: this used to run before anything was
  // checked, so a typo'd amount wrote a full copy of the ledger and then
  // refused the entry.
  if (!isLedgerActive_(doc)) {
    var invalid = validateTenantPaidInput_(input, configuredTenants_(doc));
    if (invalid) return jsonOutput_({ status: "error", message: invalid });
    backupOmadState_(doc, configSheet, "miniapp_tenant_paid");
  }

  var result = createTenantPaidExpense_(doc, input);
  if (result.status !== "success") return jsonOutput_(result);

  recordLastOperation_(doc, "mini_tenant_paid");
  if (!result.duplicate) {
    try {
      enqueueJob_(doc, "omad_transaction_report", result.groupId, {
        groupId: result.groupId,
        baseId: String((result.transactions[0] || {}).id || "").split("_")[0],
        messageId: ""
      });
    } catch (queueError) {
      debugLog_(doc, "report_enqueue_failed", String(queueError));
    }
    // Not drained here: the phone is waiting on this response, and the client
    // asks for the flush once it has one. See `mini_flush_reports`.
  }
  return jsonOutput_(result);
}

/**
 * A task mutation from the Mini App.
 *
 * Delegates to the same handlers the /tasks board uses — the reminder
 * scheduling, the group cards and the occurrence bookkeeping are the existing
 * engine's, unchanged. Only the gate differs: verified initData here, the
 * admin key there.
 */
function miniTaskAction_(doc, payload, auth) {
  var taskAction = String(payload.taskAction || "");
  if (!isTaskMutationAction_(taskAction)) {
    return jsonOutput_({ status: "error", message: "Unknown action" });
  }

  var displayName = String(auth.user.firstName || "").trim() ||
    String(auth.user.username || "").trim() || String(auth.userId);

  // Who did this is decided here and nowhere else.
  //
  // These fields used to be read as `payload.completedById || auth.userId` --
  // the browser's value winning whenever it sent one. A request is just JSON,
  // so anyone who could reach this endpoint with a valid signature could file
  // a completion under somebody else's name and id, and the audit trail would
  // record it as fact. The signature proves who is calling; nothing else may
  // contribute to that answer.
  //
  // Stripped rather than overwritten, so a field added to the engine later
  // cannot quietly become spoofable by being forwarded before this runs.
  var forwarded = {};
  Object.keys(payload || {}).forEach(function (key) {
    if (MINI_IDENTITY_FIELDS[key]) return;
    forwarded[key] = payload[key];
  });

  forwarded.action = taskAction;
  // The task engine identifies a *task* by `id` and an *occurrence* by
  // `occurrenceId`. The Mini App speaks in `taskId` because that is what its
  // own view calls the field, so it is translated here rather than in four
  // separate places on the client. Without this, save/cancel/pause/resume
  // all reported "Vazifa topilmadi" and an edit silently created a second
  // task instead of changing the one on screen.
  forwarded.id = payload.id || payload.taskId || "";
  forwarded.completedById = auth.userId;
  forwarded.completedBy = displayName;
  forwarded.completedByName = displayName;
  forwarded.completedSource = "miniapp";
  // `save_task` keeps the original author when editing, so this only lands on
  // newly created tasks. `proofAwaitingUserId` is deliberately not set: the
  // engine derives it from the verified completer, and the only thing the
  // client could do with it is hand a photo-proof slot to another account.
  forwarded.createdBy = "tg:" + auth.userId;

  return runTaskAction_(taskAction, forwarded, doc);
}

// ----- apps-script/23_health.gs ------------------------------------------------

// ============================================================
// Mini App configuration and system health
// ------------------------------------------------------------
// Two operator tools that exist so nobody has to keep BotFather settings in
// their head, or guess which of twenty deployments is actually live.
//
// Everything here reports *status*, never values. A health check that printed
// a chat id or a URL fragment to prove it was configured would be a slower way
// of leaking the thing it is checking.
// ============================================================

var TELEGRAM_PROP_MINI_APP_URL = "TELEGRAM_MINI_APP_URL";
var TELEGRAM_PROP_MINI_APP_STATUS = "TELEGRAM_MINI_APP_STATUS";

/**
 * There is deliberately no default Mini App URL.
 *
 * There used to be one, pointing at the Netlify host. A default is worse than
 * nothing here: the frontend host changes, the constant does not, and the menu
 * button then silently installs a URL that 404s — which looks configured and
 * is not. The operator supplies the production `/mini` URL once, it is stored,
 * and every later run reuses the stored value.
 */
var DEFAULT_MINI_APP_URL = "";
var MINI_APP_MENU_BUTTON_TEXT = "📊 Omad";

var HEALTH_OK = "ok";
var HEALTH_WARN = "warning";
var HEALTH_ERROR = "error";

function check_(id, label, status, message) {
  return { id: id, label: label, status: status, message: message };
}

/** The web-app URL of the deployment currently serving this request. */
function currentWebAppUrl_() {
  try {
    return ScriptApp.getService().getUrl() || "";
  } catch (error) {
    return "";
  }
}

// ------------------------------------------------------- Mini App configuration

/**
 * Points the bot's menu button at the Mini App, and verifies that it stuck.
 *
 * This is the whole of the BotFather setup, done through the Bot API: the
 * menu button is a bot-level setting that `setChatMenuButton` owns, so there
 * is nothing left that has to be typed into a chat with BotFather by hand.
 *
 * Verification is a separate call rather than trusting the write, because
 * `setChatMenuButton` answers `ok: true` for a URL Telegram will later refuse
 * to open.
 */
function configureMiniApp_(payload) {
  if (!getBotToken_()) {
    return { status: "error", message: "Bot token o'rnatilmagan." };
  }

  var url = String((payload && payload.miniAppUrl) || "").trim() ||
            getTelegramSetting_(TELEGRAM_PROP_MINI_APP_URL) ||
            DEFAULT_MINI_APP_URL;
  if (!url) {
    return {
      status: "error",
      message: "Mini App manzili kiritilmagan. Frontend manzilini /mini bilan kiriting."
    };
  }
  if (!/^https:\/\/[^\s]+$/.test(url)) {
    return { status: "error", message: "Mini App manzili https:// bilan boshlanishi kerak." };
  }

  var steps = [];
  try {
    var me = safeParseJSON_(telegramFetch_("getMe", {}).getContentText(), {});
    var bot = (me && me.result) || {};
    steps.push(check_("bot", "Bot ulanishi", HEALTH_OK, "@" + (bot.username || "")));

    telegramFetch_("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: MINI_APP_MENU_BUTTON_TEXT,
        web_app: { url: url }
      }
    });

    var current = safeParseJSON_(telegramFetch_("getChatMenuButton", {}).getContentText(), {});
    var button = (current && current.result) || {};
    var installed = button.type === "web_app" && button.web_app && button.web_app.url === url;
    steps.push(check_("menu", "Menyu tugmasi", installed ? HEALTH_OK : HEALTH_ERROR,
      installed ? "Mini App ulandi" : "Telegram tugmani tasdiqlamadi"));

    var authorized = getAuthorizedTelegramUserId_();
    steps.push(check_("user", "Ruxsat etilgan foydalanuvchi",
      authorized ? HEALTH_OK : HEALTH_ERROR,
      authorized ? "O'rnatilgan" : "TELEGRAM_AUTHORIZED_USER_ID o'rnatilmagan"));

    var webhook = safeParseJSON_(telegramFetch_("getWebhookInfo", {}).getContentText(), {});
    var info = (webhook && webhook.result) || {};
    steps.push(webhookHealthCheck_(info));

    var ready = installed && !!authorized && !!info.url;
    setTelegramSetting_(TELEGRAM_PROP_MINI_APP_URL, url);
    setTelegramSetting_(TELEGRAM_PROP_MINI_APP_STATUS, JSON.stringify({
      configured: installed, ready: ready, checkedAt: new Date().toISOString()
    }));
    auditTelegramSettingsChange_(["miniAppUrl"]);

    return {
      status: "success",
      ready: ready,
      // The URL is not a secret - it is in the bot's menu for anyone to see.
      miniAppUrl: url,
      steps: steps,
      settings: buildTelegramSettingsView_()
    };
  } catch (error) {
    return {
      status: "error",
      message: redactSecrets_(error).slice(0, 300),
      steps: steps,
      settings: buildTelegramSettingsView_()
    };
  }
}

function webhookHealthCheck_(info) {
  if (!info || !info.url) {
    return check_("webhook", "Webhook", HEALTH_ERROR, "Ulanmagan");
  }
  var pending = Number(info.pending_update_count) || 0;
  if (info.last_error_message) {
    return check_("webhook", "Webhook", HEALTH_WARN,
      "Oxirgi xato: " + redactSecrets_(info.last_error_message).slice(0, 120));
  }
  if (pending > 50) {
    return check_("webhook", "Webhook", HEALTH_WARN, pending + " ta yangilanish navbatda");
  }
  return check_("webhook", "Webhook", HEALTH_OK, "Ishlayapti");
}

// ------------------------------------------------------------------- health

var HEALTH_REQUIRED_SHEETS = [
  "System_Config", "Omad_Transactions", "Omad_Backups",
  "Omad_Audit_Log", "Omad_Job_Queue"
];

var HEALTH_TRIGGER_FUNCTION = "processPendingTelegramJobs";

/**
 * One pass over everything that can quietly stop working.
 *
 * Green / warning / error with a sentence each. No secret, no chat id, no
 * amount, no URL fragment that would identify a deployment to someone who
 * should not have it.
 */
function buildHealthReport_(doc) {
  var checks = [];

  checks.push(check_("backend", "Backend", HEALTH_OK, "Javob bermoqda"));
  checks.push(anonymousReadCheck_());
  checks.push(deploymentCheck_());
  checks.push(botCheck_());
  checks.push(miniAppCheck_());
  checks.push(authorizedUserCheck_());
  checks.push(liveWebhookCheck_());
  checks.push(tasksGroupCheck_());
  checks.push(triggerCheck_());
  checks.push(queueCheck_(doc));
  checks.push(sheetsCheck_(doc));
  checks.push(ledgerCheck_(doc));
  checks.push(secretLoggingCheck_(doc));
  checks.push(dataCheck_(doc, "omad", "Omad ma'lumotlari", OMAD_TRANSACTIONS_SHEET));
  checks.push(dataCheck_(doc, "cafe", "Kafe ma'lumotlari", "Cafe_Sales"));
  checks.push(dataCheck_(doc, "tasks", "Vazifalar", TASKS_SHEET));

  var worst = HEALTH_OK;
  for (var i = 0; i < checks.length; i++) {
    if (checks[i].status === HEALTH_ERROR) worst = HEALTH_ERROR;
    else if (checks[i].status === HEALTH_WARN && worst !== HEALTH_ERROR) worst = HEALTH_WARN;
  }

  return { status: worst, checkedAt: new Date().toISOString(), checks: checks };
}

/**
 * Whether the private reads are actually private.
 *
 * There used to be a `LEGACY_CLIENT_GRACE` flag here and this check reported
 * whether it was set, which proved nothing about the running system — a flag
 * says what the source intended, not what the deployed router does.
 *
 * So it asks instead. Both retired anonymous routes are called exactly as an
 * outsider with the /exec URL would call them, and the answer has to be the
 * inert banner rather than the ledger. If a future edit re-opens one, this
 * turns red on the next look rather than on the next breach.
 */
function anonymousReadCheck_() {
  var probes = ["get_omad", "get_cafe"];
  var open = [];

  for (var i = 0; i < probes.length; i++) {
    var body = "";
    try {
      body = String(doGet({ parameter: { action: probes[i] } }).getContent() || "");
    } catch (error) {
      // A route that throws is not a route that answers with the ledger.
      body = "";
    }
    if (body.indexOf("\"transactions\"") !== -1 ||
        body.indexOf("\"inventory\"") !== -1 ||
        body.indexOf("\"tenants\"") !== -1) {
      open.push(probes[i]);
    }
  }

  if (open.length === 0) {
    return check_("grace", "Kalit himoyasi", HEALTH_OK, "To'liq yoqilgan");
  }
  return check_("grace", "Kalit himoyasi", HEALTH_ERROR,
    "Kalitsiz ochiq: " + open.join(", "));
}

/**
 * Whether Telegram is talking to the deployment that is answering.
 *
 * This is the failure this project has actually had, repeatedly: a "New
 * deployment" mints a URL nothing calls, so the code looks deployed while the
 * app keeps running the old version. Comparing the two URLs catches it.
 */
function deploymentCheck_() {
  var live = currentWebAppUrl_();
  var configured = stripWebhookSecret_(getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_URL) || "");
  if (!live) return check_("deployment", "Deployment", HEALTH_WARN, "Manzilni aniqlab bo'lmadi");
  if (!configured) return check_("deployment", "Deployment", HEALTH_WARN, "Webhook manzili saqlanmagan");
  if (live === configured) return check_("deployment", "Deployment", HEALTH_OK, "Webhook shu versiyaga ulangan");
  return check_("deployment", "Deployment", HEALTH_ERROR,
    "Telegram boshqa deploymentga ulangan — Webhook tugmasini bosing");
}

function botCheck_() {
  if (!getBotToken_()) return check_("bot", "Telegram bot", HEALTH_ERROR, "Token o'rnatilmagan");
  try {
    var body = safeParseJSON_(telegramFetch_("getMe", {}).getContentText(), {});
    var bot = (body && body.result) || {};
    if (!bot.username) return check_("bot", "Telegram bot", HEALTH_ERROR, "Javob tushunarsiz");
    return check_("bot", "Telegram bot", HEALTH_OK, "@" + bot.username);
  } catch (error) {
    return check_("bot", "Telegram bot", HEALTH_ERROR, redactSecrets_(error).slice(0, 120));
  }
}

function miniAppCheck_() {
  if (!getBotToken_()) return check_("miniapp", "Mini App", HEALTH_ERROR, "Bot token yo'q");
  try {
    var body = safeParseJSON_(telegramFetch_("getChatMenuButton", {}).getContentText(), {});
    var button = (body && body.result) || {};
    if (button.type !== "web_app") {
      return check_("miniapp", "Mini App", HEALTH_WARN, "Sozlanmagan — 'Mini Appni sozlash' tugmasini bosing");
    }
    var expected = getTelegramSetting_(TELEGRAM_PROP_MINI_APP_URL);
    if (expected && button.web_app && button.web_app.url !== expected) {
      return check_("miniapp", "Mini App", HEALTH_WARN, "Boshqa manzilga ulangan — qayta sozlang");
    }
    return check_("miniapp", "Mini App", HEALTH_OK, "Menyu tugmasi ulangan");
  } catch (error) {
    return check_("miniapp", "Mini App", HEALTH_ERROR, redactSecrets_(error).slice(0, 120));
  }
}

function authorizedUserCheck_() {
  var value = String(getAuthorizedTelegramUserId_() || "").trim();
  if (!value) return check_("user", "Ruxsat etilgan foydalanuvchi", HEALTH_ERROR, "O'rnatilmagan");
  if (!/^\d{1,20}$/.test(value)) {
    return check_("user", "Ruxsat etilgan foydalanuvchi", HEALTH_ERROR, "Raqamli ID bo'lishi kerak");
  }
  return check_("user", "Ruxsat etilgan foydalanuvchi", HEALTH_OK, "O'rnatilgan");
}

function liveWebhookCheck_() {
  if (!getTelegramSetting_(TELEGRAM_PROP_WEBHOOK_SECRET)) {
    return check_("webhook", "Webhook", HEALTH_WARN, "Tekshiruv kaliti yo'q — Webhook tugmasini bosing");
  }
  if (!getBotToken_()) return check_("webhook", "Webhook", HEALTH_ERROR, "Bot token yo'q");
  try {
    var body = safeParseJSON_(telegramFetch_("getWebhookInfo", {}).getContentText(), {});
    return webhookHealthCheck_((body && body.result) || {});
  } catch (error) {
    return check_("webhook", "Webhook", HEALTH_ERROR, redactSecrets_(error).slice(0, 120));
  }
}

function tasksGroupCheck_() {
  var raw = String(getTelegramSetting_(TELEGRAM_PROP_TASKS_GROUP_CHAT_ID) || "").trim();
  if (!raw) return check_("tasksGroup", "Vazifalar guruhi", HEALTH_WARN, "Sozlanmagan — kartalar yuborilmaydi");
  if (!getTasksGroupChatId_()) {
    return check_("tasksGroup", "Vazifalar guruhi", HEALTH_ERROR, "Raqamli ID emas — @username qabul qilinmaydi");
  }
  return check_("tasksGroup", "Vazifalar guruhi", HEALTH_OK, "Sozlangan");
}

/**
 * The single time-driven trigger that carries both the task scheduler and the
 * report queue. Without it reminders never fire and reports never leave.
 */
function triggerCheck_() {
  var triggers;
  try {
    triggers = ScriptApp.getProjectTriggers() || [];
  } catch (error) {
    return check_("trigger", "Trigger", HEALTH_WARN, "Ro'yxatni o'qib bo'lmadi");
  }
  for (var i = 0; i < triggers.length; i++) {
    var handler = "";
    try { handler = triggers[i].getHandlerFunction(); } catch (error) { handler = ""; }
    if (handler === HEALTH_TRIGGER_FUNCTION) {
      return check_("trigger", "Trigger", HEALTH_OK, HEALTH_TRIGGER_FUNCTION + " o'rnatilgan");
    }
  }
  return check_("trigger", "Trigger", HEALTH_ERROR,
    HEALTH_TRIGGER_FUNCTION + " triggeri yo'q — eslatma va hisobotlar yuborilmaydi");
}

function queueCheck_(doc) {
  var queue = buildJobQueueStatus_(doc);
  var counts = queue.counts || {};
  if (counts.failed > 0) {
    return check_("queue", "Hisobot navbati", HEALTH_ERROR, counts.failed + " ta vazifa muvaffaqiyatsiz");
  }
  if (counts.pending > 20) {
    return check_("queue", "Hisobot navbati", HEALTH_WARN, counts.pending + " ta vazifa kutmoqda");
  }
  return check_("queue", "Hisobot navbati", HEALTH_OK,
    (counts.pending || 0) + " kutmoqda, " + (counts.completed || 0) + " bajarilgan");
}

function sheetsCheck_(doc) {
  var missing = [];
  for (var i = 0; i < HEALTH_REQUIRED_SHEETS.length; i++) {
    if (!doc.getSheetByName(HEALTH_REQUIRED_SHEETS[i])) missing.push(HEALTH_REQUIRED_SHEETS[i]);
  }
  if (missing.length === 0) return check_("sheets", "Varaqlar", HEALTH_OK, "Hammasi mavjud");
  // Every one of these is created on first use, so a missing sheet is normal
  // on a fresh spreadsheet and only worth flagging, not failing.
  return check_("sheets", "Varaqlar", HEALTH_WARN, "Yo'q: " + missing.join(", "));
}

function ledgerCheck_(doc) {
  var active = activeTransactionSheetName_(doc);
  if (active === OMAD_TRANSACTIONS_V2_SHEET) {
    return check_("ledger", "Tranzaksiya varag'i", HEALTH_OK, "V2 (yangi tizim) yoqilgan");
  }
  return check_("ledger", "Tranzaksiya varag'i", HEALTH_OK, active + " — V2 o'chirilgan");
}

/**
 * Whether anything in the recent debug log still looks like a credential.
 *
 * Request bodies stopped being logged, so this should stay clean; if it does
 * not, something new started writing one and the cleanup action is one press
 * away.
 */
function secretLoggingCheck_(doc) {
  var sheet = doc.getSheetByName(DEBUG_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) {
    return check_("secrets", "Log himoyasi", HEALTH_OK, "Log bo'sh");
  }
  var size = Math.min(200, sheet.getLastRow() - 1);
  var values = sheet.getRange(sheet.getLastRow() - size + 1, 3, size, 1).getValues();
  var suspicious = 0;
  for (var i = 0; i < values.length; i++) {
    var text = String(values[i][0] || "");
    if (/\b[0-9a-fA-F]{32,}\b/.test(text) || TELEGRAM_TOKEN_LIKE_PATTERN.test(text)) suspicious++;
    TELEGRAM_TOKEN_LIKE_PATTERN.lastIndex = 0;
  }
  if (suspicious > 0) {
    return check_("secrets", "Log himoyasi", HEALTH_WARN,
      suspicious + " ta qatorda maxfiyga o'xshash qiymat — 'Loglarni Tozalash'ni bosing");
  }
  return check_("secrets", "Log himoyasi", HEALTH_OK, "Oxirgi " + size + " qator toza");
}

function dataCheck_(doc, id, label, sheetName) {
  var sheet = doc.getSheetByName(sheetName);
  if (!sheet) return check_(id, label, HEALTH_WARN, "Varaq hali yaratilmagan");
  var rows = Math.max(0, sheet.getLastRow() - 1);
  return check_(id, label, HEALTH_OK, rows + " ta yozuv");
}

