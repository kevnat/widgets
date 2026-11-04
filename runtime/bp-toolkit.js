/* Browser-side emulation of the BillingPlatform Web Toolkit (BPSystem, BPActions, BPUI, BPConnection, BPUI.Tools).
 * Loaded inside the preview iframe after React, jQuery and moment. Behaviour follows the Developer Portal
 * docs; anything marked "unverified" is a best guess and is called out in the harness console when used. */
(function () {
  'use strict';
  const h = React.createElement;
  const H = (window.HARNESS = {
    cfg: { mode: 'mock', ctx: {}, fixtures: {}, strict: true, latency: 60 },
    mounted: false,
    dirty: false,
    tick: 0,
    listeners: new Set(),
    errors: [],
    dialogs: {},
    tagState: {},
    loaded: {},
    submit: null,
    afterRender: null,
    warned: {},
  });
  let reqSeq = 0;

  /* ---------- host messaging + console capture ---------- */
  function post(type, data) {
    try { parent.postMessage(Object.assign({ source: 'bp-harness', type }, data), location.origin); } catch (e) { /* standalone */ }
  }
  function fmt(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || v.message;
    try { return JSON.stringify(v, null, 1); } catch (e) { return String(v); }
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach((lvl) => {
    const orig = console[lvl].bind(console);
    console[lvl] = function () {
      orig.apply(null, arguments);
      post('log', { level: lvl, text: Array.prototype.map.call(arguments, fmt).join(' ') });
    };
  });
  window.addEventListener('error', (e) => post('log', { level: 'error', text: 'Uncaught: ' + e.message + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : '') }));
  window.addEventListener('unhandledrejection', (e) => post('log', { level: 'error', text: 'Unhandled rejection: ' + fmt(e.reason) }));
  H.note = (level, text) => post('log', { level, text: '[harness] ' + text });
  H.warnOnce = (key, text) => { if (!H.warned[key]) { H.warned[key] = 1; H.note('warn', text); } };

  /* ---------- rendering plumbing ---------- */
  H.rerender = () => { H.tick++; H.listeners.forEach((f) => f()); };
  H.useRefresh = () => {
    const [, force] = React.useReducer((x) => x + 1, 0);
    React.useEffect(() => { H.listeners.add(force); return () => H.listeners.delete(force); }, []);
    return force;
  };

  /* ---------- mock REST store ---------- */
  const norm = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let store = null;
  H.resetStore = () => {
    store = { entities: clone((H.cfg.fixtures && H.cfg.fixtures.entities) || {}), seq: 90000 };
  };
  const tableKey = (entity) => Object.keys(store.entities).find((k) => norm(k) === norm(entity));
  const table = (entity, create) => {
    let k = tableKey(entity);
    if (!k && create) { k = entity; store.entities[k] = []; }
    return k ? store.entities[k] : null;
  };

  function cmp(a, op, b) {
    const na = Number(a), nb = Number(b);
    const num = a !== '' && b !== '' && !isNaN(na) && !isNaN(nb);
    const x = num ? na : String(a), y = num ? nb : String(b);
    switch (op) {
      case '=': return x === y;
      case '<>': case '!=': return x !== y;
      case '<': return x < y;
      case '>': return x > y;
      case '<=': return x <= y;
      case '>=': return x >= y;
      default: return true;
    }
  }

  function applyWhere(rows, where) {
    if (!where) return rows;
    const conds = where.split(/\s+and\s+/i);
    return rows.filter((row) => conds.every((c) => {
      const m = /^\s*\(?\s*(?:\w+\.)?([\w.]+?)\s*(<=|>=|<>|!=|=|<|>)\s*(?:'([^']*)'|([\w.-]+))\s*\)?\s*$/.exec(c);
      if (!m) return true;
      let field = m[1].split('.').slice(-2).join('.');
      if (/Obj\.Id$/i.test(field)) field = field.replace(/Obj\.Id$/i, 'Id');
      else field = field.split('.').pop();
      if (/^rownum$/i.test(field)) return true;
      if (!(field in row)) return true;
      const val = m[3] !== undefined ? m[3] : m[4];
      return cmp(row[field], m[2], val);
    }));
  }

  function runQuery(sql) {
    const queries = (H.cfg.fixtures && H.cfg.fixtures.queries) || [];
    for (const q of queries) {
      if (new RegExp(q.match, 'i').test(sql)) return clone(q.rows || []);
    }
    const fm = /\bfrom\s+([A-Za-z_][\w]*)/i.exec(sql);
    const rows = fm && table(fm[1]);
    if (!rows) {
      H.warnOnce('q:' + sql.slice(0, 60), 'mock: no fixture for query -> returned 404/empty. Add entities.' + (fm ? fm[1] : '<Entity>') + ' or a queries[] entry matching: ' + sql.replace(/\s+/g, ' ').slice(0, 120));
      return [];
    }
    const wm = /\bwhere\s+([\s\S]*?)(?:\border\s+by\b|\bgroup\s+by\b|\blimit\b|$)/i.exec(sql);
    let out = applyWhere(rows, wm && wm[1].trim());
    const rn = /rownum\s*<\s*(\d+)/i.exec(sql);
    const lim = /\blimit\s+(\d+)/i.exec(sql);
    if (rn) out = out.slice(0, Number(rn[1]) - 1);
    if (lim) out = out.slice(0, Number(lim[1]));
    if (/\b(sum|count|avg|min|max)\s*\(/i.test(sql)) H.warnOnce('agg:' + sql.slice(0, 40), 'mock: aggregate query answered from raw rows; add a queries[] fixture for realistic results');
    return clone(out);
  }

  const bodyObjects = (text) => {
    if (!text) return [];
    const b = JSON.parse(text);
    const o = b.brmObjects != null ? b.brmObjects : b;
    return Array.isArray(o) ? o : [o];
  };

  function mockRest(method, rawPath, bodyText) {
    const [pathPart, qs] = rawPath.split('?');
    const params = new URLSearchParams(qs || '');
    const segs = pathPart.split('/').filter(Boolean);
    const head = (segs[0] || '').toLowerCase();
    if (head === 'login') return { status: 200, data: { loginResponse: [{ SessionId: 'mock-session', UserName: 'mock.user' }] } };
    if (head === 'query') {
      const sql = params.get('sql') || '';
      const rows = runQuery(sql);
      return rows.length ? { status: 200, data: { queryResponse: rows } } : { status: 404, data: { ErrorCode: 'NOT_FOUND', ErrorText: 'No records matched the query' } };
    }
    const entity = segs[0];
    const id = segs[1];
    if (method === 'GET') {
      if (id) {
        const rows = table(entity) || [];
        const row = rows.find((r) => String(r.Id) === String(id));
        return row ? { status: 200, data: { retrieveResponse: [clone(row)] } } : { status: 404, data: { ErrorCode: 'NOT_FOUND', ErrorText: 'Record not found' } };
      }
      if (!params.has('queryAnsiSql')) return { status: 500, data: { ErrorCode: 'SERVER_ERROR', ErrorText: 'queryAnsiSql is required on collection GET calls (HTTP 500 in BP)' } };
      const rows = table(entity);
      if (!rows) H.warnOnce('e:' + entity, 'mock: entity ' + entity + ' has no fixture rows; returning empty');
      return { status: 200, data: { retrieveResponse: clone(applyWhere(rows || [], params.get('queryAnsiSql'))) } };
    }
    const objs = bodyObjects(bodyText);
    const rows = table(entity, method === 'POST' || method === 'PATCH');
    const wrap = { POST: 'createResponse', PUT: 'updateResponse', PATCH: 'upsertResponse', DELETE: 'deleteResponse' }[method] || 'response';
    const res = [];
    if (method === 'POST') {
      objs.forEach((o) => { const row = Object.assign({ Id: String(++store.seq) }, o); rows.push(row); res.push({ ErrorCode: '0', ErrorText: '', Id: row.Id, EntityName: entity }); });
    } else if (method === 'PUT' || method === 'PATCH') {
      objs.forEach((o) => {
        let row = rows && rows.find((r) => String(r.Id) === String(o.Id));
        if (!row && method === 'PATCH') { row = Object.assign({ Id: String(++store.seq) }, o); rows.push(row); } else if (row) Object.assign(row, o);
        res.push(row ? { ErrorCode: '0', ErrorText: '', Id: row.Id, EntityName: entity } : { ErrorCode: 'NOT_FOUND', ErrorText: 'Record not found', Id: o.Id });
      });
    } else if (method === 'DELETE') {
      const i = rows ? rows.findIndex((r) => String(r.Id) === String(id)) : -1;
      if (i >= 0) rows.splice(i, 1);
      res.push(i >= 0 ? { ErrorCode: '0', ErrorText: '', Id: id } : { ErrorCode: 'NOT_FOUND', ErrorText: 'Record not found', Id: id });
    }
    return { status: 200, data: { [wrap]: res } };
  }

  /* ---------- transport (mock or live proxy) ---------- */
  function record(info) { post('net', info); }

  function transportSync(method, restPath, body) {
    const t0 = performance.now();
    const id = ++reqSeq;
    let status, text;
    if (H.cfg.mode === 'live') {
      const x = new XMLHttpRequest();
      x.open(method, '/bp/' + restPath, false);
      x.setRequestHeader('Content-Type', 'application/json');
      try { x.send(body == null ? null : body); } catch (e) { /* network error handled below */ }
      status = x.status || 0;
      text = x.responseText || '';
    } else {
      const r = mockRest(method, restPath, body);
      status = r.status;
      text = JSON.stringify(r.data);
    }
    return finish(id, method, restPath, body, status, text, t0, 'sync');
  }

  function transportAsync(method, restPath, body) {
    const t0 = performance.now();
    const id = ++reqSeq;
    if (H.cfg.mode === 'live') {
      return fetch('/bp/' + restPath, { method, headers: { 'Content-Type': 'application/json' }, body: body == null || method === 'GET' ? undefined : body })
        .then((r) => r.text().then((text) => finish(id, method, restPath, body, r.status, text, t0, 'async')))
        .catch((e) => finish(id, method, restPath, body, 0, JSON.stringify({ ErrorCode: 'NETWORK', ErrorText: e.message }), t0, 'async'));
    }
    return new Promise((resolve) => setTimeout(() => {
      const r = mockRest(method, restPath, body);
      resolve(finish(id, method, restPath, body, r.status, JSON.stringify(r.data), t0, 'async'));
    }, H.cfg.latency));
  }

  function finish(id, method, restPath, body, status, text, t0, kind) {
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* non-JSON */ }
    record({ id, method, url: restPath, status, ms: Math.round(performance.now() - t0), req: body == null ? '' : String(body).slice(0, 20000), res: String(text).slice(0, 40000), mode: H.cfg.mode, kind });
    return { status, data, text };
  }

  function errorsOf(r) {
    if (r.status === 0) return [{ ErrorCode: 'NETWORK', ErrorText: 'No response from harness server' }];
    const live = r.data && Array.isArray(r.data.errors) ? r.data.errors : null;
    if (live && live.length) return live.map((e) => ({ ErrorCode: e.error_code || e.ErrorCode || 'ERROR', ErrorText: e.error_text || e.ErrorText || '' }));
    if (r.status >= 400) {
      const d = r.data || {};
      return [{ ErrorCode: d.ErrorCode || 'HTTP_' + r.status, ErrorText: d.ErrorText || r.text.slice(0, 300) }];
    }
    const out = [];
    Object.keys(r.data || {}).forEach((k) => {
      (Array.isArray(r.data[k]) ? r.data[k] : [r.data[k]]).forEach((v) => {
        if (v && typeof v === 'object' && v.ErrorCode && String(v.ErrorCode) !== '0') out.push({ ErrorCode: v.ErrorCode, ErrorText: v.ErrorText || '' });
      });
    });
    return out;
  }
  const rowsOf = (data) => {
    if (!data) return [];
    const k = Object.keys(data).find((x) => Array.isArray(data[x]));
    return k ? data[k] : [];
  };

  // BP serves `rest/2.0/...` relative to the org path; route widget $.ajax calls through the harness.
  $.ajaxTransport('+*', (opts) => {
    const m = /(?:^|\/)rest\/2\.0\/(.*)$/.exec(opts.url || '');
    if (!m) return undefined;
    return {
      send(headers, complete) {
        transportAsync((opts.type || 'GET').toUpperCase(), m[1], opts.data && typeof opts.data !== 'string' ? JSON.stringify(opts.data) : opts.data)
          .then((r) => complete(r.status || 500, r.status ? 'OK' : 'error', { text: r.text, json: r.text }, 'Content-Type: application/json'));
      },
      abort() {},
    };
  });
  $.ajaxSetup({ dataType: 'json' });

  /* ---------- data classes ---------- */
  const restName = (n) => (/[a-z]/.test(n) && !n.includes('_') ? n.replace(/([a-z0-9])([A-Z])/g, '$1_$2') : n).toUpperCase();
  const plain = (o) => { const out = {}; Object.keys(o).forEach((k) => { out[k] = o[k]; }); return out; };
  const snap = (o) => JSON.stringify(plain(o));
  const classes = {};

  function entityClass(name) {
    if (classes[name]) return classes[name];
    function E(data) {
      Object.defineProperty(this, '__snap', { value: '', writable: true, enumerable: false });
      Object.assign(this, data || {});
      this.__snap = snap(this);
    }
    Object.defineProperty(E, 'name', { value: name });
    E.__entity = name;
    const api = () => entityApi(name);
    E.prototype.__entity = name;
    E.prototype.create = function () { const r = dml('POST', name, [plain(this)], true); if (r[0] && r[0].Id) this.Id = r[0].Id; this.__snap = snap(this); };
    E.prototype.update = function () { dml('PUT', name, [plain(this)], true); this.__snap = snap(this); };
    E.prototype.upsert = function (key) { dml('PATCH', name, [plain(this)], true, key); this.__snap = snap(this); };
    E.prototype.delete = function () { dml('DELETE', name, [plain(this)], true); };
    E.prototype.undelete = function () { H.note('warn', 'undelete is not simulated by the harness'); };
    classes[name] = E;
    return E;
  }

  function dml(method, entity, objs, sync, key) {
    const rest = restName(entity);
    const run = (path, body) => (sync ? transportSync : transportAsync)(method, path, body);
    const handle = (r) => {
      const errs = errorsOf(r);
      if (errs.length) { if (sync) { const e = new Error(errs[0].ErrorText); e.errors = errs; throw e; } return Promise.reject(errs); }
      return rowsOf(r.data);
    };
    if (method === 'DELETE') {
      const results = objs.map((o) => run(rest + '/' + encodeURIComponent(o.Id)));
      if (sync) return results.map((r) => handle(r)[0]);
      return Promise.all(results).then((rs) => rs.map((r) => handle(r)[0]));
    }
    const body = JSON.stringify({ brmObjects: objs });
    const path = method === 'PATCH' && key ? rest + '?upsertKey=' + encodeURIComponent(key) : rest;
    const r = run(path, body);
    return sync ? handle(r) : r.then(handle);
  }

  function deferred(promise) {
    const d = $.Deferred();
    promise.then((v) => d.resolve(v), (e) => d.reject(e));
    return d.promise();
  }

  class BPCollection {
    constructor(elements, Ctor) {
      this.elements = elements || [];
      this.Ctor = Ctor;
    }
    list() { return this.elements; }
    forEach(cb) { this.elements.forEach(cb); }
    find(field, value) { return this.elements.filter((e) => String(e[field]) === String(value)); }
    get length() { return this.elements.length; }
    addNew(obj, index) {
      const row = this.Ctor ? new this.Ctor(obj || {}) : obj || {};
      if (index == null || index > this.elements.length) this.elements.push(row);
      else this.elements.splice(index, 0, row);
      return row;
    }
    get updatedElements() {
      return new BPCollection(this.elements.filter((e) => e.__snap !== undefined && snap(e) !== e.__snap), this.Ctor);
    }
    pick(allOrChanged) { return allOrChanged === false ? this.updatedElements.elements : this.elements; }
    entityName() { return this.Ctor && this.Ctor.__entity; }
    run(method, allOrChanged, key) {
      const items = this.pick(allOrChanged);
      if (!items.length) return [];
      const res = dml(method, this.entityName(), items.map(plain), true, key);
      items.forEach((e, i) => { if (method === 'POST' && res[i] && res[i].Id) e.Id = res[i].Id; if (e.__snap !== undefined) e.__snap = snap(e); });
      return res;
    }
    create(a) { return this.run('POST', a); }
    update(a) { return this.run('PUT', a); }
    delete(a) { return this.run('DELETE', a); }
    undelete() { H.note('warn', 'undelete is not simulated by the harness'); }
    upsert(key, a) { return this.run('PATCH', a, key); }
  }

  function resultOf(getRows, Ctor, isAsync) {
    const wrap = (fn) => (isAsync ? () => deferred(getRows().then(fn)) : () => fn(getRows()));
    const toColl = (rows) => new BPCollection(rows.map((r) => new Ctor(r)), Ctor);
    return {
      collection: wrap(toColl),
      single: wrap((rows) => (rows[0] ? new Ctor(rows[0]) : null)),
      raw: wrap((rows) => JSON.stringify(rows)),
    };
  }

  function entityApi(name) {
    const Ctor = entityClass(name);
    const rest = restName(name);
    const syncRows = (path) => {
      const r = transportSync('GET', path);
      if (r.status === 404) return [];
      const errs = errorsOf(r);
      if (errs.length) { const e = new Error(errs[0].ErrorText); e.errors = errs; throw e; }
      return rowsOf(r.data);
    };
    const asyncRows = (path) => transportAsync('GET', path).then((r) => {
      if (r.status === 404) return [];
      const errs = errorsOf(r);
      if (errs.length) return Promise.reject(errs);
      return rowsOf(r.data);
    });
    const qPath = (bpql) => 'query?sql=' + encodeURIComponent(bpql);
    const fPath = (where) => rest + '?queryAnsiSql=' + encodeURIComponent(where);
    const asCb = (promise, cb) => { const d = deferred(promise); if (cb) d.done(cb); return d; };
    return {
      query: (bpql) => resultOf(() => syncRows(qPath(bpql)), Ctor, false),
      queryAsync: (bpql) => resultOf(() => asyncRows(qPath(bpql)), Ctor, true),
      retrieve: (id) => { const rows = syncRows(rest + '/' + encodeURIComponent(id)); return rows[0] ? new Ctor(rows[0]) : null; },
      retrieveAsync: (id, cb) => asCb(asyncRows(rest + '/' + encodeURIComponent(id)).then((rows) => (rows[0] ? new Ctor(rows[0]) : null)), cb),
      retrieveFiltered: (where) => resultOf(() => syncRows(fPath(where)), Ctor, false),
      retrieveFilteredAsync: (where, cb) => {
        const res = resultOf(() => asyncRows(fPath(where)), Ctor, true);
        if (cb) res.collection().done(cb);
        return res;
      },
      create: (o) => deferred(dml('POST', name, [].concat(o && o.elements ? o.elements : o).map(plain), false)),
      update: (o) => deferred(dml('PUT', name, [].concat(o && o.elements ? o.elements : o).map(plain), false)),
      upsert: (o, key) => deferred(dml('PATCH', name, [].concat(o && o.elements ? o.elements : o).map(plain), false, key)),
      delete: (o) => deferred(dml('DELETE', name, [].concat(o && o.elements ? o.elements : o).map(plain), false)),
      undelete: () => { H.note('warn', 'undelete is not simulated by the harness'); return deferred(Promise.resolve([])); },
    };
  }

  const aggApi = (() => {
    const rowsFor = (sql, isAsync) => {
      const run = () => {
        const queries = (H.cfg.fixtures && H.cfg.fixtures.queries) || [];
        const q = queries.find((x) => new RegExp(x.match, 'i').test(sql));
        const rows = q ? clone(q.rows || []) : [];
        if (!q) H.warnOnce('agg:' + sql.slice(0, 50), 'mock: BrmAggregate query has no queries[] fixture');
        return rows.map((r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = r[k] == null ? r[k] : String(r[k]); }); return o; });
      };
      return isAsync ? () => new Promise((res) => setTimeout(() => res(run()), H.cfg.latency)) : run;
    };
    const mk = (rows, isAsync) => {
      const toColl = (r) => new BPCollection(r, null);
      const wrap = (fn) => (isAsync ? () => deferred(rows().then(fn)) : () => fn(rows()));
      return { collection: wrap(toColl), staticCollection: wrap(toColl), single: wrap((r) => r[0] || null), raw: wrap((r) => JSON.stringify(r)) };
    };
    return {
      query: (sql) => (H.cfg.mode === 'live' ? liveAgg(sql, false) : mk(rowsFor(sql, false), false)),
      queryAsync: (sql) => (H.cfg.mode === 'live' ? liveAgg(sql, true) : mk(rowsFor(sql, true), true)),
    };
    function liveAgg(sql, isAsync) {
      const toStr = (rows) => rows.map((r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = r[k] == null ? r[k] : String(r[k]); }); return o; });
      const path = 'query?sql=' + encodeURIComponent(sql);
      const get = isAsync
        ? () => transportAsync('GET', path).then((r) => (r.status === 404 ? [] : errorsOf(r).length ? Promise.reject(errorsOf(r)) : toStr(rowsOf(r.data))))
        : () => { const r = transportSync('GET', path); return r.status === 404 ? [] : toStr(rowsOf(r.data)); };
      return mk(get, isAsync);
    }
  })();

  window.BPConnection = new Proxy({}, {
    get: (t, prop) => (typeof prop !== 'string' ? undefined : /^brmaggregate$/i.test(prop) ? aggApi : entityApi(prop)),
  });

  // Entity constructors (`new Activity()`) resolve through a scope proxy used when the widget is evaluated.
  H.entityScope = new Proxy({}, {
    has: (t, k) => typeof k === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(k) && !(k in window),
    get: (t, k) => (typeof k === 'string' ? entityClass(k) : undefined),
  });

  /* ---------- BPSystem ---------- */
  const ctx = () => H.cfg.ctx || {};
  window.BPSystem = {
    initialize() { H.initialized = true; },
    initiate() { H.initialized = true; },
    get nodeKey() { return ctx().nodeKey; },
    get nodeId() { return ctx().nodeId || 1; },
    get rootNodeId() { return ctx().rootNodeId || 1; },
    get nodeName() { return ctx().nodeName; },
    get rootNodeName() { return ctx().rootNodeName || ctx().nodeName; },
    get pageName() { return ctx().pageName || ''; },
    get organization() { return H.cfg.org || 'mock-org'; },
    get sessionId() { return H.cfg.mode === 'live' ? 'harness-managed' : 'mock-session'; },
    getSelectedEntityId(type) {
      const sel = ctx().selected || {};
      const k = Object.keys(sel).find((x) => norm(x) === norm(type));
      if (k) return sel[k];
      return norm(type) === norm(ctx().nodeName) ? ctx().nodeKey : undefined;
    },
    toBPObject(json, inst) { return new inst.constructor(json); },
    toBPCollection(arr, inst) { return new BPCollection(arr.map((x) => new inst.constructor(x)), inst.constructor); },
  };

  /* ---------- BPActions ---------- */
  const toMessages = (e) => {
    if (e == null) return [];
    if (typeof e === 'string') return [e];
    if (e instanceof Error) return [e.message];
    if (Array.isArray(e)) return e.reduce((a, x) => a.concat(toMessages(x)), []);
    return [e.ErrorText || e.message || e.ErrorCode || JSON.stringify(e)];
  };
  window.BPActions = {
    refreshState() { H.dirty = false; H.rerender(); },
    changeState(tagId, state) { H.tagState[tagId] = Object.assign({}, H.tagState[tagId], state); H.dirty = false; H.rerender(); },
    showDialog(name, attrs) { H.dialogs[name] = attrs || {}; H.rerender(); },
    closeDialog(name) { delete H.dialogs[name]; H.rerender(); },
    handleError(error, vars) {
      toMessages(error).forEach((t) => { H.errors.push({ text: t }); console.error('[BPActions.handleError] ' + t); });
      H.rerender();
    },
    showError(message, component) { H.errors.push({ text: message, comp: component }); H.rerender(); },
    clearErrors() { H.errors = []; H.rerender(); },
    loadData(component, data) { H.loaded[component] = data; H.note('info', 'loadData(' + component + ') with ' + (Array.isArray(data) ? data.length + ' items' : typeof data)); H.rerender(); },
    overrideSubmitButton(opts) { H.submit = opts; post('submitHooks', { active: true }); },
    uploadFile(selector, entity, field, id) { H.note('info', 'uploadFile(' + [selector, entity, field, id].join(', ') + ') - not simulated'); },
  };

  /* ---------- ReferenceObject ---------- */
  function ReferenceObject(initial) { this.__v = initial; }
  ReferenceObject.prototype.get = function () { return this.__v; };
  ReferenceObject.prototype.set = function (v) {
    this.__v = v;
    if (!H.mounted) return;
    if (!H.cfg.strict) { H.rerender(); return; }
    H.dirty = true;
    clearTimeout(H.dirtyTimer);
    H.dirtyTimer = setTimeout(() => {
      if (H.dirty) H.note('warn', 'ReferenceObject.set() was called but BPActions.refreshState() was not - in BP the bound UI will not re-render (Rule 7). Disable "Strict BP behaviour" to auto-refresh.');
    }, 1200);
  };

  /* ---------- tag helpers ---------- */
  const humanize = (s) => String(s || '').replace(/Id$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const falsy = (v) => v === false || v === 'false';
  const cx = (...a) => a.filter(Boolean).join(' ');

  function fieldMeta(obj, field) {
    const meta = (H.cfg.fixtures && H.cfg.fixtures.meta) || {};
    const ent = obj && obj.__entity;
    const k = ent && Object.keys(meta).find((x) => norm(x) === norm(ent));
    if (k && meta[k][field]) return meta[k][field];
    for (const e of Object.keys(meta)) if (meta[e][field]) return meta[e][field];
    return {};
  }
  function guessType(v) {
    if (typeof v === 'boolean') return 'CHECKBOX';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return 'DATE_SELECTOR';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return 'DATE_TIME_SELECTOR';
    if (typeof v === 'string' && v.length > 80) return 'TEXTAREA';
    return 'TEXT';
  }

  function FieldShell(props) {
    if (props.layout === 'Standalone') return h('span', { className: 'bpw-control' }, props.children);
    return h('div', { className: cx('bpw-field', props.required && 'bpw-required'), name: props.name },
      h('label', { className: 'bpw-label' }, props.label, props.required ? h('span', { className: 'bpw-star' }, '*') : null),
      h('div', { className: 'bpw-control' }, props.children));
  }

  function resolveField(props) {
    const obj = props.variable && props.variable.get();
    const isObj = props.field != null && obj && typeof obj === 'object';
    const meta = isObj ? fieldMeta(obj, props.field) : {};
    const value = isObj ? obj[props.field] : obj && typeof obj === 'object' ? obj.value : obj;
    const type = props.type || meta.type || (isObj ? guessType(value) : 'TEXT');
    const options = meta.options || (obj && obj.values) || [];
    const label = props.label != null ? props.label : meta.label || (isObj ? humanize(props.field) : '');
    return { obj, isObj, value, type, options, label };
  }

  function InputField(props) {
    const force = H.useRefresh();
    const f = resolveField(props);
    const set = (v, ev) => {
      if (f.isObj) f.obj[props.field] = v; else if (f.obj && typeof f.obj === 'object') f.obj.value = v;
      force();
      if (props.onUpdate) props.onUpdate(v, ev || { target: { value: v } });
    };
    const v = f.value == null ? '' : f.value;
    const common = { name: props.name || props.field, disabled: falsy(props.editable) || props.disabled, style: props.width ? { width: isNaN(props.width) ? props.width : props.width + 'px' } : undefined };
    let control;
    switch (f.type) {
      case 'TEXTAREA': control = h('textarea', Object.assign({ className: 'bpw-input', rows: 3, value: v, onChange: (e) => set(e.target.value, e) }, common)); break;
      case 'CHECKBOX': control = h('input', Object.assign({ type: 'checkbox', checked: !!v && v !== '0', onChange: (e) => set(e.target.checked, e) }, common)); break;
      case 'DATE_SELECTOR': control = h('input', Object.assign({ className: 'bpw-input', type: 'date', value: String(v).slice(0, 10), onChange: (e) => set(e.target.value, e) }, common)); break;
      case 'DATE_TIME_SELECTOR': control = h('input', Object.assign({ className: 'bpw-input', type: 'datetime-local', value: String(v).slice(0, 16).replace(' ', 'T'), onChange: (e) => set(e.target.value, e) }, common)); break;
      case 'SELECT1': case 'SELECTX':
        control = h('select', Object.assign({ className: 'bpw-input', multiple: f.type === 'SELECTX', value: v, onChange: (e) => set(f.type === 'SELECTX' ? Array.from(e.target.selectedOptions).map((o) => o.value) : e.target.value, e) }, common),
          f.type === 'SELECT1' ? h('option', { value: '' }, '') : null,
          f.options.map((o) => h('option', { key: o.value || o, value: o.value || o }, o.label || o.value || o)));
        break;
      case 'RADIO_GROUP_VERTICAL': case 'RADIO_GROUP_HORIZONTAL':
        control = h('div', { className: f.type === 'RADIO_GROUP_VERTICAL' ? 'bpw-radios v' : 'bpw-radios' },
          f.options.map((o, i) => h('label', { key: i }, h('input', { type: 'radio', name: common.name || 'r', checked: String(v) === String(o), onChange: (e) => set(o, e) }), ' ' + o)));
        break;
      case 'DOCUMENT': control = h('input', Object.assign({ type: 'file', onChange: (e) => set(e.target.files[0] && e.target.files[0].name, e) }, common)); break;
      default: control = h('input', Object.assign({ className: 'bpw-input', type: 'text', value: v, onChange: (e) => set(e.target.value, e) }, common));
    }
    return h(FieldShell, { label: f.label, required: props.required, layout: props.layout, name: props.name }, control);
  }

  function OutputField(props) {
    H.useRefresh();
    const f = resolveField(props);
    let v = f.value;
    if (props.displayTransform) v = props.displayTransform(v);
    else if (typeof v === 'boolean') v = v ? 'Yes' : 'No';
    return h(FieldShell, { label: f.label, layout: props.layout, name: props.name }, h('span', { className: 'bpw-output' }, v == null ? '' : String(v)));
  }

  function Panel(props) {
    const kids = React.Children.toArray(props.children).map((c, i) => (c && c.type === PanelRow ? c : h('tr', { key: i }, h('td', { colSpan: 4 }, c))));
    return h('table', { className: cx('bpw-panel', props.className), style: props.style, name: props.name }, h('tbody', null, kids));
  }
  function PanelRow(props) { return h('tr', { className: props.className, style: props.style }, props.children); }
  function PanelRowColumn(props) { return h('td', { className: props.className, style: props.style, colSpan: props.colSpan }, props.children); }

  function Message(props) {
    H.useRefresh();
    const msgs = H.errors.filter((e) => !e.comp || e.comp === props.name);
    if (!msgs.length) return null;
    return h('div', { className: 'bpw-message', role: 'alert' }, msgs.map((m, i) => h('div', { key: i }, m.text)));
  }

  function Button(props) {
    return h('button', { type: 'button', className: cx('bpw-btn', props.className), style: props.style, name: props.name, disabled: props.disabled, onClick: props.onClick }, props.title || props.children);
  }
  function Link(props) {
    const fn = typeof props.href === 'function';
    return h('a', { className: cx('bpw-link', props.className), style: props.style, href: fn ? '#' : props.href, onClick: fn ? (e) => { e.preventDefault(); props.href(e); } : undefined }, props.text || props.children);
  }

  function FormLayout(props) {
    return h('div', { className: 'bpw-form' },
      h('div', { className: 'bpw-formbar' },
        h('button', { type: 'button', className: 'bpw-btn primary', onClick: () => props.submitAction && props.submitAction() }, 'Submit'),
        h('button', { type: 'button', className: 'bpw-btn', onClick: () => props.cancelAction && props.cancelAction() }, 'Cancel'),
        h('span', { className: 'bpw-spacer' }),
        h('span', { className: 'bpw-returnlist', title: 'Return to list' }, '↩ Return to List')),
      props.children);
  }

  function Dialog(props) {
    H.useRefresh();
    const a = H.dialogs[props.name];
    if (!a) return null;
    return h('div', { className: 'bpw-overlay', onClick: (e) => { if (e.target === e.currentTarget && a.modal === false) window.BPActions.closeDialog(props.name); } },
      h('div', { className: cx('bpw-dialog', a.dialogClass), style: { width: a.width, maxWidth: a.maxWidth, maxHeight: a.maxHeight } },
        h('div', { className: 'bpw-dialog-title' }, a.title || '', h('button', { className: 'bpw-x', onClick: () => window.BPActions.closeDialog(props.name) }, '×')),
        h('div', { className: 'bpw-dialog-body' }, props.children)));
  }
  function PopupForm(props) { return h('div', { className: 'bpw-popup' }, props.children); }

  function Divider(props) { return h('div', { className: cx('bpw-divider', props.className), style: props.style }, props.children); }
  function Page(props) { return h('div', { className: cx('bpw-page', props.className), style: props.style, 'data-name': props.name }, props.children); }
  function Extension(props) { return h('div', { className: cx('bpw-extension', props.className), style: props.style, 'data-name': props.name }, props.children); }

  function TableColumn() { return null; }
  function columnsOf(children, override) {
    let cols = React.Children.toArray(children).filter((c) => c && c.props && c.props.name).map((c, i) => Object.assign({ pos: i + 1 }, c.props));
    if (override && override.columns) cols = override.columns.map((c, i) => Object.assign({ pos: i + 1 }, c));
    return cols.filter((c) => !(c.hide === true || c.hide === 'true')).sort((a, b) => (Number(a.index) || a.pos) - (Number(b.index) || b.pos));
  }

  function EmbeddedList(props) {
    const force = H.useRefresh();
    const st = H.tagState[props.name] || {};
    const cols = columnsOf(props.children, st);
    const coll = props.variable && props.variable.get();
    const rows = !coll ? [] : coll.elements || (Array.isArray(coll) ? coll : []);
    const canAdd = st.canAdd != null ? st.canAdd : props.canAdd;
    const canDel = !falsy(props.canDel) && !!props.onDel;
    const editableList = !(falsy(props.editable) || props.readOnly === true);
    return h('div', { className: cx('bpw-list', props.className), style: { width: props.width } },
      h('table', { className: 'bpw-table' },
        h('thead', null, h('tr', null, cols.map((c, i) => h('th', { key: i, style: c.width ? { width: c.width } : undefined }, c.label != null ? c.label : humanize(c.name))), (canAdd || canDel) ? h('th', { className: 'bpw-actions' }) : null)),
        h('tbody', null,
          rows.length === 0 ? h('tr', null, h('td', { colSpan: cols.length + 1, className: 'bpw-empty' }, 'No records')) : null,
          rows.map((row, ri) => h('tr', { key: ri, onClick: (e) => props.onRowClick && props.onRowClick(ri, e, row) },
            cols.map((c, ci) => {
              const editable = editableList && !falsy(c.editable) && c.inputMode !== 'disabled';
              const raw = row[c.name];
              const colIdx = Number(c.index) || c.pos;
              if (!editable) return h('td', { key: ci }, c.displayTransform ? c.displayTransform(raw) : raw == null ? '' : String(raw));
              const meta = fieldMeta(row, c.name);
              const type = c.type || meta.type;
              const common = { className: 'bpw-input', value: raw == null ? '' : type === 'DATE_SELECTOR' ? String(raw).slice(0, 10) : raw, onChange: (e) => { row[c.name] = e.target.value; force(); }, onBlur: (e) => props.onCellBlur && props.onCellBlur(ri, colIdx, e, row) };
              if (meta.options) return h('td', { key: ci }, h('select', common, h('option', { value: '' }, ''), meta.options.map((o) => h('option', { key: o, value: o }, o))));
              return h('td', { key: ci }, h('input', Object.assign({ type: type === 'DATE_SELECTOR' ? 'date' : 'text' }, common)));
            }),
            (canAdd || canDel) ? h('td', { key: 'a', className: 'bpw-actions' },
              canAdd ? h('button', { className: 'bpw-icon', title: 'Add row', onClick: (e) => { e.stopPropagation(); if (props.onAdd) props.onAdd(ri, e, coll, rows, null); else if (coll && coll.addNew) { coll.addNew({}, ri + 1); force(); } } }, '+') : null,
              canDel ? h('button', { className: 'bpw-icon', title: 'Remove row', onClick: (e) => { e.stopPropagation(); props.onDel(ri, e, coll, rows, null); } }, '−') : null) : null))),
        null),
      canAdd && rows.length === 0 ? h('button', { className: 'bpw-btn', onClick: (e) => { if (props.onAdd) props.onAdd(-1, e, coll, rows, null); else if (coll && coll.addNew) { coll.addNew({}, 0); force(); } } }, '+ Add') : null);
  }
  function Grid(props) {
    H.warnOnce('grid', 'BPUI.Grid is approximated as a flat read-only table (treeView is not rendered)');
    const rows = (props.variable && props.variable.get()) || (props.mapperFunc ? [] : []);
    return h(EmbeddedList, Object.assign({}, props, { variable: props.variable || { get: () => rows }, readOnly: true }));
  }

  function Placeholder(name) {
    const C = function (props) {
      H.warnOnce('tag:' + name, 'BPUI.' + name + ' is not emulated by the harness (rendered as a placeholder). Verify it in BP.');
      return h('div', { className: 'bpw-placeholder', title: 'Not emulated by the harness' }, 'BPUI.' + name, props.children);
    };
    return C;
  }

  /* ---------- BPUI.Tools ---------- */
  const fmtDate = (d, pattern) => {
    if (!(d instanceof Date) || isNaN(d)) return '';
    const p2 = (n) => String(n).padStart(2, '0');
    return String(pattern || 'MM/dd/yyyy').replace(/yyyy|yy|MM|dd|HH|mm|ss/g, (t) => ({ yyyy: d.getFullYear(), yy: String(d.getFullYear()).slice(2), MM: p2(d.getMonth() + 1), dd: p2(d.getDate()), HH: p2(d.getHours()), mm: p2(d.getMinutes()), ss: p2(d.getSeconds()) }[t]));
  };

  const apiPath = (p) => String(p).replace(/^\/+/, '').replace(/^rest\/2\.0\//, '');
  const parsed = (r) => {
    const errs = errorsOf(r);
    if (r.status === 404) return Promise.reject(Object.assign(new Error('404'), { status: 404, data: r.data }));
    if (errs.length) return Promise.reject(Object.assign(new Error(errs[0].ErrorText), { status: r.status, errors: errs }));
    return Promise.resolve(r.data);
  };
  const API = {
    trimQuery: (s) => String(s).replace(/\s+/g, ' ').trim(),
    get: (path) => transportAsync('GET', apiPath(path)).then(parsed),
    request: (path, o) => { o = o || {}; return transportAsync((o.method || 'GET').toUpperCase(), apiPath(path), o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body).then(parsed); },
    query: (bpql) => transportAsync('GET', 'query?sql=' + encodeURIComponent(bpql)).then((r) => (r.status === 404 ? { data: [] } : parsed(r).then((d) => ({ data: rowsOf(d), response: d })))),
    requestQuery: (sql, opts) => {
      if (!opts) throw new TypeError('BPUI.Tools.API.requestQuery(sql, opts) throws unless opts is passed - pass {} at minimum');
      return transportAsync('GET', 'query?sql=' + encodeURIComponent(sql)).then((r) => {
        if (r.status === 404) {
          if (opts.on404) return { data: opts.on404() };
          return Promise.reject(Object.assign(new Error('404'), { status: 404 }));
        }
        return parsed(r).then((d) => ({ data: rowsOf(d), response: d }));
      });
    },
  };
  ['request', 'requestBP', 'requestRestApi'].forEach((n) => { API[n] = API.request; });
  [['createEntities', 'POST'], ['updateEntities', 'PUT'], ['upsertEntities', 'PATCH'], ['deleteEntities', 'DELETE'], ['undeleteEntities', 'POST']].forEach(([n, m]) => {
    API[n] = (entity, rows) => {
      H.warnOnce('api:' + n, 'BPUI.Tools.API.' + n + ' signature is unverified in the docs; harness assumes (entity, rows)');
      const list = [].concat(rows || []);
      if (m === 'DELETE') return Promise.all(list.map((r) => transportAsync('DELETE', restName(entity) + '/' + (r.Id || r)).then(parsed)));
      return transportAsync(m, restName(entity), JSON.stringify({ brmObjects: list })).then(parsed).then(rowsOf);
    };
  });
  ['exportData', 'uploadFile', 'downloadFile', 'fetchEntityFileBlob'].forEach((n) => { API[n] = () => { H.note('warn', 'BPUI.Tools.API.' + n + ' is not simulated'); return Promise.resolve(null); }; });

  const Tools = {
    API,
    getCurrentRecordId: () => ctx().nodeKey,
    getNodeKey: () => ctx().nodeKey,
    getCurrentEntity: () => ctx().entity || ctx().nodeName,
    getOrgName: () => ctx().orgName || 'harness_org',
    getPageMode: () => ctx().mode || 'R',
    getUserId: () => (ctx().user || {}).id || '1',
    getUserName: () => (ctx().user || {}).name || 'Harness User',
    getUserLogin: () => (ctx().user || {}).login || 'harness.user',
    getRoleList: () => (ctx().user || {}).roles || ['ADMIN'],
    getSessionId: () => window.BPSystem.sessionId,
    getDateFormatUnicode: () => 'MM/dd/yyyy',
    getClassName: (n) => n,
    useTooltip: () => ({}),
    Dates: { format: fmtDate },
    CurrencyFormatter: { format: (v, cur) => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(Number(v) || 0) },
    Logger: console,
    overrideSubmitButton: () => H.note('warn', 'BPUI.Tools.overrideSubmitButton silently no-ops in some contexts; the harness does not wire it. Use BPActions.overrideSubmitButton.'),
  };

  const tags = { Page, Extension, Panel, PanelRow, PanelRowColumn, Divider, Message, Dialog, PopupForm, Button, Button2: Button, Link, InputField, OutputField, EmbeddedList, TableColumn, Grid, FormLayout, FormsLayout: FormLayout };
  const BPUI = new Proxy(Object.assign({ ReferenceObject, Tools, Fields: {} }, tags), {
    get(t, k) {
      if (k === 'viewMode') return ctx().mode || 'R';
      if (k === 'afterRender') return H.afterRender;
      if (k in t) return t[k];
      if (typeof k === 'string' && /^[A-Z]/.test(k)) { t[k] = Placeholder(k); return t[k]; }
      return undefined;
    },
    set(t, k, v) {
      if (k === 'afterRender') { H.afterRender = v; return true; }
      t[k] = v;
      return true;
    },
  });
  window.BPUI = BPUI;
  window.BPCollection = BPCollection;
  window.BPObject = function BPObject() {};
  window.Payments = window.Payments || {};
  window.createReactClass = function (spec) {
    class C extends React.Component {
      constructor(p) {
        super(p);
        Object.keys(spec).forEach((k) => { if (typeof spec[k] === 'function' && !/^(render|componentDid|componentWill|shouldComponent|getInitialState|getDefaultProps)/.test(k)) this[k] = spec[k].bind(this); });
        this.state = spec.getInitialState ? spec.getInitialState.call(this) : {};
      }
    }
    Object.keys(spec).forEach((k) => { if (typeof spec[k] === 'function' && k !== 'getInitialState') C.prototype[k] = spec[k]; });
    if (spec.getDefaultProps) C.defaultProps = spec.getDefaultProps();
    return C;
  };

  H.components = { Page, Extension };
  H.post = post;
})();
