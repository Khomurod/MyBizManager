'use strict';

/**
 * Loads script.gs into a Node VM with Google Apps Script globals mocked, so the
 * backend can be unit-tested outside of Apps Script.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT_PATH = path.join(__dirname, '..', 'script.gs');

function createSheet(name, rows) {
  const data = rows ? rows.map(r => r.slice()) : [];
  const sheet = {
    name,
    data,
    getLastRow: () => data.length,
    appendRow(row) { data.push(row.slice()); },
    deleteRow(rowNumber) { data.splice(rowNumber - 1, 1); },
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
            for (let j = 0; j < values[i].length; j++) data[target][col - 1 + j] = values[i][j];
          }
        },
        setValue(value) {
          const target = row - 1;
          while (data.length <= target) data.push([]);
          data[target][col - 1] = value;
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

function createSpreadsheet(initialSheets) {
  const sheets = {};
  Object.keys(initialSheets || {}).forEach(name => {
    sheets[name] = createSheet(name, initialSheets[name]);
  });
  return {
    sheets,
    getSheetByName: name => sheets[name] || null,
    insertSheet(name) {
      sheets[name] = createSheet(name, []);
      return sheets[name];
    }
  };
}

/**
 * @param {object} options
 * @param {object} options.properties  initial Script Properties
 * @param {object} options.sheets      initial sheet name -> rows
 * @param {function} options.fetch     UrlFetchApp.fetch replacement
 */
function loadScript(options = {}) {
  const properties = Object.assign({}, options.properties || {});
  const spreadsheet = createSpreadsheet(options.sheets || {});
  const cacheStore = Object.assign({}, options.cache || {});
  const fetchCalls = [];
  const sentMessages = [];

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
      formatDate: () => '01/01/2026'
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

/** Builds a doPost event object. */
function postEvent(payload) {
  return { postData: { contents: JSON.stringify(payload) } };
}

module.exports = { loadScript, readJsonOutput, postEvent, createSpreadsheet };
