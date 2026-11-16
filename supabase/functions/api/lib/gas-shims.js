// The Apps Script services the backend uses, for the Edge runtime.
//
// The backend calls about ten Google services. In the Edge function each one
// is replaced here, and every call that would leave the process goes through
// the replay executor (executor.js) instead of happening directly:
//
//   UrlFetchApp       the database (PostgREST) and Telegram, via ctx.io
//   CacheService      the bot's /yangi conversation and the rate limits, in
//                     the app_cache table; display summaries are not cached
//   PropertiesService the store's own address only; every other setting lives
//                     in app_properties, read by the backend itself
//   LockService       a local lock that is always free; the lock that matters
//                     is the database lease the backend takes (app_lease)
//   Utilities         Tashkent formatDate, recorded UUIDs, synchronous HMAC
//   Date, Math.random recorded, with Tashkent as the local zone
//   ContentService, HtmlService, ScriptApp  plain stand-ins
//   SpreadsheetApp    refused: the Edge runtime only ever runs on Supabase
//
// The test harness uses the same Date and Utilities in every mode, so the
// backend is tested against the clock it actually has in production.
(function (root, factory) {
  var api = factory(
    (typeof module === 'object' && module && module.exports && typeof require === 'function') ? {
      sha: require('./sha256.js'),
      zoned: require('./zoned-date.js')
    } : { sha: root.MBMSha256, zoned: root.MBMZonedDate }
  );
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.MBMGasShims = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var sha = deps.sha;
  var zoned = deps.zoned;
  var NativeDate = Date;

  var SCRIPT_TIME_ZONE = 'Asia/Tashkent';
  var ZONE_OFFSETS = { 'Asia/Tashkent': 300, UTC: 0, GMT: 0, 'Etc/UTC': 0, 'Etc/GMT': 0, Z: 0 };
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];
  var DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function pad(value, width) {
    var s = String(Math.abs(value));
    while (s.length < width) s = '0' + s;
    return (value < 0 ? '-' : '') + s;
  }

  /** Minutes east of UTC for `zone` at `ms`. Fixed zones are exact; others ask Intl. */
  function zoneOffsetMinutes(zone, ms) {
    var name = String(zone || SCRIPT_TIME_ZONE);
    if (Object.prototype.hasOwnProperty.call(ZONE_OFFSETS, name)) return ZONE_OFFSETS[name];
    var m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(name);
    if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: name, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).formatToParts(new NativeDate(ms));
      var get = function (type) {
        for (var i = 0; i < parts.length; i++) if (parts[i].type === type) return Number(parts[i].value);
        return 0;
      };
      var asUtc = NativeDate.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
      return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
    } catch (error) {
      throw new Error('Invalid argument: timeZone ' + name);
    }
  }

  /**
   * Utilities.formatDate: Java SimpleDateFormat patterns, in `zone`.
   * Letters are fields, 'quoted' text is literal, '' is a quote.
   */
  function formatDate(date, zone, pattern) {
    var ms = date instanceof NativeDate ? date.getTime() : new NativeDate(date).getTime();
    if (isNaN(ms)) throw new Error('Invalid argument: date');
    var offset = zoneOffsetMinutes(zone, ms);
    var w = new NativeDate(ms + offset * 60000);
    var year = w.getUTCFullYear();
    var month = w.getUTCMonth();
    var day = w.getUTCDate();
    var hours = w.getUTCHours();
    var field = function (letter, count) {
      switch (letter) {
        case 'y': return count === 2 ? pad(year % 100, 2) : pad(year, Math.max(count, 1));
        case 'M':
          if (count >= 4) return MONTHS_LONG[month];
          if (count === 3) return MONTHS_LONG[month].slice(0, 3);
          return pad(month + 1, count);
        case 'd': return pad(day, count);
        case 'E': return count >= 4 ? DAYS_LONG[w.getUTCDay()] : DAYS_LONG[w.getUTCDay()].slice(0, 3);
        case 'u': return String(w.getUTCDay() === 0 ? 7 : w.getUTCDay());
        case 'H': return pad(hours, count);
        case 'k': return pad(hours === 0 ? 24 : hours, count);
        case 'h': return pad(hours % 12 === 0 ? 12 : hours % 12, count);
        case 'K': return pad(hours % 12, count);
        case 'm': return pad(w.getUTCMinutes(), count);
        case 's': return pad(w.getUTCSeconds(), count);
        case 'S': return pad(w.getUTCMilliseconds(), Math.max(count, 3)).slice(0, Math.max(count, 3));
        case 'a': return hours < 12 ? 'AM' : 'PM';
        case 'Z': return (offset >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(offset) / 60), 2) + pad(Math.abs(offset) % 60, 2);
        case 'X':
          if (offset === 0) return 'Z';
          return (offset >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(offset) / 60), 2) +
            (count === 1 ? '' : (count === 2 ? '' : ':') + pad(Math.abs(offset) % 60, 2));
        case 'z': return offset === 0 ? 'UTC' : 'GMT' + (offset >= 0 ? '+' : '-') +
          pad(Math.floor(Math.abs(offset) / 60), 2) + ':' + pad(Math.abs(offset) % 60, 2);
        default: throw new Error('Illegal pattern character \'' + letter + '\'');
      }
    };
    var text = String(pattern);
    var out = '';
    for (var i = 0; i < text.length;) {
      var ch = text.charAt(i);
      if (ch === "'") {
        if (text.charAt(i + 1) === "'") { out += "'"; i += 2; continue; }
        var end = text.indexOf("'", i + 1);
        if (end === -1) throw new Error('Unterminated quote in pattern');
        out += text.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (/[A-Za-z]/.test(ch)) {
        var count = 1;
        while (text.charAt(i + count) === ch) count++;
        out += field(ch, count);
        i += count;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  function signedBytes(text) {
    return sha.toSigned(sha.utf8(text));
  }

  /**
   * Utilities for one run. `nd(kind, produce)` records a value so a re-run
   * gets the same one; outside the executor it just produces.
   */
  function createUtilities(nd, randomUuid) {
    return {
      formatDate: formatDate,
      getUuid: function () { return nd('uuid', randomUuid); },
      computeHmacSha256Signature: function (value, key) {
        return sha.toSigned(sha.hmacSha256(value, key));
      },
      computeDigest: function (algorithm, value) {
        if (String(algorithm) !== 'SHA_256' && algorithm !== createUtilities.DigestAlgorithm.SHA_256) {
          throw new Error('Only SHA_256 is available in the Edge runtime');
        }
        return sha.toSigned(sha.sha256(sha.toBytes(value)));
      },
      DigestAlgorithm: createUtilities.DigestAlgorithm,
      newBlob: function (value) {
        var text = String(value);
        return {
          getBytes: function () { return signedBytes(text); },
          getDataAsString: function () { return text; }
        };
      },
      base64Encode: function (value) {
        var bytes = typeof value === 'string' ? sha.utf8(value) : sha.toBytes(value);
        var binary = '';
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      },
      sleep: function () {}
    };
  }
  createUtilities.DigestAlgorithm = { SHA_256: 'SHA_256' };

  function defaultUuid() {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return require('crypto').randomUUID();
  }

  // ------------------------------------------------------------ the network

  /** A recorded answer, shaped like UrlFetchApp's HTTPResponse. */
  function httpResponse(answer) {
    var headers = answer.headers || {};
    return {
      getResponseCode: function () { return answer.code; },
      getContentText: function () { return answer.text; },
      getHeaders: function () { return headers; },
      getAllHeaders: function () { return headers; }
    };
  }

  /** The request UrlFetchApp would send, as plain data the executor can perform. */
  function describeRequest(url, params) {
    var p = params || {};
    var method = String(p.method || 'get').toLowerCase();
    var headers = {};
    var source = p.headers || {};
    for (var name in source) {
      if (Object.prototype.hasOwnProperty.call(source, name)) headers[name] = String(source[name]);
    }
    var body = null;
    if (p.payload !== undefined && p.payload !== null) {
      if (typeof p.payload === 'string') {
        body = p.payload;
        if (p.contentType) headers['Content-Type'] = p.contentType;
      } else {
        var form = [];
        for (var key in p.payload) {
          if (Object.prototype.hasOwnProperty.call(p.payload, key)) {
            form.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(p.payload[key])));
          }
        }
        body = form.join('&');
        headers['Content-Type'] = p.contentType || 'application/x-www-form-urlencoded';
      }
    }
    return {
      url: String(url),
      method: method,
      headers: headers,
      body: body,
      muteHttpExceptions: p.muteHttpExceptions === true
    };
  }

  function requestKey(request) {
    return request.method.toUpperCase() + ' ' + request.url + '\n' + (request.body === null ? '' : request.body);
  }

  /** What UrlFetchApp throws for a non-2xx without muteHttpExceptions, or a transport failure. */
  function unwrapAnswer(request, answer) {
    if (answer && answer.transportError) throw new Error(answer.transportError);
    if (!request.muteHttpExceptions && (answer.code < 200 || answer.code >= 400)) {
      throw new Error('Request failed for ' + request.url.replace(/\/bot[^/]+\//, '/bot[REDACTED]/').split('?')[0] +
        ' returned code ' + answer.code + '. Truncated server response: ' + String(answer.text || '').slice(0, 200));
    }
    return httpResponse(answer);
  }

  function createUrlFetchApp(io) {
    return {
      fetch: function (url, params) {
        var request = describeRequest(url, params);
        return unwrapAnswer(request, io(requestKey(request), { kind: 'fetch', request: request }));
      },
      fetchAll: function (list) {
        var requests = (list || []).map(function (item) { return describeRequest(item.url, item); });
        var key = 'ALL\n' + requests.map(requestKey).join('\n--\n');
        var answers = io(key, { kind: 'fetchAll', requests: requests });
        return requests.map(function (request, i) { return unwrapAnswer(request, answers[i]); });
      }
    };
  }

  // --------------------------------------------------------- the cache

  /** Keys the Edge runtime keeps in the database. Display summaries are recomputed instead. */
  function isDatabaseCacheKey(key) {
    return String(key).indexOf('sum_') !== 0;
  }

  /**
   * CacheService over app_cache. Reads stop the run; writes are deferred, and
   * an overlay makes this run see its own writes.
   */
  function createDatabaseCache(io, defer, env, now) {
    var overlay = {};
    var base = env.supabaseUrl + '/rest/v1/app_cache';
    var headers = { apikey: env.supabaseKey, Accept: 'application/json' };
    if (/^eyJ/.test(env.supabaseKey)) headers.Authorization = 'Bearer ' + env.supabaseKey;
    var cache = {
      get: function (key) {
        var name = String(key);
        if (!isDatabaseCacheKey(name)) return null;
        if (Object.prototype.hasOwnProperty.call(overlay, name)) return overlay[name];
        var request = {
          url: base + '?select=value,expires_at&key=eq.' + encodeURIComponent(name),
          method: 'get', headers: headers, body: null, muteHttpExceptions: true
        };
        var answer = io(requestKey(request), { kind: 'fetch', request: request });
        if (!answer || answer.transportError || answer.code !== 200) return null;
        var rows;
        try { rows = JSON.parse(answer.text || '[]'); } catch (error) { return null; }
        if (!rows || !rows.length) return null;
        if (new NativeDate(rows[0].expires_at).getTime() <= now()) return null;
        return rows[0].value;
      },
      put: function (key, value, seconds) {
        var name = String(key);
        if (!isDatabaseCacheKey(name)) return;
        var ttl = Math.min(Math.max(Number(seconds) || 600, 1), 21600);
        overlay[name] = String(value);
        var request = {
          url: base + '?on_conflict=key',
          method: 'post',
          headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, headers),
          body: JSON.stringify([{ key: name, value: String(value), expires_at: new NativeDate(now() + ttl * 1000).toISOString() }]),
          muteHttpExceptions: true
        };
        defer(requestKey(request), { kind: 'fetch', request: request });
      },
      remove: function (key) {
        var name = String(key);
        if (!isDatabaseCacheKey(name)) return;
        overlay[name] = null;
        var request = {
          url: base + '?key=eq.' + encodeURIComponent(name),
          method: 'delete', headers: Object.assign({ Prefer: 'return=minimal' }, headers), body: null,
          muteHttpExceptions: true
        };
        defer(requestKey(request), { kind: 'fetch', request: request });
      }
    };
    cache.getAll = function (keys) {
      var out = {};
      (keys || []).forEach(function (key) { var v = cache.get(key); if (v !== null) out[key] = v; });
      return out;
    };
    cache.putAll = function (values, seconds) {
      Object.keys(values || {}).forEach(function (key) { cache.put(key, values[key], seconds); });
    };
    cache.removeAll = function (keys) { (keys || []).forEach(function (key) { cache.remove(key); }); };
    return cache;
  }

  // ------------------------------------------------------------ the rest

  function createContentService() {
    return {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain', JAVASCRIPT: 'application/javascript', CSV: 'text/csv' },
      createTextOutput: function (text) {
        var output = {
          __text: text === undefined ? '' : String(text),
          __mime: 'text/plain',
          setMimeType: function (mime) { output.__mime = mime; return output; },
          getMimeType: function () { return output.__mime; },
          getContent: function () { return output.__text; },
          setContent: function (value) { output.__text = String(value); return output; }
        };
        return output;
      }
    };
  }

  function createHtmlService() {
    return {
      createHtmlOutput: function (html) {
        var output = {
          __html: html === undefined ? '' : String(html),
          getContent: function () { return output.__html; },
          setTitle: function () { return output; },
          setXFrameOptionsMode: function () { return output; },
          addMetaTag: function () { return output; }
        };
        return output;
      },
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' }
    };
  }

  /** The store's address: fixed for the Edge runtime, never written. */
  function createLocalProperties(fixed) {
    var values = Object.assign({}, fixed);
    var refuse = function (key) {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        throw new Error('Edge runtime: ' + key + ' is fixed by the deployment and cannot be changed here.');
      }
    };
    var store = {
      getProperty: function (key) {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      },
      // Everything else is the backend's shared settings, which it keeps in
      // app_properties itself; the Apps Script copy it also writes has no
      // counterpart here.
      setProperty: function (key) { refuse(key); return store; },
      deleteProperty: function (key) { refuse(key); return store; },
      getProperties: function () { return Object.assign({}, values); },
      getKeys: function () { return Object.keys(values); }
    };
    return { getScriptProperties: function () { return store; } };
  }

  function createFreeLock() {
    return {
      getScriptLock: function () {
        var held = false;
        return {
          waitLock: function () { held = true; },
          tryLock: function () { held = true; return true; },
          hasLock: function () { return held; },
          releaseLock: function () { held = false; }
        };
      }
    };
  }

  /**
   * Every Apps Script global the backend uses, for one run.
   *
   * ctx: from executor.js (io / nd / defer).
   * env: { supabaseUrl, supabaseKey, publicUrl, console, randomUuid }
   */
  function createEdgeGlobals(ctx, env) {
    var clock = function () { return ctx.nd('clock', function () { return NativeDate.now(); }); };
    var EdgeDate = zoned.createTashkentDate(NativeDate, clock);
    var EdgeMath = Object.create(Math);
    EdgeMath.random = function () { return ctx.nd('random', function () { return Math.random(); }); };
    var logger = env.console || console;
    var urlFetch = createUrlFetchApp(ctx.io);
    var cache = createDatabaseCache(ctx.io, ctx.defer, env, clock);

    return {
      Date: EdgeDate,
      Math: EdgeMath,
      console: logger,
      Logger: { log: function () { logger.log.apply(logger, arguments); } },
      Utilities: createUtilities(ctx.nd, env.randomUuid || defaultUuid),
      Session: { getScriptTimeZone: function () { return SCRIPT_TIME_ZONE; } },
      UrlFetchApp: urlFetch,
      CacheService: { getScriptCache: function () { return cache; } },
      PropertiesService: createLocalProperties({
        OMAD_STORAGE: 'supabase',
        OMAD_PROPERTIES_STORE: 'supabase',
        SUPABASE_URL: env.supabaseUrl,
        SUPABASE_SECRET_KEY: env.supabaseKey
      }),
      LockService: createFreeLock(),
      ContentService: createContentService(),
      HtmlService: createHtmlService(),
      ScriptApp: {
        getService: function () { return { getUrl: function () { return env.publicUrl || ''; } }; },
        getProjectTriggers: function () { return []; }
      },
      SpreadsheetApp: {
        getActiveSpreadsheet: function () {
          throw new Error('Edge runtime: the spreadsheet store is not available here.');
        }
      }
    };
  }

  return {
    SCRIPT_TIME_ZONE: SCRIPT_TIME_ZONE,
    formatDate: formatDate,
    zoneOffsetMinutes: zoneOffsetMinutes,
    createUtilities: createUtilities,
    createUrlFetchApp: createUrlFetchApp,
    createDatabaseCache: createDatabaseCache,
    createContentService: createContentService,
    createHtmlService: createHtmlService,
    createLocalProperties: createLocalProperties,
    createEdgeGlobals: createEdgeGlobals,
    describeRequest: describeRequest,
    requestKey: requestKey,
    httpResponse: httpResponse,
    isDatabaseCacheKey: isDatabaseCacheKey
  };
});
