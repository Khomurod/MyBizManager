// A Date whose local time is a fixed zone, the way Apps Script's is.
//
// Apps Script runs the backend with the script's time zone (Asia/Tashkent) as
// the local zone: `new Date().getHours()` is the hour in Tashkent, and
// `new Date(2026, 10, 16)` is midnight in Tashkent. The Edge runtime's local
// zone is UTC and cannot be changed per function, so the backend gets this
// class as its `Date` instead. Tashkent has had no daylight saving since 1992,
// so its offset is a constant +05:00 and the arithmetic is exact.
//
// Everything not about local time (getTime, toISOString, the UTC getters and
// setters, JSON) is the native Date's own. `instanceof Date` is true for any
// native Date too, so a date built elsewhere still passes the backend's checks.
//
// `clock` supplies "now". The Edge executor passes a recorded clock, so a
// request that is run again sees the same instants it saw the first time.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MBMZonedDate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad(value, width) {
    var s = String(Math.abs(value));
    while (s.length < (width || 2)) s = '0' + s;
    return s;
  }

  /**
   * @param {DateConstructor} NativeDate  the platform's Date
   * @param {number} offsetMinutes  minutes east of UTC (Tashkent: 300)
   * @param {string} zoneId  IANA id, for toLocale* (e.g. "Asia/Tashkent")
   * @param {string} zoneName  the long name toString() prints
   * @param {function(): number} [clock]  epoch milliseconds for "now"
   */
  function createZonedDate(NativeDate, offsetMinutes, zoneId, zoneName, clock) {
    var OFF = offsetMinutes * 60000;
    var nowMs = typeof clock === 'function' ? clock : function () { return NativeDate.now(); };
    var nativeUTC = NativeDate.UTC;
    var nativeParse = NativeDate.parse;
    var proto = NativeDate.prototype;
    var offsetLabel = (offsetMinutes >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(offsetMinutes) / 60)) +
      pad(Math.abs(offsetMinutes) % 60);

    /** Epoch ms of a wall-clock time in the zone. */
    function fromWall(y, mo, d, h, mi, s, ms) {
      return nativeUTC(y, mo, d, h, mi, s, ms) - OFF;
    }

    /** A native Date whose UTC fields are the zone's wall clock. */
    function wall(ms) {
      return new NativeDate(ms + OFF);
    }

    /**
     * Date.parse with the zone as "local". An ISO date-only string is UTC (as
     * the language says), a string that names its own offset keeps it, and
     * anything else that the platform read as local time is re-read as the
     * zone's wall clock.
     */
    function parseZoned(value) {
      var text = String(value).trim();
      if (/^[+-]?\d{4,6}(-\d{2}(-\d{2})?)?$/.test(text)) return nativeParse(text);
      if (/(Z|[+-]\d{2}:?\d{2}|\bGMT\b|\bUTC\b|\bUT\b)\s*(\([^)]*\))?$/i.test(text)) return nativeParse(text);
      var local = new NativeDate(text);
      if (isNaN(local.getTime())) return NaN;
      return fromWall(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(),
        local.getMinutes(), local.getSeconds(), local.getMilliseconds());
    }

    function toPrimitiveTime(v) {
      if (v instanceof NativeDate) return v.getTime();
      if (typeof v === 'string') return parseZoned(v);
      if (v !== null && typeof v === 'object') {
        var p = typeof v.valueOf === 'function' ? v.valueOf() : v;
        if (p === v && typeof v.toString === 'function') p = v.toString();
        return typeof p === 'string' ? parseZoned(p) : Number(p);
      }
      return Number(v);
    }

    class ZonedDate extends NativeDate {
      constructor(...args) {
        if (args.length === 0) super(nowMs());
        else if (args.length === 1) super(toPrimitiveTime(args[0]));
        else {
          super(fromWall(args[0], args[1], args.length > 2 ? args[2] : 1, args.length > 3 ? args[3] : 0,
            args.length > 4 ? args[4] : 0, args.length > 5 ? args[5] : 0, args.length > 6 ? args[6] : 0));
        }
      }

      getFullYear() { return wall(this.getTime()).getUTCFullYear(); }
      getYear() { return wall(this.getTime()).getUTCFullYear() - 1900; }
      getMonth() { return wall(this.getTime()).getUTCMonth(); }
      getDate() { return wall(this.getTime()).getUTCDate(); }
      getDay() { return wall(this.getTime()).getUTCDay(); }
      getHours() { return wall(this.getTime()).getUTCHours(); }
      getMinutes() { return wall(this.getTime()).getUTCMinutes(); }
      getSeconds() { return wall(this.getTime()).getUTCSeconds(); }
      getMilliseconds() { return wall(this.getTime()).getUTCMilliseconds(); }
      getTimezoneOffset() { return isNaN(this.getTime()) ? NaN : -offsetMinutes; }

      setFullYear() { return this.__setWall(proto.setUTCFullYear, arguments); }
      setMonth() { return this.__setWall(proto.setUTCMonth, arguments); }
      setDate() { return this.__setWall(proto.setUTCDate, arguments); }
      setHours() { return this.__setWall(proto.setUTCHours, arguments); }
      setMinutes() { return this.__setWall(proto.setUTCMinutes, arguments); }
      setSeconds() { return this.__setWall(proto.setUTCSeconds, arguments); }
      setMilliseconds() { return this.__setWall(proto.setUTCMilliseconds, arguments); }

      __setWall(setter, args) {
        var w = wall(this.getTime());
        setter.apply(w, args);
        return this.setTime(w.getTime() - OFF);
      }

      toDateString() {
        if (isNaN(this.getTime())) return 'Invalid Date';
        var w = wall(this.getTime());
        return DAY_NAMES[w.getUTCDay()] + ' ' + MONTH_NAMES[w.getUTCMonth()] + ' ' + pad(w.getUTCDate()) + ' ' +
          (w.getUTCFullYear() < 0 ? '-' + pad(-w.getUTCFullYear(), 6) : pad(w.getUTCFullYear(), 4));
      }

      toTimeString() {
        if (isNaN(this.getTime())) return 'Invalid Date';
        var w = wall(this.getTime());
        return pad(w.getUTCHours()) + ':' + pad(w.getUTCMinutes()) + ':' + pad(w.getUTCSeconds()) +
          ' GMT' + offsetLabel + ' (' + zoneName + ')';
      }

      toString() {
        if (isNaN(this.getTime())) return 'Invalid Date';
        return this.toDateString() + ' ' + this.toTimeString();
      }

      toLocaleString(locales, options) {
        return proto.toLocaleString.call(this, locales, Object.assign({ timeZone: zoneId }, options || {}));
      }

      toLocaleDateString(locales, options) {
        return proto.toLocaleDateString.call(this, locales, Object.assign({ timeZone: zoneId }, options || {}));
      }

      toLocaleTimeString(locales, options) {
        return proto.toLocaleTimeString.call(this, locales, Object.assign({ timeZone: zoneId }, options || {}));
      }
    }

    // The helper is an implementation detail, not something the backend sees
    // when it enumerates a date (it never does, but JSON tools might).
    Object.defineProperty(ZonedDate.prototype, '__setWall', { enumerable: false });

    ZonedDate.now = function () { return nowMs(); };
    ZonedDate.parse = function (value) { return parseZoned(value); };
    ZonedDate.UTC = nativeUTC;
    Object.defineProperty(ZonedDate, Symbol.hasInstance, {
      value: function (value) { return value instanceof NativeDate; }
    });
    Object.defineProperty(ZonedDate, 'name', { value: 'Date' });
    return ZonedDate;
  }

  /** The backend's zone. Fixed: Uzbekistan has not observed daylight saving since 1992. */
  function createTashkentDate(NativeDate, clock) {
    return createZonedDate(NativeDate || Date, 300, 'Asia/Tashkent', 'Uzbekistan Standard Time', clock);
  }

  return { createZonedDate: createZonedDate, createTashkentDate: createTashkentDate };
});
