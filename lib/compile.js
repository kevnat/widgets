const esbuild = require('esbuild');

const EXPORT_RE = /^\s*export\s+default\s+([A-Z]\w+)\s*[;\n]/m;
const WIDGET_TAG_RE = /<([A-Z]\w*)\s+\{\s*\.\.\._widgetProps\s*\}\s*\/?>/;

const WRAPPER_PARAMS = [
  '_currentWidgetName', '_currentExtensionValue', '_widgetLocale', '_currentWidgetLabel',
  '_currentWidgetHelp', '_currentExtensionValueRaw', '_daDataAttributeValueRaw',
  '_attributesAll', '_daDataOverride', '_daDisable', '_daSource',
];

function fmtErrors(list, mapper) {
  return (list || []).map((e) => {
    const loc = e.location || {};
    const mapped = mapper ? mapper(loc.line || 0, loc.column || 0) : { file: 'index.js', line: loc.line, column: loc.column };
    return { file: mapped.file, line: mapped.line, column: mapped.column, text: e.text, lineText: loc.lineText || '' };
  });
}

async function transform(code, mapper) {
  try {
    const out = await esbuild.transform(code, { loader: 'jsx', jsx: 'transform', target: 'es2020' });
    return { ok: true, code: out.code, warnings: fmtErrors(out.warnings, mapper) };
  } catch (e) {
    return { ok: false, errors: fmtErrors(e.errors, mapper) };
  }
}

// Mirrors the BP Compilation Service for V2: the JS is wrapped in an async function that
// exposes named params and returns the default-exported component.
async function compileV2(w) {
  const errors = [];
  const m = EXPORT_RE.exec(w.js);
  const tag = WIDGET_TAG_RE.exec(w.html);
  let name = m ? m[1] : null;
  let body = w.js;
  if (m) {
    body = w.js.replace(EXPORT_RE, (s) => s.replace(/export\s+default\s+[A-Z]\w+\s*;?/, ''));
  } else if (tag && new RegExp('\\b(const|let|var|function|class)\\s+' + tag[1] + '\\b').test(w.js)) {
    name = tag[1];
  } else {
    errors.push({
      file: 'index.js', line: 0, column: 0,
      text: 'No component export found. BP needs "export default <UppercaseName>;" (matching /^\\s*export\\s+default\\s+([A-Z]\\w+)\\s*[;\\n]/m) or a List-style `const Widget` referenced from index.html. The component will never mount.',
    });
    return { ok: false, errors };
  }
  if (/^\s*import\s/m.test(body)) {
    errors.push({ file: 'index.js', line: 0, column: 0, text: 'Could not resolve import: BP only exposes React, ReactDOM, BPUI, jQuery/$, moment, createReactClass and Payments as globals.' });
  }
  const prefix = 'async function __widget(' + WRAPPER_PARAMS.join(', ') + ') {\n';
  const wrapped = prefix + body + '\nreturn ' + name + ';\n}';
  const r = await transform(wrapped, (line, col) => ({ file: 'index.js', line: Math.max(1, line - 1), column: col }));
  if (!r.ok) return { ok: false, errors: errors.concat(r.errors) };
  return { ok: errors.length === 0, errors, warnings: r.warnings, mode: 'v2', component: name, code: r.code, css: w.css, params: WRAPPER_PARAMS };
}

// V1: Html holds a JSX body that is evaluated in the same scope as the JavaScript controller.
async function compileV1(w) {
  const jsLines = w.js.split('\n').length;
  const prefix = 'function __widget() {\n';
  const mid = '\n;return { render: function () { return (\n';
  const wrapped = prefix + w.js + mid + (w.html.trim() || '<span />') + '\n); } };\n}';
  const htmlStart = 1 + jsLines + 2;
  const r = await transform(wrapped, (line, col) => {
    if (line >= htmlStart) return { file: 'index.html', line: line - htmlStart + 1, column: col };
    return { file: 'index.js', line: Math.max(1, line - 1), column: col };
  });
  if (!r.ok) return { ok: false, errors: r.errors };
  return { ok: true, errors: [], warnings: r.warnings, mode: 'v1', code: r.code, css: w.css };
}

async function compile(w) {
  if (w.meta.version === 'v2') return compileV2(w);
  return compileV1(w);
}

module.exports = { compile, WRAPPER_PARAMS };
