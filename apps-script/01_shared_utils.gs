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
