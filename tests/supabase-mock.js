'use strict';

/**
 * An in-memory stand-in for the Supabase REST API (PostgREST), for the tests.
 *
 * It is built from the real migration files in supabase/migrations, so the
 * columns, NOT NULL rules, defaults, CHECK constraints and unique indexes the
 * tests run against are the ones that are live -- a column the storage layer
 * names but the schema does not have is an error here exactly as it is in
 * production. The two triggers the schema defines (the ledger's append-only
 * guard and the audit log's) are reproduced by hand below.
 *
 * Only the slice of PostgREST the storage layer uses is implemented: select
 * with eq/neq/gt/gte/lt/lte/is/in filters, order, offset, limit,
 * `Prefer: count=exact`, inserts (atomic per request), upserts on a conflict
 * column, and PATCH/DELETE with `return=representation`.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');

// ------------------------------------------------------------------ schema

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") quote = !quote;
    if (!quote) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === separator && depth === 0) { parts.push(current); current = ''; continue; }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** The text inside the parentheses that open at `start`. */
function balanced(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') { depth--; if (depth === 0) return text.slice(start + 1, i); }
  }
  throw new Error('unbalanced parentheses in schema');
}

function parseDefault(raw, type) {
  const value = raw.trim();
  if (/^now\(\)$/i.test(value)) return () => new Date().toISOString();
  const quoted = /^'((?:[^']|'')*)'(::\w+)?$/.exec(value);
  if (quoted) {
    const text = quoted[1].replace(/''/g, "'");
    return () => (type === 'jsonb' ? JSON.parse(text) : text);
  }
  if (/^(true|false)$/i.test(value)) return () => value.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return () => Number(value);
  throw new Error('unsupported default: ' + raw);
}

/** A predicate from the handful of CHECK / WHERE shapes the schema uses. */
function parseCondition(text) {
  const clauses = text.split(/\s+or\s+/i).map(orPart => orPart.split(/\s+and\s+/i).map(c => c.trim()));
  const atom = expr => {
    let m;
    if ((m = /^(\w+)\s+in\s+\((.*)\)$/i.exec(expr))) {
      const allowed = m[2].split(',').map(v => v.trim().replace(/^'|'$/g, ''));
      return row => row[m[1]] === null || allowed.indexOf(String(row[m[1]])) !== -1;
    }
    if ((m = /^(\w+)\s+~\s+'(.*)'$/.exec(expr))) {
      const re = new RegExp(m[2]);
      return row => row[m[1]] === null || re.test(String(row[m[1]]));
    }
    if ((m = /^(\w+)\s+(=|<>|>=)\s+'?([^']*)'?$/.exec(expr))) {
      const col = m[1]; const op = m[2]; const literal = m[3];
      return row => {
        const v = row[col];
        if (op === '>=') return v === null || Number(v) >= Number(literal);
        if (op === '=') return v !== null && String(v) === literal;
        return v !== null && String(v) !== literal;
      };
    }
    if ((m = /^(\w+)\s+is\s+not\s+null$/i.exec(expr))) return row => row[m[1]] !== null && row[m[1]] !== undefined;
    throw new Error('unsupported condition: ' + expr);
  };
  const compiled = clauses.map(and => and.map(atom));
  return row => compiled.some(and => and.every(test => test(row)));
}

function loadSchema() {
  const sql = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    .map(f => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')).join('\n')
    .replace(/--[^\n]*/g, '');
  const tables = {};

  const createRe = /create table public\.(\w+) \(/g;
  let match;
  while ((match = createRe.exec(sql))) {
    const name = match[1];
    const body = balanced(sql, match.index + match[0].length - 1);
    const table = { name, columns: {}, order: [], checks: [], uniques: [] };
    splitTopLevel(body, ',').forEach(line => {
      const def = line.trim().replace(/\s+/g, ' ');
      const m = /^(\w+) (\w+)(.*)$/.exec(def);
      const column = { name: m[1], type: m[2], notNull: false, identity: false, generated: false, def: null };
      let rest = m[3];
      if (/generated always as identity/i.test(rest)) column.identity = true;
      if (/generated always as \(/i.test(rest)) column.generated = true;
      if (/primary key/i.test(rest)) { column.notNull = true; table.uniques.push({ columns: [column.name], where: null }); }
      if (/\bunique\b/i.test(rest)) table.uniques.push({ columns: [column.name], where: null });
      if (/not null/i.test(rest)) column.notNull = true;
      const checkAt = rest.search(/check \(/i);
      if (checkAt !== -1) {
        table.checks.push({ column: column.name, test: parseCondition(balanced(rest, rest.indexOf('(', checkAt))) });
        rest = rest.slice(0, checkAt);
      }
      const dm = / default (.+?)( not null| check| unique|$)/i.exec(rest);
      if (dm) column.def = parseDefault(dm[1], column.type);
      table.columns[column.name] = column;
      table.order.push(column.name);
    });
    tables[name] = table;
  }

  // alter table public.<t> add column <definition>;
  const alterRe = /alter table public\.(\w+) add column ([^;]+);/g;
  while ((match = alterRe.exec(sql))) {
    const def = match[2].trim().replace(/\s+/g, ' ');
    const m = /^(\w+) (\w+)(.*)$/.exec(def);
    const column = { name: m[1], type: m[2], notNull: /not null/i.test(m[3]),
      identity: /generated always as identity/i.test(m[3]), generated: false, def: null };
    const dm = / default (.+?)( not null| check| unique|$)/i.exec(m[3]);
    if (dm) column.def = parseDefault(dm[1], column.type);
    if (/\bunique\b/i.test(m[3])) tables[match[1]].uniques.push({ columns: [column.name], where: null });
    tables[match[1]].columns[column.name] = column;
    tables[match[1]].order.push(column.name);
  }

  const indexRe = /create unique index \w+ on public\.(\w+) \(([^)]*)\)(\s+where ([^;]+))?;/g;
  while ((match = indexRe.exec(sql))) {
    tables[match[1]].uniques.push({
      columns: match[2].split(',').map(c => c.trim()),
      where: match[4] ? parseCondition(match[4].trim()) : null
    });
  }
  return tables;
}

// ------------------------------------------------------------- triggers

const LEDGER_FROZEN = ['id', 'seq', 'request_id', 'created_at', 'created_by', 'source', 'period', 'tenant',
  'type', 'amount', 'currency', 'rate_buy', 'rate_sell', 'rate_used', 'rate_type', 'amount_uzs', 'method',
  'comment', 'related_id', 'schema_version', 'entry_kind'];

const TRIGGERS = {
  omad_transactions_v2: {
    delete: () => 'omad_transactions_v2 is append-only: rows are never deleted',
    update: (oldRow, newRow) => {
      for (const column of LEDGER_FROZEN) {
        if (JSON.stringify(oldRow[column]) !== JSON.stringify(newRow[column])) {
          return 'omad_transactions_v2 is append-only: only status, updated_at, telegram_msg_id may change';
        }
      }
      if (newRow.entry_group_id !== oldRow.entry_group_id && oldRow.entry_group_id !== '') {
        return 'omad_transactions_v2: a stored Entry_Group_ID is immutable';
      }
      if (newRow.status !== oldRow.status &&
          !(oldRow.status === 'Active' && ['Corrected', 'Cancelled', 'Void'].includes(newRow.status))) {
        return `omad_transactions_v2: illegal status change ${oldRow.status} -> ${newRow.status}`;
      }
      return '';
    }
  },
  omad_audit_log: {
    delete: () => 'omad_audit_log is append-only',
    update: () => 'omad_audit_log is append-only'
  }
};

/** Columns computed by the database rather than stored from the request. */
const GENERATED = {
  cafe_sales: {
    request_id: row => (row.receipt && typeof row.receipt === 'object' && !Array.isArray(row.receipt)
      ? (row.receipt.requestId === undefined || row.receipt.requestId === null ? null : String(row.receipt.requestId))
      : null)
  }
};

// ---------------------------------------------------------------- server

class PgError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function createSupabaseMock(options = {}) {
  const schema = loadSchema();
  const rows = {};
  const sequences = {};
  Object.keys(schema).forEach(name => { rows[name] = []; sequences[name] = 0; });
  const url = options.url || 'https://mock-project.supabase.co';
  const key = options.key || 'sb_secret_test_key_for_the_mock';
  const requests = [];
  // Injected faults: a test says which request should fail, the way a Sheets
  // test makes one range throw. Each is (request) => message | falsy.
  const faults = [];

  const coerce = (column, value) => {
    if (value === null || value === undefined) return null;
    switch (column.type) {
      case 'numeric': case 'integer': case 'bigint': {
        const n = typeof value === 'number' ? value : Number(value);
        if (value === '' || !Number.isFinite(n)) throw new PgError(400, '22P02', `invalid input syntax for type ${column.type}: "${value}"`);
        if (column.type !== 'numeric' && !Number.isInteger(n)) throw new PgError(400, '22P02', `invalid input syntax for type ${column.type}: "${value}"`);
        return n;
      }
      case 'boolean':
        if (typeof value === 'boolean') return value;
        throw new PgError(400, '22P02', `invalid input syntax for type boolean: "${value}"`);
      case 'timestamptz': {
        const d = new Date(String(value));
        if (Number.isNaN(d.getTime())) throw new PgError(400, '22007', `invalid input syntax for type timestamp with time zone: "${value}"`);
        return d.toISOString();
      }
      case 'jsonb': return JSON.parse(JSON.stringify(value));
      default:
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    }
  };

  /** PostgREST renders timestamptz as e.g. 2026-08-12T19:07:52.795+00:00. */
  const render = (column, value) => {
    if (value === null || value === undefined) return null;
    if (column.type === 'timestamptz') return value.replace('.000Z', 'Z').replace('Z', '+00:00');
    if (column.type === 'jsonb') return JSON.parse(JSON.stringify(value));
    return value;
  };

  const validate = (table, row, others) => {
    const def = schema[table];
    for (const name of def.order) {
      const column = def.columns[name];
      if (column.notNull && (row[name] === null || row[name] === undefined)) {
        throw new PgError(400, '23502', `null value in column "${name}" of relation "${table}" violates not-null constraint`);
      }
    }
    for (const check of def.checks) {
      if (!check.test(row)) throw new PgError(400, '23514', `new row for relation "${table}" violates check constraint on "${check.column}"`);
    }
    for (const unique of def.uniques) {
      if (unique.where && !unique.where(row)) continue;
      if (unique.columns.some(c => row[c] === null || row[c] === undefined)) continue;
      const clash = others.find(other => (!unique.where || unique.where(other)) &&
        unique.columns.every(c => String(other[c]) === String(row[c])));
      if (clash) throw new PgError(409, '23505', `duplicate key value violates unique constraint on ${table}(${unique.columns.join(',')})`);
    }
  };

  const build = (table, input) => {
    const def = schema[table];
    const row = {};
    for (const name of Object.keys(input)) {
      if (!def.columns[name]) throw new PgError(400, 'PGRST204', `Could not find the '${name}' column of '${table}' in the schema cache`);
      if (def.columns[name].identity || def.columns[name].generated) {
        throw new PgError(400, '428C9', `cannot insert a non-DEFAULT value into column "${name}"`);
      }
    }
    for (const name of def.order) {
      const column = def.columns[name];
      if (column.identity) { sequences[table] += 1; row[name] = sequences[table]; continue; }
      if (column.generated) continue;
      if (Object.prototype.hasOwnProperty.call(input, name)) row[name] = coerce(column, input[name]);
      else row[name] = column.def ? column.def() : null;
    }
    Object.entries(GENERATED[table] || {}).forEach(([name, fn]) => { row[name] = fn(row); });
    return row;
  };

  const parseFilters = (table, params) => {
    const filters = [];
    for (const [name, raw] of params) {
      if (['select', 'order', 'offset', 'limit', 'on_conflict'].includes(name)) continue;
      const column = schema[table].columns[name];
      if (!column) throw new PgError(400, '42703', `column ${table}.${name} does not exist`);
      const dot = raw.indexOf('.');
      const op = raw.slice(0, dot);
      const value = raw.slice(dot + 1);
      const asType = v => (['numeric', 'integer', 'bigint'].includes(column.type) ? Number(v) : v);
      let test;
      if (op === 'is' && value === 'null') test = v => v === null || v === undefined;
      else if (op === 'eq') test = v => v !== null && String(v) === String(asType(value));
      else if (op === 'neq') test = v => v !== null && String(v) !== String(asType(value));
      else if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
        const n = Number(value);
        test = v => v !== null && (op === 'gt' ? v > n : op === 'gte' ? v >= n : op === 'lt' ? v < n : v <= n);
      } else if (op === 'in') {
        const list = value.replace(/^\(|\)$/g, '').split(',').map(v => String(asType(v.replace(/^"|"$/g, ''))));
        test = v => v !== null && list.includes(String(v));
      } else throw new PgError(400, 'PGRST100', `unsupported operator ${op}`);
      filters.push(row => test(row[name]));
    }
    return row => filters.every(f => f(row));
  };

  const project = (table, row, select) => {
    const names = select ? select.split(',') : schema[table].order;
    const out = {};
    for (const name of names) {
      const column = schema[table].columns[name];
      if (!column) throw new PgError(400, '42703', `column ${table}.${name} does not exist`);
      out[name] = render(column, row[name]);
    }
    return out;
  };

  const respond = (status, body, headers = {}) => ({
    getResponseCode: () => status,
    getContentText: () => (body === undefined ? '' : JSON.stringify(body)),
    getHeaders: () => headers
  });

  function handle(requestUrl, params = {}) {
    const method = String(params.method || 'get').toLowerCase();
    const headers = params.headers || {};
    const payloadRows = params.payload ? [].concat(JSON.parse(params.payload)).length : 0;
    requests.push({ method, url: requestUrl, table: new URL(requestUrl).pathname.replace(/^\/rest\/v1\//, ''), rows: payloadRows });
    if (headers.apikey !== key) return respond(401, { message: 'Invalid API key' });

    const parsed = new URL(requestUrl);
    const table = parsed.pathname.replace(/^\/rest\/v1\//, '');
    if (!schema[table]) return respond(404, { code: '42P01', message: `relation "public.${table}" does not exist` });
    const query = Array.from(parsed.searchParams.entries());
    const get = name => (query.find(([n]) => n === name) || [])[1];
    const prefer = String(headers.Prefer || '');
    const representation = prefer.includes('return=representation');

    const injected = faults.map(f => f({
      method, table, query: Object.fromEntries(query),
      body: params.payload ? JSON.parse(params.payload) : null
    })).find(Boolean);
    if (injected) return respond(503, { message: String(injected) });

    try {
      const match = parseFilters(table, query);
      const list = rows[table];

      if (method === 'get') {
        let selected = list.filter(match);
        const order = get('order');
        if (order) {
          const [column, dir] = order.split('.');
          selected = selected.slice().sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
        }
        const total = selected.length;
        const offset = Number(get('offset') || 0);
        const limit = get('limit') === undefined ? 1000 : Math.min(Number(get('limit')), 1000);
        const page = selected.slice(offset, offset + limit);
        const extra = {};
        if (prefer.includes('count=exact')) {
          extra['Content-Range'] = page.length ? `${offset}-${offset + page.length - 1}/${total}` : `*/${total}`;
        }
        return respond(200, page.map(r => project(table, r, get('select'))), extra);
      }

      if (method === 'post') {
        const body = JSON.parse(params.payload || '[]');
        const inputs = Array.isArray(body) ? body : [body];
        const conflict = get('on_conflict');
        const merge = prefer.includes('resolution=merge-duplicates');
        const staged = list.slice();
        const created = [];
        for (const input of inputs) {
          if (conflict && merge) {
            const existing = staged.find(r => String(r[conflict]) === String(input[conflict]));
            if (existing) {
              const updated = Object.assign({}, existing);
              for (const [name, value] of Object.entries(input)) updated[name] = coerce(schema[table].columns[name], value);
              validate(table, updated, staged.filter(r => r !== existing));
              staged[staged.indexOf(existing)] = updated;
              created.push(updated);
              continue;
            }
          }
          const row = build(table, input);
          validate(table, row, staged);
          staged.push(row);
          created.push(row);
        }
        rows[table] = staged;
        return respond(201, representation ? created.map(r => project(table, r, get('select'))) : undefined);
      }

      if (method === 'patch') {
        const body = JSON.parse(params.payload || '{}');
        const staged = list.slice();
        const changed = [];
        for (let i = 0; i < staged.length; i++) {
          if (!match(staged[i])) continue;
          const updated = Object.assign({}, staged[i]);
          for (const [name, value] of Object.entries(body)) {
            const column = schema[table].columns[name];
            if (!column) throw new PgError(400, 'PGRST204', `Could not find the '${name}' column of '${table}' in the schema cache`);
            if (column.identity || column.generated) throw new PgError(400, '428C9', `column "${name}" can only be updated to DEFAULT`);
            updated[name] = coerce(column, value);
          }
          Object.entries(GENERATED[table] || {}).forEach(([name, fn]) => { updated[name] = fn(updated); });
          const refusal = TRIGGERS[table] && TRIGGERS[table].update(staged[i], updated);
          if (refusal) throw new PgError(400, 'P0001', refusal);
          validate(table, updated, staged.filter((_, j) => j !== i));
          staged[i] = updated;
          changed.push(updated);
        }
        rows[table] = staged;
        return respond(200, representation ? changed.map(r => project(table, r, get('select'))) : undefined);
      }

      if (method === 'delete') {
        const doomed = list.filter(match);
        if (doomed.length && TRIGGERS[table]) throw new PgError(400, 'P0001', TRIGGERS[table].delete());
        rows[table] = list.filter(r => !match(r));
        return respond(200, representation ? doomed.map(r => project(table, r, get('select'))) : undefined);
      }

      return respond(405, { message: 'method not allowed' });
    } catch (error) {
      if (error instanceof PgError) return respond(error.status, { code: error.code, message: error.message });
      throw error;
    }
  }

  return {
    url, key, handle, rows, requests, schema,
    /** Makes matching requests fail; returns a function that removes the fault. */
    fail(fault) {
      faults.push(fault);
      return () => { const i = faults.indexOf(fault); if (i !== -1) faults.splice(i, 1); };
    },
    /** Rows a table holds right now. */
    count: table => rows[table].length,
    /** Whether a URL belongs to this mock. */
    owns: requestUrl => String(requestUrl).indexOf(url + '/rest/v1/') === 0
  };
}

module.exports = { createSupabaseMock, loadSchema };
