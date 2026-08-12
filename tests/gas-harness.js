'use strict';

/**
 * Loads script.gs into a Node VM with Google Apps Script globals mocked, so the
 * backend can be unit-tested outside of Apps Script.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
  const properties = Object.assign({}, options.properties || {});
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
        fetchCalls.push({ url, params });
        if (params && params.payload) {
          const body = JSON.parse(params.payload);
          if (url.indexOf('/sendMessage') !== -1) sentMessages.push(body);
        }
        return fetchImpl(url, params);
      }
    },

    Utilities: {
      formatDate: (date, tz, format) => {
        const value = date instanceof Date ? date : new Date(date);
        const pad = n => String(n).padStart(2, '0');
        const day = pad(value.getDate());
        const month = pad(value.getMonth() + 1);
        const year = value.getFullYear();
        if (format === 'dd.MM.yyyy HH:mm') {
          return `${day}.${month}.${year} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
        }
        return `${day}/${month}/${year}`;
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

  return sandbox;
}

/** Parses the JSON body of a jsonOutput_ result. */
function readJsonOutput(output) {
  return JSON.parse(output.__text);
}

/** Builds a doPost event object. `parameter` carries the query string. */
function postEvent(payload, parameter = {}) {
  return { postData: { contents: JSON.stringify(payload) }, parameter };
}

module.exports = { loadScript, readJsonOutput, postEvent, createSpreadsheet };
