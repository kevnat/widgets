/* Mounts one widget inside the preview iframe, wrapped in a frame that resembles where it lives in BP. */
(function () {
  'use strict';
  const h = React.createElement;
  const H = window.HARNESS;
  const q = new URLSearchParams(location.search);
  const name = q.get('w');
  const view = JSON.parse(q.get('s') || '{}');

  document.documentElement.classList.toggle('bp-root10', view.rem10 !== false);

  function ErrorBox(props) {
    return h('div', { className: 'hx-error' },
      h('strong', null, props.title),
      h('pre', null, props.lines.join('\n')));
  }

  class Boundary extends React.Component {
    constructor(p) { super(p); this.state = { err: null }; }
    static getDerivedStateFromError(err) { return { err }; }
    componentDidCatch(err) { console.error('Widget render error: ' + (err.stack || err.message)); }
    render() {
      if (this.state.err) return h(ErrorBox, { title: 'Widget threw while rendering', lines: [String(this.state.err.stack || this.state.err)] });
      return this.props.children;
    }
  }

  function V1Root(props) {
    H.useRefresh();
    React.useEffect(() => {
      H.mounted = true;
      if (typeof H.afterRender === 'function') {
        try { H.afterRender(); } catch (e) { console.error('afterRender threw: ' + (e.stack || e)); }
      }
    }, []);
    return props.inst.render();
  }

  function mockField(label, value) {
    return h('div', { className: 'hx-nativefield' }, h('label', null, label), h('div', null, value));
  }

  function NativeSave() {
    const mode = (H.cfg.ctx || {}).mode;
    H.useRefresh();
    if (mode !== 'E' && mode !== 'N') return null;
    const click = () => {
      const s = H.submit;
      if (s && s.beforeSubmit && s.beforeSubmit() === false) { console.info('[harness] beforeSubmit returned false - native save cancelled'); return; }
      console.info('[harness] native save would run here');
      if (s && s.afterSubmit) s.afterSubmit();
    };
    return h('div', { className: 'hx-savebar' },
      h('button', { className: 'bpw-btn primary', onClick: click }, 'Save (native)'),
      h('span', { className: 'hx-hint' }, H.submit ? 'overrideSubmitButton hooks are registered' : 'no submit hooks registered'));
  }

  function ExtensionFrame(props) {
    const ctx = H.cfg.ctx || {};
    const span = view.colSpan === 1 ? 1 : 2;
    return h('div', { className: 'hx-detail' },
      h('div', { className: 'hx-detail-head' }, h('span', { className: 'hx-crumb' }, ctx.nodeName || 'Record'), h('span', null, ' #' + (ctx.nodeKey || '?')), h('span', { className: 'hx-mode' }, { R: 'Detail', E: 'Edit', N: 'New', L: 'List' }[ctx.mode || 'R'])),
      h(NativeSave),
      h('div', { className: 'hx-grid2' },
        mockField('Name', ctx.sampleName || '(native field)'), mockField('Status', '(native field)'),
        h('div', { className: 'hx-slot span' + span },
          span === 1 ? h('label', { className: 'hx-slotlabel' }, props.label || 'Extension widget') : null,
          h('div', { className: 'hx-slotbody' }, props.children)),
        mockField('Created', '(native field)'), mockField('Updated', '(native field)')));
  }

  function PageFrame(props) {
    const ctx = H.cfg.ctx || {};
    return h('div', { className: 'hx-pageframe' },
      h('div', { className: 'hx-pagebar' }, h('span', { className: 'hx-crumb' }, ctx.nodeName || 'Page'), ctx.nodeKey ? h('span', null, ' / ' + ctx.nodeKey) : null),
      h('div', { className: 'hx-pagebody' }, props.children));
  }

  function ListFrame(props) {
    const rows = view.listRows || (H.cfg.fixtures && H.cfg.fixtures.listRows) || [{}];
    const keys = Object.keys(rows[0] || {});
    return h('table', { className: 'hx-listframe' },
      h('thead', null, h('tr', null, keys.slice(0, 3).map((k) => h('th', { key: k }, k)), h('th', null, '[W] widget column'))),
      h('tbody', null, rows.map((r, i) => h('tr', { key: i },
        keys.slice(0, 3).map((k) => h('td', { key: k }, String(r[k]))),
        h('td', null, props.render(r))))));
  }

  async function boot() {
    const res = await fetch('/api/widget/' + encodeURIComponent(name));
    if (!res.ok) throw new Error('Widget not found: ' + name);
    const w = await res.json();
    let org = '';
    if (view.mode === 'live') {
      try { org = new URL((await (await fetch('/api/conn')).json()).baseUrl).pathname.split('/').filter(Boolean)[0] || ''; } catch (e) { /* org stays empty */ }
    }
    H.cfg = {
      org,
      mode: view.mode === 'live' ? 'live' : 'mock',
      ctx: Object.assign({}, (w.fixtures && w.fixtures.context) || {}, view.ctx || {}),
      fixtures: w.fixtures || {},
      strict: view.strict !== false,
      latency: 60,
    };
    H.resetStore();
    H.post('meta', { meta: w.meta, lint: w.lint, compiled: { ok: w.compiled.ok, errors: w.compiled.errors, warnings: w.compiled.warnings } });
    document.getElementById('widget-css').textContent = w.source.css || '';

    const root = document.getElementById('root');
    if (!w.compiled.ok) {
      const lines = (w.compiled.errors || []).map((e) => e.file + (e.line ? ':' + e.line + ':' + e.column : '') + '  ' + e.text + (e.lineText ? '\n      ' + e.lineText.trim() : ''));
      ReactDOM.createRoot(root).render(h(ErrorBox, { title: 'Compile failed (BP would set CompilationStatus = ERROR)', lines }));
      return;
    }

    const kind = (view.kind || w.meta.kind).toUpperCase();
    const make = new Function('__scope', 'with (__scope) {\n' + w.compiled.code + '\nreturn __widget;\n}');
    let element;
    if (w.compiled.mode === 'v2') {
      const values = { _currentWidgetName: w.meta.token, _widgetLocale: 'en_US', _currentWidgetLabel: w.meta.token, _attributesAll: {} };
      const widgetFn = make(H.entityScope);
      const Comp = await widgetFn.apply(null, w.compiled.params.map((p) => values[p]));
      H.mounted = true;
      if (typeof H.afterRender === 'function') H.note('warn', 'BPUI.afterRender is assigned in a V2 widget - BP never calls it (Rule 16)');
      const mount = (props) => h(Comp, Object.assign({}, props, { _widgetProps: props }));
      element = kind === 'LIST' ? h(ListFrame, { render: (r) => h(Boundary, null, mount(r)) }) : h(Boundary, null, mount({}));
    } else {
      const inst = make(H.entityScope)();
      element = h(Boundary, null, h(V1Root, { inst }));
    }

    const framed = kind === 'EXTENSION' ? h(ExtensionFrame, { label: w.meta.token }, element) : kind === 'PAGE' ? h(PageFrame, null, element) : element;
    ReactDOM.createRoot(root).render(framed);
    H.post('ready', { name });
  }

  boot().catch((e) => {
    console.error('Harness could not mount widget: ' + (e.stack || e));
    ReactDOM.createRoot(document.getElementById('root')).render(h(ErrorBox, { title: 'Could not mount widget', lines: [String(e.stack || e)] }));
  });
})();
