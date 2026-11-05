(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v);
    });
    kids.flat().forEach((c) => n.append(c && c.nodeType ? c : document.createTextNode(c == null ? '' : String(c))));
    return n;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('bph.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('bph.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const api = async (url, opts) => {
    const r = await fetch(url, opts && opts.body ? Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts) : opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || 'HTTP ' + r.status); e.data = data; throw e; }
    return data;
  };

  const S = {
    widgets: [], name: null, detail: null, conn: { connected: false }, mode: 'mock', tab: 'console',
    logs: [], net: [], deploy: { steps: [], result: null, error: null, busy: false }, openNet: new Set(),
  };

  /* ---------- per-widget view state ---------- */
  function viewState() {
    return {
      mode: S.mode,
      ctx: { nodeKey: $('ctxKey').value.trim() || undefined, nodeName: $('ctxNode').value.trim() || undefined, entity: $('ctxNode').value.trim() || undefined, mode: $('ctxMode').value },
      kind: $('kindOverride').value || undefined,
      colSpan: Number($('colSpan').value),
      rem10: $('rem10').checked,
      strict: $('strict').checked,
    };
  }
  function saveView() { if (S.name) store.set('view.' + S.name, { ctxKey: $('ctxKey').value, ctxNode: $('ctxNode').value, ctxMode: $('ctxMode').value, kind: $('kindOverride').value, colSpan: $('colSpan').value, rem10: $('rem10').checked, strict: $('strict').checked }); }
  function restoreView() {
    const fx = (S.detail && S.detail.fixtures && S.detail.fixtures.context) || {};
    const v = store.get('view.' + S.name, null) || { ctxKey: fx.nodeKey || '', ctxNode: fx.nodeName || fx.entity || '', ctxMode: fx.mode || 'R', kind: '', colSpan: '2', rem10: true, strict: true };
    $('ctxKey').value = v.ctxKey; $('ctxNode').value = v.ctxNode; $('ctxMode').value = v.ctxMode;
    $('kindOverride').value = v.kind; $('colSpan').value = v.colSpan; $('rem10').checked = v.rem10; $('strict').checked = v.strict;
  }

  /* ---------- preview iframe ---------- */
  let reloadTimer;
  function loadFrame() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (!S.name) return;
      S.logs = []; S.net = []; S.openNet.clear(); renderCounts(); renderPane();
      $('frame').src = '/preview?w=' + encodeURIComponent(S.name) + '&s=' + encodeURIComponent(JSON.stringify(viewState())) + '&t=' + Date.now();
    }, 60);
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.source !== 'bp-harness' || e.source !== $('frame').contentWindow) return;
    const d = e.data;
    if (d.type === 'log') S.logs.push({ t: new Date(), level: d.level, text: d.text });
    else if (d.type === 'net') S.net.push(d);
    else return;
    if (S.logs.length > 500) S.logs.shift();
    renderCounts();
    if ((d.type === 'log' && S.tab === 'console') || (d.type === 'net' && S.tab === 'network')) renderPane();
  });

  /* ---------- widget list / detail ---------- */
  async function loadList(keep) {
    S.widgets = await api('/api/widgets');
    const sel = $('widgetSelect');
    sel.replaceChildren(...S.widgets.map((w) => el('option', { value: w.name }, w.name)));
    if (!S.widgets.length) { sel.replaceChildren(el('option', {}, '(no widgets found)')); return; }
    const want = keep && S.name ? S.name : store.get('last', S.widgets[0].name);
    selectWidget(S.widgets.some((w) => w.name === want) ? want : S.widgets[0].name);
  }

  async function loadDetail() {
    try { S.detail = await api('/api/widget/' + encodeURIComponent(S.name)); } catch (e) { S.detail = null; }
    const m = S.detail && S.detail.meta;
    $('kindBadge').textContent = m ? m.kind : '';
    $('verBadge').textContent = m ? (m.version === 'v2' ? 'V2 New Format' : 'V1 JSX') : '';
    renderCounts();
  }

  async function selectWidget(name) {
    S.name = name; store.set('last', name);
    $('widgetSelect').value = name;
    await loadDetail();
    restoreView();
    loadFrame();
    renderPane();
  }

  /* ---------- bottom panel ---------- */
  function renderCounts() {
    $('nConsole').textContent = S.logs.length || '';
    const errs = S.logs.filter((l) => l.level === 'error').length;
    $('nConsole').className = errs ? 'bad' : '';
    $('nNet').textContent = S.net.length || '';
    const lint = (S.detail && S.detail.lint) || [];
    const e = lint.filter((l) => l.severity === 'error').length;
    $('nLint').textContent = lint.length || '';
    $('nLint').className = e ? 'bad' : '';
  }

  function renderPane() {
    const pane = $('pane');
    document.querySelectorAll('#tabs button[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
    const d = S.detail;
    if (S.tab === 'console') {
      pane.replaceChildren(...(S.logs.length ? S.logs.map((l) => el('div', { class: 'log ' + l.level }, el('span', { class: 't' }, l.t.toLocaleTimeString()), l.text)) : [el('div', { class: 'empty' }, 'console.* output, uncaught errors and [harness] notices appear here.')]));
      pane.scrollTop = pane.scrollHeight;
    } else if (S.tab === 'network') {
      if (!S.net.length) { pane.replaceChildren(el('div', { class: 'empty' }, 'REST calls made by the widget (BPConnection, BPUI.Tools.API, $.ajax to rest/2.0/...) show here, in both mock and live mode.')); return; }
      const rows = [];
      S.net.forEach((n) => {
        const open = S.openNet.has(n.id);
        rows.push(el('tr', { class: 'req', onclick: () => { open ? S.openNet.delete(n.id) : S.openNet.add(n.id); renderPane(); } },
          el('td', {}, n.method), el('td', {}, decodeURIComponent(n.url).slice(0, 110)), el('td', { class: 's' + String(n.status)[0] }, n.status), el('td', {}, n.ms + ' ms'), el('td', {}, n.mode + '/' + n.kind)));
        if (open) rows.push(el('tr', {}, el('td', { colspan: 5 }, n.req ? el('pre', { class: 'detail' }, 'REQUEST\n' + n.req) : '', el('pre', { class: 'detail' }, 'RESPONSE\n' + pretty(n.res)))));
      });
      pane.replaceChildren(el('table', { class: 'net' }, el('tr', {}, el('th', {}, 'Method'), el('th', {}, 'Path'), el('th', {}, 'Status'), el('th', {}, 'Time'), el('th', {}, 'Source')), rows));
    } else if (S.tab === 'lint') {
      const lint = (d && d.lint) || [];
      pane.replaceChildren(...(lint.length ? lint.map((l) => el('div', { class: 'lintrow' }, el('span', { class: 'sev ' + l.severity }, l.severity), el('span', { class: 'loc' }, l.file + (l.line ? ':' + l.line : '')), el('span', {}, l.message))) : [el('div', { class: 'ok' }, 'No findings against the BP Immutable Rules.')]));
    } else if (S.tab === 'compile') {
      const c = d && d.compiled;
      if (!c) { pane.replaceChildren(el('div', { class: 'empty' }, 'No widget loaded.')); return; }
      const out = [el('div', { class: c.ok ? 'ok' : 's5' }, c.ok ? 'Compiled OK with esbuild (what BP\'s Compilation Service would report as PROCESSED).' : 'Compile FAILED (BP would store CompilationStatus = ERROR).')];
      (c.errors || []).forEach((e) => out.push(el('div', { class: 'log error' }, (e.file || '') + (e.line ? ':' + e.line + ':' + e.column : '') + '  ' + e.text + (e.lineText ? '\n    ' + e.lineText.trim() : ''))));
      (c.warnings || []).forEach((e) => out.push(el('div', { class: 'log warn' }, (e.file || '') + (e.line ? ':' + e.line : '') + '  ' + e.text)));
      pane.replaceChildren(...out);
    } else if (S.tab === 'data') {
      const fx = d && d.fixtures;
      pane.replaceChildren(el('div', { class: 'empty' }, 'Mock mode answers REST/BPQL calls from widgets/' + S.name + '/fixtures.json (edit the file; the preview reloads). Live mode ignores it.'), el('pre', { class: 'detail' }, fx && Object.keys(fx).length ? JSON.stringify(fx, null, 2) : '(no fixtures.json - add one with entities, queries, meta, context)'));
    } else if (S.tab === 'deploy') renderDeploy(pane);
  }

  function pretty(s) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { return s; } }

  function renderDeploy(pane) {
    const c = S.conn;
    const D = S.deploy;
    const d = S.detail;
    const lintErrors = ((d && d.lint) || []).filter((l) => l.severity === 'error').length;
    /* Form values live in S.deploy so the pane can be redrawn (busy state, results) without wiping what was typed. */
    const host = el('input', { type: 'text', id: 'dHost', placeholder: c.host || 'connect first', autocomplete: 'off', value: D.host || '', oninput: (e) => { D.host = e.target.value; } });
    const enable = el('input', { type: 'checkbox', id: 'dEnable', checked: D.enable ? 'checked' : false, onchange: (e) => { D.enable = e.target.checked; } });
    const force = el('input', { type: 'checkbox', id: 'dForce', checked: D.force ? 'checked' : false, onchange: (e) => { D.force = e.target.checked; } });
    const go = el('button', { class: 'primary', onclick: doDeploy }, D.busy ? 'Deploying...' : 'Push to WIDGET and compile');
    go.disabled = D.busy || !c.connected || !c.writes;
    pane.replaceChildren(el('div', { class: 'deploy' },
      el('p', {}, 'Pushes this widget\'s source (Html / JavaScript / Css) to the connected org\'s WIDGET record, creating it if the Token is new, then polls until CompilationStatus is PROCESSED or ERROR. Compiled output is never written.'),
      !c.connected ? el('p', { class: 's5' }, 'Not connected. Use the BillingPlatform connection panel.') : !c.writes ? el('p', { class: 's5' }, 'Writes are disabled for ' + c.host + '. Tick "Allow writes" in the connection panel.') : el('p', {}, 'Target: ', el('strong', {}, c.host), ' - token ', el('strong', {}, d ? d.meta.token : '?'), ' (' + (d ? d.meta.kind : '') + ')'),
      el('label', {}, 'Type the host to confirm: ', host),
      el('label', { class: 'check' }, enable, 'Set EnabledFlag = 1'),
      lintErrors ? el('label', { class: 'check' }, force, lintErrors + ' lint error(s) - deploy anyway') : '',
      go,
      D.steps.length ? el('ol', {}, D.steps.map((s) => el('li', {}, s))) : '',
      D.error ? el('div', { class: 'err' }, D.error) : '',
      D.result ? el('div', {},
        el('p', { class: D.result.status === 'PROCESSED' ? 'ok' : D.result.status === 'PENDING' ? 'hint' : 's5' }, 'WIDGET ' + D.result.id + ' -> ' + D.result.status + (D.result.version ? ' (v' + D.result.version + ')' : '') + (D.result.status === 'PENDING' ? ' - still compiling in BP, this is not a failure' : '')),
        D.result.finished === false || D.result.status === 'PENDING' ? el('button', { onclick: checkStatus }, D.checking ? 'Checking...' : 'Check status') : '',
        D.result.errorMessage ? el('pre', { class: 'detail' }, D.result.errorMessage) : '') : '',
      el('p', { class: 'hint' }, 'Still manual after PROCESSED: EnabledFlag, wiring (Buttons and Actions / EXTENSION_WIDGET field / List layout / entity Page lookup) and role access (WIDGET_ROLE etc). Hard-refresh BP after a recompile.')));
  }

  async function checkStatus() {
    const D = S.deploy;
    D.checking = true; renderPane();
    try {
      const r = await api('/api/widget-status/' + encodeURIComponent(S.name));
      if (r.found) { D.result = Object.assign({}, D.result, r); D.error = null; } else { D.error = 'Widget not found in BP'; }
    } catch (e) { D.error = e.message; }
    D.checking = false; renderPane();
  }

  async function doDeploy() {
    const D = S.deploy;
    /* Read the form BEFORE redrawing: renderPane() rebuilds the inputs. */
    const body = { confirm: (D.host || '').trim(), enable: D.enable ? true : undefined, force: !!D.force };
    D.busy = true; D.steps = ['Sending...']; D.error = null; D.result = null; renderPane();
    try {
      const r = await api('/api/deploy/' + encodeURIComponent(S.name), { method: 'POST', body: JSON.stringify(body) });
      D.steps = r.steps; D.result = r.result;
    } catch (e) {
      D.steps = (e.data && e.data.steps) || []; D.error = e.message + (e.data && e.data.lint ? ' - ' + e.data.lint.map((l) => l.message).join(' | ') : '');
    }
    D.busy = false; renderPane();
  }

  /* ---------- connection ---------- */
  function syncConnUi() {
    const c = S.conn;
    const pill = $('connPill');
    pill.textContent = c.connected ? (c.writes ? 'LIVE - writes ON - ' : 'live read-only - ') + c.host : 'not connected';
    pill.className = 'pill ' + (c.connected ? (c.writes ? 'write' : 'on') : 'off');
    $('cConnect').hidden = c.connected; $('cDisconnect').hidden = !c.connected;
    $('writesRow').hidden = !c.connected; $('cWrites').checked = !!c.writes;
    const banner = $('writeBanner');
    banner.hidden = !(c.connected && c.writes);
    banner.textContent = 'Writes are ENABLED against ' + (c.host || '') + ' - widget DML will change real data.';
    ['password', 'session', 'bearer'].forEach((k) => { $({ password: 'cPassword', session: 'cSession', bearer: 'cBearer' }[k]).hidden = $('cAuth').value !== k; });
    if (!c.connected && S.mode === 'live') setMode('mock');
  }

  async function loadConn() {
    S.conn = await api('/api/conn');
    const dflt = S.conn.defaults || {};
    if (!$('cBase').value) $('cBase').value = S.conn.baseUrl || store.get('base', '') || dflt.baseUrl || '';
    if (!$('cUser').value) $('cUser').value = S.conn.username || store.get('user', '') || dflt.username || '';
    if (dflt.authType && !store.get('auth')) $('cAuth').value = dflt.authType; else if (store.get('auth')) $('cAuth').value = store.get('auth');
    syncConnUi();
  }

  async function connect() {
    $('cError').hidden = true;
    const body = { baseUrl: $('cBase').value, authType: $('cAuth').value, username: $('cUser').value, password: $('cPass').value, sessionId: $('cSid').value, token: $('cTok').value };
    store.set('base', body.baseUrl); store.set('user', body.username); store.set('auth', body.authType);
    $('cConnect').disabled = true;
    try {
      S.conn = Object.assign({}, S.conn, await api('/api/conn', { method: 'POST', body: JSON.stringify(body) }));
      $('cPass').value = ''; $('cSid').value = ''; $('cTok').value = '';
      setMode('live');
    } catch (e) { $('cError').textContent = e.message; $('cError').hidden = false; }
    $('cConnect').disabled = false;
    syncConnUi();
  }

  function setMode(m) {
    if (m === 'live' && !S.conn.connected) { $('cBase').focus(); $('cError').textContent = 'Connect to a BP instance to use Live data.'; $('cError').hidden = false; return; }
    S.mode = m; store.set('mode', m);
    document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    loadFrame();
  }

  /* ---------- wiring ---------- */
  $('widgetSelect').addEventListener('change', (e) => selectWidget(e.target.value));
  ['ctxKey', 'ctxNode'].forEach((id) => $(id).addEventListener('change', () => { saveView(); loadFrame(); }));
  ['ctxMode', 'kindOverride', 'colSpan', 'rem10', 'strict'].forEach((id) => $(id).addEventListener('change', () => { saveView(); loadFrame(); }));
  $('viewport').addEventListener('change', (e) => { $('frameWrap').style.width = e.target.value; store.set('vp', e.target.value); });
  $('cAuth').addEventListener('change', syncConnUi);
  $('cConnect').addEventListener('click', connect);
  $('cDisconnect').addEventListener('click', async () => { S.conn = Object.assign({}, S.conn, await api('/api/conn', { method: 'DELETE' })); syncConnUi(); });
  $('cWrites').addEventListener('change', async (e) => {
    try { S.conn = Object.assign({}, S.conn, await api('/api/conn/writes', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) })); } catch (err) { $('cError').textContent = err.message; $('cError').hidden = false; }
    syncConnUi(); if (S.tab === 'deploy') renderPane();
  });
  $('modeSeg').addEventListener('click', (e) => { if (e.target.dataset.mode) setMode(e.target.dataset.mode); });
  function setPanel(collapsed) {
    document.querySelector('.stage').classList.toggle('panel-collapsed', collapsed);
    const t = $('panelToggle');
    t.setAttribute('aria-expanded', String(!collapsed));
    t.innerHTML = collapsed ? '&uarr; Expand' : '&darr; Collapse';
    t.title = collapsed ? 'Show the console panel' : 'Collapse the console panel';
    store.set('panel', collapsed);
  }
  const panelCollapsed = () => document.querySelector('.stage').classList.contains('panel-collapsed');
  $('panelToggle').addEventListener('click', () => setPanel(!panelCollapsed()));

  $('tabs').addEventListener('click', (e) => { if (e.target.dataset && e.target.dataset.tab) { if (panelCollapsed()) setPanel(false); S.tab = e.target.dataset.tab; renderPane(); } });
  $('clearBtn').addEventListener('click', () => { S.logs = []; S.net = []; renderCounts(); renderPane(); });
  $('reloadBtn').addEventListener('click', loadFrame);

  const es = new EventSource('/api/events');
  es.onmessage = async (e) => {
    const ev = JSON.parse(e.data);
    if (ev.kind === 'all') { location.reload(); return; }
    if (ev.kind === 'list') { await loadList(true); return; }
    if (ev.name === S.name) { await loadDetail(); renderPane(); loadFrame(); }
  };

  function setRail(collapsed) {
    document.querySelector('.layout').classList.toggle('rail-collapsed', collapsed);
    const t = $('railToggle');
    t.setAttribute('aria-expanded', String(!collapsed));
    t.innerHTML = collapsed ? 'Panel &raquo;' : '&laquo; Panel';
    t.title = collapsed ? 'Show the left panel' : 'Hide the left panel for more room';
    store.set('rail', collapsed);
  }
  $('railToggle').addEventListener('click', () => setRail(!document.querySelector('.layout').classList.contains('rail-collapsed')));

  (async function init() {
    setRail(!!store.get('rail', false));
    setPanel(!!store.get('panel', false));
    const vp = store.get('vp', '100%'); $('viewport').value = vp; $('frameWrap').style.width = vp;
    await loadConn();
    await loadList(false);
  })();
})();
