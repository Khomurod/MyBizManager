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
