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
/**
 * Whether a caller actually said which day of the month it means.
 *
 * `normalizeTaskRecurrence_` resolves anything unusable to the 1st, and it does
 * that on the read path as well as the write path, so the default cannot be
 * tightened without rewriting what every stored row means. This is the
 * save-time question instead: did the client choose, or is this monthly task
 * about to become a day-1 task because nobody asked?
 */
function isTaskMonthDayChoice_(value) {
  if (value === "last") return true;
  var day = Number(value);
  return isFinite(day) && day >= 1 && day <= 31 && Math.floor(day) === day;
}

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
