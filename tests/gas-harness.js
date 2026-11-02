'use strict';

/**
 * Loads script.gs into a Node VM with Google Apps Script globals mocked, so the
 * backend can be unit-tested outside of Apps Script.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createSupabaseMock } = require('./supabase-mock');

const SCRIPT_PATH = path.join(__dirname, '..', 'script.gs');

/**
 * Reproduces how Google Sheets rewrites text as it is written into a cell.
 *
 * The live spreadsheet reads typed text with a MM/DD/YYYY locale, so
 * "05/08/2026" (5 August, what the app writes) is stored as 8 May, and a
 * period like "2026-08" becomes a real date. A day above 12 cannot be a
 * month, so Sheets gives up and leaves those as text - which is exactly why
 * only some rows were ever corrupted. Cells formatted as plain text ("@")
 * are left alone, which is the defence the fix relies on.
 *
 * The task sheets are rewritten by two further shapes: a bare ISO date
 * (YYYY-MM-DD) becomes a real date in every locale, and a bare clock time
 * (HH:mm) becomes a time anchored to Sheets' 1899-12-30 epoch. Those two are
 * how the task module lost every start, end, deadline and occurrence key.
 */
function coerceLikeSheets(value, format) {
  if (typeof value !== 'string') return value;
  if (format === '@') return value;

  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (dmy) {
    const first = Number(dmy[1]);
    const second = Number(dmy[2]);
    if (first >= 1 && first <= 12) return new Date(Number(dmy[3]), first - 1, second);
    return value;
  }

  // A bare ISO date is a date to Sheets in every locale, and a bare HH:mm is a
  // time - which is exactly how the task sheets lost their keys.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));

  const hm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (hm) return new Date(1899, 11, 30, Number(hm[1]), Number(hm[2]));

  const yearMonth = /^(\d{4})-(\d{2})$/.exec(value);
  if (yearMonth) return new Date(Number(yearMonth[1]), Number(yearMonth[2]) - 1, 1);

  return value;
}

function createSheet(name, rows, coerce) {
  const data = rows ? rows.map(r => r.slice()) : [];
  const formats = {};
  const formatKey = (row, col) => `${row},${col}`;
  const apply = (value, row, col) =>
    (coerce ? coerceLikeSheets(value, formats[formatKey(row, col)]) : value);

  const sheet = {
    name,
    data,
    formats,
    getName: () => name,
    getLastRow: () => data.length,
    appendRow(row) {
      const target = data.length + 1;
      data.push(row.map((value, index) => apply(value, target, index + 1)));
    },
    deleteRow(rowNumber) { data.splice(rowNumber - 1, 1); },
    deleteRows(rowNumber, howMany) { data.splice(rowNumber - 1, howMany); },
    getDataRange: () => ({
      getValues: () => data.map(r => r.slice())
    }),
    getRange(row, col, numRows, numCols) {
      const rowCount = numRows === undefined ? 1 : numRows;
      const colCount = numCols === undefined ? 1 : numCols;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < rowCount; i++) {
            const source = data[row - 1 + i] || [];
            out.push(source.slice(col - 1, col - 1 + colCount));
          }
          return out;
        },
        setValues(values) {
          for (let i = 0; i < values.length; i++) {
            const target = row - 1 + i;
            while (data.length <= target) data.push([]);
            for (let j = 0; j < values[i].length; j++) {
              data[target][col - 1 + j] = apply(values[i][j], row + i, col + j);
            }
          }
        },
        setValue(value) {
          const target = row - 1;
          while (data.length <= target) data.push([]);
          data[target][col - 1] = apply(value, row, col);
        },
        setNumberFormat(format) {
          for (let i = 0; i < rowCount; i++) {
            for (let j = 0; j < colCount; j++) formats[formatKey(row + i, col + j)] = format;
          }
          return this;
        },
        clearContent() {
          for (let i = 0; i < rowCount; i++) {
            const target = data[row - 1 + i];
            if (!target) continue;
            for (let j = 0; j < colCount; j++) target[col - 1 + j] = "";
          }
        }
      };
    }
  };
  return sheet;
}

function createSpreadsheet(initialSheets, coerce) {
  const sheets = {};
  Object.keys(initialSheets || {}).forEach(name => {
    sheets[name] = createSheet(name, initialSheets[name], coerce);
  });
  return {
    sheets,
    getSheetByName: name => sheets[name] || null,
    // Insertion order, as the real Spreadsheet returns tabs left to right.
    getSheets: () => Object.keys(sheets).map(name => sheets[name]),
    insertSheet(name) {
      sheets[name] = createSheet(name, [], coerce);
      return sheets[name];
    }
  };
}

/**
 * @param {object} options
 * @param {object} options.properties  initial Script Properties
 * @param {object} options.sheets      initial sheet name -> rows
 * @param {function} options.fetch     UrlFetchApp.fetch replacement
 * @param {boolean}  options.coerceLikeSheets
 *        Reproduce the live spreadsheet's MM/DD text coercion on write.
 *        Off by default so existing tests keep their literal values.
 */
function loadScript(options = {}) {
  // Which store the backend runs against. `MBM_STORAGE=supabase npm test`
  // runs the whole suite against the in-memory Supabase (tests/supabase-mock.js),
  // seeded from each test's sheets through the real import code.
  // `supabaseTarget: true` keeps the spreadsheet as the store but gives the
  // backend an (empty) database to import into -- the state before a cutover.
  const storage = options.storage || process.env.MBM_STORAGE || 'sheets';
  const supabase = (storage === 'supabase' || options.supabaseTarget) ? createSupabaseMock() : null;
  const properties = Object.assign({}, options.properties || {});
  if (supabase) {
    if (storage === 'supabase' && properties.OMAD_STORAGE === undefined) properties.OMAD_STORAGE = 'supabase';
    if (properties.SUPABASE_URL === undefined) properties.SUPABASE_URL = supabase.url;
    if (properties.SUPABASE_SECRET_KEY === undefined) properties.SUPABASE_SECRET_KEY = supabase.key;
  }
  const spreadsheet = createSpreadsheet(options.sheets || {}, options.coerceLikeSheets === true);
  const cacheStore = Object.assign({}, options.cache || {});
  const fetchCalls = [];
  const sentMessages = [];
  let uuidCounter = 0;

  const defaultFetch = (url, params) => {
    fetchCalls.push({ url, params });
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ ok: true, result: { message_id: 555 } })
    };
  };

  const fetchImpl = options.fetch || defaultFetch;

  const sandbox = {
    console,
    JSON,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    RegExp,
    Error,
    isNaN,
    parseInt,
    parseFloat,

    __properties: properties,
    __spreadsheet: spreadsheet,
    __cache: cacheStore,
    __fetchCalls: fetchCalls,
    __sentMessages: sentMessages,

    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => (Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : null),
        setProperty: (key, value) => { properties[key] = String(value); },
        deleteProperty: key => { delete properties[key]; }
      })
    },

    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet
    },

    CacheService: {
      getScriptCache: () => ({
        get: key => (Object.prototype.hasOwnProperty.call(cacheStore, key) ? cacheStore[key] : null),
        put: (key, value) => { cacheStore[key] = value; },
        remove: key => { delete cacheStore[key]; }
      })
    },

    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
    },

    UrlFetchApp: {
      fetch: (url, params) => {
        // The database is not an outbound call the tests count.
        if (supabase && supabase.owns(url)) return supabase.handle(url, params);
        fetchCalls.push({ url, params });
        if (params && params.payload) {
          const body = JSON.parse(params.payload);
          if (url.indexOf('/sendMessage') !== -1) sentMessages.push(body);
        }
        return fetchImpl(url, params);
      },
      // Requests sent together: the database counts them as one round trip.
      fetchAll: requests => {
        const one = request => sandbox.UrlFetchApp.fetch(request.url, request);
        if (supabase && requests.every(r => supabase.owns(r.url))) return supabase.parallel(() => requests.map(one));
        return requests.map(one);
      }
    },

    Utilities: {
      // Apps Script substitutes the pattern tokens; this used to recognise one
      // literal pattern and return dd/MM/yyyy for everything else, so code
      // asking for "yyyy-MM-dd" was tested against a string it can never
      // receive in production -- and a café month key sliced out of it was
      // "12/08/2".
      formatDate: (date, tz, format) => {
        const value = date instanceof Date ? date : new Date(date);
        const pad = n => String(n).padStart(2, '0');
        const tokens = {
          yyyy: String(value.getFullYear()),
          MM: pad(value.getMonth() + 1),
          dd: pad(value.getDate()),
          HH: pad(value.getHours()),
          mm: pad(value.getMinutes()),
          ss: pad(value.getSeconds())
        };
        return String(format || 'dd/MM/yyyy')
          .replace(/yyyy|MM|dd|HH|mm|ss/g, match => tokens[match]);
      },
      getUuid: () => {
        uuidCounter += 1;
        return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
      },

      // Apps Script accepts (String, String) or (Byte[], Byte[]) and returns a
      // signed byte array. Node's Buffer is unsigned, so the values are
      // converted the way the runtime hands them over - which is what
      // bytesToHex_ masks back off.
      computeHmacSha256Signature: (value, key) => {
        const toBuffer = input => (Array.isArray(input)
          ? Buffer.from(input.map(b => b & 0xff))
          : Buffer.from(String(input), 'utf8'));
        const mac = crypto.createHmac('sha256', toBuffer(key)).update(toBuffer(value)).digest();
        return Array.from(mac).map(b => (b > 127 ? b - 256 : b));
      },

      newBlob: value => ({
        getBytes: () => Array.from(Buffer.from(String(value), 'utf8')).map(b => (b > 127 ? b - 256 : b)),
        getDataAsString: () => String(value)
      })
    },

    Session: {
      getScriptTimeZone: () => 'Asia/Tashkent'
    },

    ScriptApp: {
      // The deployment the request is being served by, which is what the
      // health check compares the configured webhook URL against.
      getService: () => ({ getUrl: () => options.webAppUrl || '' }),
      getProjectTriggers: () => (options.triggers || []).map(name => ({
        getHandlerFunction: () => name
      }))
    },

    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({
        __text: text,
        setMimeType() { return this; },
        getContent: () => text
      })
    },

    HtmlService: {
      createHtmlOutput: text => ({ __html: text })
    }
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SCRIPT_PATH, 'utf8'), sandbox, { filename: 'script.gs' });

  if (supabase && storage === 'supabase') seedSupabase(sandbox, spreadsheet, supabase);
  else if (supabase) sandbox.__supabase = supabase;

  return sandbox;
}

/**
 * Copies the test's sheets into the in-memory database with the application's
 * own import code, then points `__spreadsheet` at the database, so a test that
 * seeds and inspects sheets reads and writes the store the backend is using.
 *
 * Each call through `__spreadsheet` opens a fresh document, the way each
 * request does, so no row cache outlives the step that made it.
 */
function seedSupabase(sandbox, spreadsheet, supabase) {
  const credentials = { url: supabase.url, key: supabase.key, ok: true, missing: [] };
  const checked = sandbox.prepareSupabaseImport_(spreadsheet);
  if (checked.error) throw new Error('Supabase seed refused the fixture: ' + checked.error);
  sandbox.copyPreparedIntoSupabase_(checked.prepared, sandbox.supabaseDoc_(credentials));

  const fresh = () => sandbox.supabaseDoc_(credentials);
  // Rows built inside the VM are arrays of the VM's realm, which
  // deepStrictEqual refuses to equate with a literal written in a test. The
  // storage layer hands out only strings, numbers and booleans, so a JSON copy
  // is exact.
  const outer = value => JSON.parse(JSON.stringify(value));
  const wrapRange = range => new Proxy(range, {
    get: (target, prop) => (prop === 'getValues' ? () => outer(target.getValues()) : target[prop])
  });
  // A test that patches a method on a sheet it inspects is instrumenting the
  // spreadsheet, which the backend no longer uses; the patch lands on the
  // wrapper and is simply never called by the application.
  const wrapSheet = sheet => {
    if (!sheet) return sheet;
    const patched = {};
    const own = {
      getDataRange: () => wrapRange(sheet.getDataRange()),
      getRange: (...args) => wrapRange(sheet.getRange(...args))
    };
    return new Proxy(sheet, {
      get: (target, prop) => {
        if (Object.prototype.hasOwnProperty.call(patched, prop)) return patched[prop];
        if (Object.prototype.hasOwnProperty.call(own, prop)) return own[prop];
        if (prop === 'data') return outer(target.data);
        return target[prop];
      },
      set: (target, prop, value) => { patched[prop] = value; return true; }
    });
  };

  // "Was this sheet ever created" on a spreadsheet becomes "does the table
  // hold anything" here, for sheets the test did not seed: a table always
  // exists, but an untouched one is what an uncreated sheet used to mean.
  const seeded = new Set(Object.keys(spreadsheet.sheets));
  const exists = name => {
    if (seeded.has(name)) return true;
    const sheet = fresh().getSheetByName(name);
    return !!sheet && sheet.getLastRow() > (name === 'System_Config' ? 0 : 1);
  };
  sandbox.__sheetsSpreadsheet = spreadsheet;
  sandbox.__supabase = supabase;
  sandbox.__spreadsheet = {
    __supabase: true,
    getSheetByName: name => (exists(name) ? wrapSheet(fresh().getSheetByName(name)) : null),
    insertSheet: name => { seeded.add(name); return wrapSheet(fresh().insertSheet(name)); },
    getSheets: () => Array.from(fresh().getSheets()).filter(sheet => exists(sheet.getName())).map(wrapSheet),
    get sheets() {
      const out = {};
      fresh().getSheets().forEach(sheet => {
        if (exists(sheet.getName())) out[sheet.getName()] = wrapSheet(sheet);
      });
      return out;
    }
  };
}

/** Parses the JSON body of a jsonOutput_ result. */
function readJsonOutput(output) {
  return JSON.parse(output.__text);
}

/** Builds a doPost event object. `parameter` carries the query string. */
function postEvent(payload, parameter = {}) {
  return { postData: { contents: JSON.stringify(payload) }, parameter };
}

/**
 * "Today" and "this month", in the timezone the app actually works in.
 *
 * A fixture pinned to a literal date is a test with an expiry date on it. Two
 * suites here compared such a fixture against a bucket the *code* derives from
 * `new Date()` — the café summary's `monthKey` (`buildMiniCafeSummary_`) and the
 * task view's `todayKey` — so they passed when they were written and began
 * failing the moment the calendar moved past them. That is not a flake: it is
 * permanent, and it takes the whole deploy with it, because the release job
 * gates on the unit tests.
 *
 * Anything asserted against a current-time bucket must be dated from these.
 * Anything asserted against a *stored* value (a deadline, a period column, a
 * recurrence key) may stay literal — those mean the same thing for ever.
 *
 * Both are built in Asia/Tashkent, a fixed UTC+5, because that is the engine's
 * clock: between 19:00 and midnight UTC the host's calendar and the engine's
 * disagree about what day it is.
 */
function todayKey() {
  const d = new Date(Date.now() + 5 * 3600000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The canonical `YYYY-MM` period the app is in right now. */
function currentPeriodKey() {
  return todayKey().slice(0, 7);
}

/** True when this run is against the Supabase store (MBM_STORAGE=supabase). */
const SUPABASE_RUN = process.env.MBM_STORAGE === 'supabase';

/**
 * `{ skip }` for a test that is about the spreadsheet itself -- its cell
 * coercion, its number formats, how many times a sheet is read -- and so has
 * no meaning against the database. Shown as a skip, with the reason.
 */
function sheetsOnly(reason) {
  return SUPABASE_RUN ? 'Sheets-only: ' + reason : false;
}

/**
 * On Supabase: the size of every insert request `run` sends to `table`. One
 * request is one statement, so a group that arrives in one request cannot be
 * half-created -- the database's version of "one setValues call".
 */
function supabaseInsertSizes(gas, table, run) {
  const before = gas.__supabase.requests.length;
  run();
  const sizes = [];
  gas.__supabase.requests.slice(before).forEach(r => {
    if (r.method === 'post' && r.table === table) sizes.push(r.rows);
    // A batch sent through mbm_apply: each insert op is one statement.
    if (r.table === 'rpc/mbm_apply') {
      (r.body.ops || []).forEach(op => { if (op.op === 'insert' && op.table === table) sizes.push(op.rows.length); });
    }
  });
  return sizes;
}

/** Round trips to the database while `run` runs: parallel requests count once. */
function supabaseRoundTrips(gas, run) {
  const before = gas.__supabase.requests.length;
  run();
  return new Set(gas.__supabase.requests.slice(before).map(r => r.round)).size;
}

module.exports = {
  sheetsOnly, SUPABASE_RUN, supabaseInsertSizes, supabaseRoundTrips,
  loadScript, readJsonOutput, postEvent, createSpreadsheet, todayKey, currentPeriodKey
};
