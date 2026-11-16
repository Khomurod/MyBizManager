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
const { createTashkentDate } = require('../supabase/functions/api/lib/zoned-date.js');
const edgeShims = require('../supabase/functions/api/lib/gas-shims.js');

const SCRIPT_PATH = path.join(__dirname, '..', 'script.gs');

// `MBM_RUNTIME=edge` (with MBM_STORAGE=supabase): every request a test sends
// through doPost / doGet / the jobs is served the way the Supabase Edge
// function serves it -- the generated runtime (scripts/edge-runtime.js) over
// the Edge stand-ins for the Apps Script services, through the replay
// executor. Everything else a test calls directly still runs in the sandbox,
// against the same in-memory database.
const EDGE_RUNTIME = process.env.MBM_RUNTIME === 'edge';
const edgeExecutor = require('../supabase/functions/api/lib/executor.js');
const edgeRouting = require('../supabase/functions/api/lib/routing.js');
const { buildRuntimeSource, ENTRY_POINTS: EDGE_ENTRY_POINTS } = require('../scripts/edge-runtime');
let edgeFactory = null;

/** The runtime factory, built from the current script.gs once per process. */
function edgeRuntimeFactory() {
  if (!edgeFactory) {
    const source = buildRuntimeSource(fs.readFileSync(SCRIPT_PATH, 'utf8'));
    const holder = { exports: {} };
    vm.runInThisContext('(function (module) {\n' + source + '\n})', { filename: 'runtime.js' })(holder);
    edgeFactory = holder.exports;
  }
  return edgeFactory;
}

/** Script Properties that stay in Apps Script when the settings move to the database. */
const LOCAL_PROPERTY_KEYS = new Set([
  'OMAD_STORAGE', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'OMAD_STORAGE_IMPORT', 'OMAD_PROPERTIES_STORE'
]);

/**
 * `gas.__properties` when the settings live in app_properties: reads and
 * writes of a shared setting go to the database, so a test that seeds or
 * inspects a property sees what the backend sees.
 */
function propertiesView(local, supabase) {
  const shared = key => typeof key === 'string' && !LOCAL_PROPERTY_KEYS.has(key);
  return new Proxy(local, {
    get: (target, key) => {
      if (!shared(key)) return target[key];
      const map = supabase.properties();
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
    },
    set: (target, key, value) => {
      if (shared(key)) supabase.setProperty(key, value);
      else target[key] = value;
      return true;
    },
    deleteProperty: (target, key) => {
      if (shared(key)) supabase.setProperty(key, undefined);
      else delete target[key];
      return true;
    },
    has: (target, key) => (shared(key) ? Object.prototype.hasOwnProperty.call(supabase.properties(), key) : key in target),
    ownKeys: target => Array.from(new Set(Object.keys(target).filter(k => !shared(k)).concat(Object.keys(supabase.properties())))),
    getOwnPropertyDescriptor: (target, key) => {
      if (!shared(key)) return Object.getOwnPropertyDescriptor(target, key);
      const map = supabase.properties();
      if (!Object.prototype.hasOwnProperty.call(map, key)) return undefined;
      return { value: map[key], writable: true, enumerable: true, configurable: true };
    }
  });
}

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

function createSheet(name, rows, coerce, strictGrid) {
  const data = rows ? rows.map(r => r.slice()) : [];
  const formats = {};
  const formatKey = (row, col) => `${row},${col}`;
  const apply = (value, row, col) =>
    (coerce ? coerceLikeSheets(value, formats[formatKey(row, col)]) : value);

  // A new tab's grid, as Sheets makes it: with strictGrid (the spreadsheets
  // the script creates in Drive) a range outside it is an error. The bound
  // spreadsheet's tabs grew with appendRow long before these tests existed.
  let maxRows = Math.max(1000, data.length);
  let maxColumns = Math.max(26, data.reduce((width, row) => Math.max(width, row.length), 0));
  const sheet = {
    name,
    data,
    formats,
    getName: () => name,
    getLastRow: () => data.length,
    getMaxRows: () => maxRows,
    getMaxColumns: () => maxColumns,
    insertRowsAfter(after, howMany) { maxRows += howMany; },
    insertColumnsAfter(after, howMany) { maxColumns += howMany; },
    clearContents() { data.length = 0; },
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
      // appendRow grows the grid, as it does in Sheets; a range never does.
      if (strictGrid && (row - 1 + rowCount > Math.max(maxRows, data.length) || col - 1 + colCount > maxColumns)) {
        throw new Error('Exception: The coordinates of the range are outside the dimensions of the sheet.');
      }
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
        setNumberFormats(grid) {
          for (let i = 0; i < grid.length; i++) {
            for (let j = 0; j < grid[i].length; j++) formats[formatKey(row + i, col + j)] = grid[i][j];
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

let spreadsheetIds = 0;

function createSpreadsheet(initialSheets, coerce, strictGrid) {
  const sheets = {};
  Object.keys(initialSheets || {}).forEach(name => {
    sheets[name] = createSheet(name, initialSheets[name], coerce, strictGrid);
  });
  const id = 'sheet-id-' + (++spreadsheetIds);
  return {
    sheets,
    getId: () => id,
    deleteSheet(sheet) {
      if (Object.keys(sheets).length < 2) throw new Error('Exception: You can\'t remove all the sheets in a document.');
      delete sheets[sheet.getName()];
    },
    getSheetByName: name => sheets[name] || null,
    // Insertion order, as the real Spreadsheet returns tabs left to right.
    getSheets: () => Object.keys(sheets).map(name => sheets[name]),
    insertSheet(name) {
      sheets[name] = createSheet(name, [], coerce, strictGrid);
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
  // On Supabase the settings live in app_properties (03_settings.gs), as they
  // do in production once they have been moved there; `propertiesInDatabase:
  // false` is the state before that move.
  const sharedInDatabase = !!supabase && storage === 'supabase' && options.propertiesInDatabase !== false;
  if (sharedInDatabase) {
    if (properties.OMAD_PROPERTIES_STORE === undefined) properties.OMAD_PROPERTIES_STORE = 'supabase';
    Object.keys(properties).forEach(key => {
      if (LOCAL_PROPERTY_KEYS.has(key)) return;
      supabase.setProperty(key, properties[key]);
      delete properties[key];
    });
    supabase.setProperty('__PROPERTIES_READY', new Date().toISOString());
  }
  const spreadsheet = createSpreadsheet(options.sheets || {}, options.coerceLikeSheets === true);
  const drive = {};
  const triggers = (options.triggers || []).slice();
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
    // Apps Script's local time zone is the script's own, Asia/Tashkent, not
    // the host's: `new Date().getDate()` is the day in Tashkent there. The
    // Edge runtime uses this same class, so the tests run on the clock the
    // backend actually has, whatever TZ the machine running them is in.
    Date: createTashkentDate(Date),
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
        deleteProperty: key => { delete properties[key]; },
        getProperties: () => Object.assign({}, properties),
        setProperties: (values, deleteAllOthers) => {
          if (deleteAllOthers) Object.keys(properties).forEach(key => { delete properties[key]; });
          Object.keys(values || {}).forEach(key => { properties[key] = String(values[key]); });
        }
      })
    },

    // Spreadsheets the script made in Drive (the daily database copy), by id.
    // They type text the way the live spreadsheet does, so a test sees what a
    // cell written without a text format would have become.
    __drive: drive,

    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      create(title) {
        const file = createSpreadsheet({ Sheet1: [] }, true, true);
        file.title = title;
        drive[file.getId()] = file;
        return file;
      },
      openById(id) {
        if (!drive[id]) throw new Error('Exception: Unexpected error while getting the method or property openById on object SpreadsheetApp.');
        return drive[id];
      }
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
      // Apps Script substitutes the pattern tokens *in the zone it is given*.
      // This mock once recognised one literal pattern and returned dd/MM/yyyy
      // for everything else, and later ignored the zone and used the host's
      // local getters -- so a date the code formatted for Tashkent was tested
      // as whatever the CI machine's day was. It is now the Edge runtime's own
      // implementation (supabase/functions/api/lib/gas-shims.js).
      formatDate: (date, tz, format) => edgeShims.formatDate(date, tz, format || 'dd/MM/yyyy'),
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
      getProjectTriggers: () => triggers.map(name => ({
        getHandlerFunction: () => name
      })),
      newTrigger: name => {
        const builder = {
          timeBased: () => builder,
          everyDays: () => builder,
          everyMinutes: () => builder,
          atHour: () => builder,
          create: () => { triggers.push(name); return { getHandlerFunction: () => name }; }
        };
        return builder;
      }
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
  if ((EDGE_RUNTIME || options.edgeRuntime) && sharedInDatabase) installEdgeRuntime(sandbox, supabase, cacheStore, options);
  if (sharedInDatabase) sandbox.__properties = propertiesView(properties, supabase);

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
  // A write made here lands through a document of its own, the way a separate
  // request's would. Whatever document the backend had memoised (a read it did
  // a moment ago, a revision bump that read the settings) belongs to the
  // request before it, so it is dropped -- otherwise its cached rows would
  // hide the write from the next call, which in production is a new request.
  const WRITES = new Set(['appendRow', 'deleteRow', 'deleteRows', 'setConfigValue',
    'setValue', 'setValues', 'clear', 'clearContent']);
  const afterWrite = result => {
    const lease = sandbox.STORAGE_LEASE_;
    if (sandbox.APP_DOC_MEMO_ && (!lease || !lease.depth)) sandbox.resetStorageMemos_();
    return result;
  };
  const writing = (target, prop) => (...args) => afterWrite(target[prop](...args));
  const wrapRange = range => new Proxy(range, {
    get: (target, prop) => {
      if (prop === 'getValues') return () => outer(target.getValues());
      if (WRITES.has(prop) && typeof target[prop] === 'function') return writing(target, prop);
      return target[prop];
    }
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
        if (WRITES.has(prop) && typeof target[prop] === 'function') return writing(target, prop);
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
/**
 * Serves the entry points through the Edge runtime (see EDGE_RUNTIME).
 *
 * The database is the same in-memory one; requests to app_cache are answered
 * from the harness's cache store, so a test that seeds or reads `gas.__cache`
 * sees what the Edge runtime's CacheService sees. Outbound calls (Telegram)
 * go through the sandbox's UrlFetchApp, so they are recorded as before.
 *
 * A test that replaces a backend function in the sandbox is instrumenting the
 * sandbox's copy, which the runtime does not have; while any is replaced, the
 * entry points run in the sandbox as they always did.
 */
function installEdgeRuntime(sandbox, supabase, cacheStore, options) {
  const factory = edgeRuntimeFactory();
  const snapshot = new Map();
  for (const name of Object.keys(sandbox)) {
    if (typeof sandbox[name] === 'function') snapshot.set(name, sandbox[name]);
  }
  const instrumented = () => {
    for (const [name, fn] of snapshot) {
      if (!EDGE_ENTRY_POINTS.includes(name) && sandbox[name] !== fn) return true;
    }
    return false;
  };

  const answer = response => ({
    code: response.getResponseCode(),
    text: String(response.getContentText() || ''),
    headers: typeof response.getHeaders === 'function' ? (response.getHeaders() || {}) : {}
  });
  const cacheAnswer = request => {
    const parsed = new URL(request.url);
    const keyFilter = parsed.searchParams.get('key');
    const key = keyFilter ? decodeURIComponent(keyFilter.replace(/^eq\./, '')) : '';
    if (request.method === 'get') {
      const has = Object.prototype.hasOwnProperty.call(cacheStore, key);
      return { code: 200, headers: {}, text: JSON.stringify(has ? [{ value: cacheStore[key], expires_at: '2999-01-01T00:00:00.000Z' }] : []) };
    }
    if (request.method === 'post') {
      JSON.parse(request.body).forEach(row => { cacheStore[row.key] = row.value; });
      return { code: 201, headers: {}, text: '' };
    }
    if (request.method === 'delete') {
      delete cacheStore[key];
      return { code: 204, headers: {}, text: '' };
    }
    return { code: 405, headers: {}, text: '' };
  };
  const one = request => {
    if (supabase.owns(request.url) && new URL(request.url).pathname === '/rest/v1/app_cache') return cacheAnswer(request);
    const params = {
      method: request.method,
      headers: request.headers,
      muteHttpExceptions: true
    };
    if (request.body !== null) {
      params.payload = request.body;
      if (request.headers['Content-Type']) params.contentType = request.headers['Content-Type'];
    }
    try {
      return answer(sandbox.UrlFetchApp.fetch(request.url, params));
    } catch (error) {
      return { transportError: String(error && error.message || error) };
    }
  };
  const perform = work => {
    if (work.kind === 'fetchAll') {
      if (work.requests.every(r => supabase.owns(r.url))) return supabase.parallel(() => work.requests.map(one));
      return work.requests.map(one);
    }
    return one(work.request);
  };
  const env = {
    supabaseUrl: supabase.url,
    supabaseKey: supabase.key,
    publicUrl: options.webAppUrl || '',
    console,
    randomUuid: () => sandbox.Utilities.getUuid()
  };

  for (const name of EDGE_ENTRY_POINTS) {
    const inSandbox = sandbox[name];
    sandbox[name] = function (event) {
      if (instrumented()) return inSandbox.apply(this, arguments);
      // What the Edge function always forwards to Apps Script runs where Apps
      // Script would run it.
      if (name === 'doPost' && edgeRouting.routePost(event && event.postData && event.postData.contents,
        { ready: true, allow: '*,telegram,jobs' }) !== 'edge') return inSandbox.apply(this, arguments);
      // Whatever the sandbox had memoised belongs to the request before.
      sandbox.resetRequestMemos_();
      const tape = edgeExecutor.createTape();
      let step;
      try {
        step = edgeExecutor.runSync({
          tape,
          makeGlobals: ctx => edgeShims.createEdgeGlobals(ctx, env),
          invoke: G => factory(G)[name](event),
          perform,
          performDeferred: requests => requests.forEach(perform)
        });
      } finally {
        // As index.ts does: a lease a failed run kept is handed back.
        edgeExecutor.leasesLeftHeld(tape).forEach(owner => supabase.handle(supabase.url + '/rest/v1/rpc/mbm_unlock', {
          method: 'post', headers: { apikey: supabase.key, 'Content-Type': 'application/json' },
          payload: JSON.stringify({ p_owner: owner })
        }));
      }
      sandbox.__edgeRuns = (sandbox.__edgeRuns || 0) + 1;
      if ('error' in step && step.error !== undefined) throw step.error;
      return step.result;
    };
    snapshot.set(name, sandbox[name]);
  }
}

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
  EDGE_RUNTIME,
  sheetsOnly, SUPABASE_RUN, supabaseInsertSizes, supabaseRoundTrips,
  loadScript, readJsonOutput, postEvent, createSpreadsheet, todayKey, currentPeriodKey
};
