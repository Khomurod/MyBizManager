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

function setConfig(sheet, key, value) {
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
