// Checks a widget against the BP "Immutable Rules" (see the bp-widget-developer troubleshooting reference).
// severity: error = BP will fail or silently misbehave, warn = likely problem, info = hint.

const EXPORT_RE = /^\s*export\s+default\s+([A-Z]\w+)\s*[;\n]/m;

function stripStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += q;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += q;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

function findAll(src, re, cb) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(src))) cb(m);
}

function lint(w) {
  const out = [];
  const add = (severity, rule, file, line, message) => out.push({ severity, rule, file, line: line || 0, message });
  const files = { 'index.html': w.html, 'index.js': w.js, 'style.css': w.css };
  const { version, kind } = w.meta;

  for (const [file, src] of Object.entries(files)) {
    findAll(src, /[^\x00-\x7F]/, (m) => {
      add('error', 'ascii', file, lineOf(src, m.index), 'Non-ASCII character U+' + m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + ' (BOM, smart quote, NBSP, en/em dash?). BP esbuild fails with a garbled "Expected \';\'" error.');
    });
    findAll(src, /['"]use strict['"]/, (m) => add('error', 'use-strict', file, lineOf(src, m.index), "'use strict' is not allowed in widget source."));
  }

  const js = w.js;
  const jsNoStr = stripStrings(js);
  const html = w.html;

  if (version === 'v2') {
    const m = EXPORT_RE.exec(js);
    const tag = /<([A-Z]\w*)\s+\{\s*\.\.\._widgetProps\s*\}/.exec(html);
    const declared = tag && new RegExp('\\b(const|let|var|function|class)\\s+' + tag[1] + '\\b').test(js);
    if (!m && declared && kind === 'LIST') {
      /* List widgets define `const Widget` and are mounted by the generated index.html */
    } else if (!m && declared) {
      add('warn', 'export-default', 'index.js', 0, 'No "export default ' + tag[1] + ';" - the harness mounts the component named in index.html, but BP\'s extractor regex needs the export line when you author this widget yourself.');
    } else if (!m) {
      add('error', 'export-default', 'index.js', 0, 'Missing "export default <UppercaseName>;" - must match /^\\s*export\\s+default\\s+([A-Z]\\w+)\\s*[;\\n]/m. Inline functions and anonymous arrows will not mount.');
    }
    if (html.trim() && !tag) {
      add('warn', 'v2-html', 'index.html', 0, 'V2 widgets should leave Html empty (or only <Name {..._widgetProps} />); the build generates the mount tag.');
    }
    findAll(jsNoStr, /BPUI\s*\.\s*afterRender\b/, (x) => add('error', 'v2-afterrender', 'index.js', lineOf(js, x.index), 'BPUI.afterRender never fires in V2 widgets (silent failure). Use WIDGET_AFTER_RENDER_CALLBACK or React.useEffect.'));
    findAll(jsNoStr, /BPUI\s*\.\s*Tools\s*\.\s*overrideSubmitButton\b/, (x) => add('warn', 'submit-override', 'index.js', lineOf(js, x.index), 'BPUI.Tools.overrideSubmitButton silently no-ops in some widget contexts; BPActions.overrideSubmitButton is the documented form.'));
    findAll(jsNoStr, /\b(Chart|axios|dayjs|D3|getPageContext)\b(?!\s*:)/, (x) => {
      if (/\.\s*$/.test(jsNoStr.slice(Math.max(0, x.index - 2), x.index))) return;
      add('warn', 'globals', 'index.js', lineOf(js, x.index), 'Global "' + x[1] + '" is not injected into V2 widgets. Allowed: React, ReactDOM, BPUI, jQuery/$, moment, createReactClass, Payments.');
    });
    findAll(jsNoStr, /\b_\s*\.\s*(map|filter|get|debounce|groupBy|sortBy)\b/, (x) => add('warn', 'globals', 'index.js', lineOf(js, x.index), 'lodash (_) is not available in V2 widgets.'));
  } else {
    for (const [file, src] of [['index.html', html], ['index.js', js]]) {
      const bare = stripStrings(src);
      findAll(bare, /\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/, (x) => {
        add('error', 'comments', file, lineOf(src, x.index), 'Comment found. BP\'s V1 parser fails silently on //, /* */ and <!-- --> - strip all comments before saving.');
      });
    }
    findAll(html, /\bclass\s*=/, (x) => add('error', 'classname', 'index.html', lineOf(html, x.index), 'Use className, not class.'));
    findAll(html, /\bfor\s*=/, (x) => add('error', 'htmlfor', 'index.html', lineOf(html, x.index), 'Use htmlFor, not for.'));
    findAll(html, /\bon[a-z]+\s*=/, (x) => add('warn', 'camelcase', 'index.html', lineOf(html, x.index), 'Event handlers must be camelCase (onClick, onChange).'));
    findAll(html, /\bstyle\s*=\s*"/, (x) => add('error', 'style-object', 'index.html', lineOf(html, x.index), 'style takes a JS object (style={{ width: 100 }}), not a CSS string.'));
    if (/BPConnection\b/.test(jsNoStr) && !/BPSystem\s*\.\s*(initialize|initiate)\s*\(/.test(jsNoStr)) {
      add('error', 'initialize', 'index.js', 0, 'BPConnection is used but BPSystem.initialize() is never called (Rule 6).');
    }
    if (/BPSystem\s*\.\s*initiate\s*\(/.test(jsNoStr)) {
      add('info', 'initialize', 'index.js', 0, 'initiate() works but initialize() is the standard form for new code.');
    }
    if (/\.set\s*\(/.test(jsNoStr) && !/refreshState\s*\(/.test(jsNoStr)) {
      add('warn', 'refresh-state', 'index.js', 0, 'ReferenceObject.set() is used but BPActions.refreshState("name") is never called - bound UI will not re-render (Rule 7).');
    }
    if (/\.addNew\s*\(/.test(jsNoStr) && !/refreshState\s*\(/.test(jsNoStr)) {
      add('warn', 'refresh-state', 'index.js', 0, 'Collection mutated but refreshState is never called (Rule 7).');
    }
  }

  if (kind === 'LIST') {
    findAll(jsNoStr, /\b(BPConnection|BPUI\s*\.\s*Tools\s*\.\s*API|\$\s*\.\s*ajax|jQuery\s*\.\s*ajax|fetch\s*\()/, (x) => add('error', 'list-api', 'index.js', lineOf(js, x.index), 'API call inside a List widget (Rule 8) - every row is an instance, so N rows = N calls. Pass data via input parameters.'));
  }

  findAll(js, /rest\/2\.0\/(?!query|login)[A-Za-z_]+\?(?![^'"`]*queryAnsiSql)/, (x) => add('warn', 'queryansisql', 'index.js', lineOf(js, x.index), 'Collection GET on rest/2.0/<ENTITY> without queryAnsiSql returns HTTP 500 (Rule 5).'));
  findAll(js, /\.queryAsync\s*\([^)]*\bIN\s*\(/i, (x) => add('info', 'long-get', 'index.js', lineOf(js, x.index), 'queryAsync can issue a GET; long IN(...) lists may exceed the URL limit and silently return nothing.'));
  findAll(js, /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"]{6,}['"]/i, (x) => add('warn', 'credentials', 'index.js', lineOf(js, x.index), 'Possible hardcoded credential. Store secrets in a custom entity record and read at runtime (Rule 14).'));
  findAll(w.css, /\d(\.\d+)?rem\b/, (x) => add('info', 'rem', 'style.css', lineOf(w.css, x.index), 'BP sets the admin shell root font-size to ~10px, so rem renders at ~62% of what you see here. Prefer px.'));
  if (!w.css.trim() && version === 'v1') add('info', 'css', 'style.css', 0, 'Widget CSS is page-global in BP (not scoped). Use unique class prefixes.');

  return out;
}

module.exports = { lint };
