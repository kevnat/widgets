const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', 'docs', 'lib', 'runtime', 'ui', 'dist', '.claude', '.git']);

function readIf(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

function readJson(file) {
  const raw = readIf(file);
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch (e) { return { __error: e.message }; }
}

function isWidgetDir(dir) {
  return fs.existsSync(path.join(dir, 'index.js')) || fs.existsSync(path.join(dir, 'index.html'));
}

function listDirs(base) {
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name))
      .map((d) => path.join(base, d.name));
  } catch (e) { return []; }
}

// widgets/<TOKEN>/ plus any root-level folder that holds an index.js/index.html
function discover() {
  const dirs = [...listDirs(path.join(ROOT, 'widgets')), ...listDirs(ROOT).filter((d) => path.basename(d) !== 'widgets')];
  return dirs.filter(isWidgetDir).map((dir) => path.basename(dir));
}

function dirFor(name) {
  const candidates = [path.join(ROOT, 'widgets', name), path.join(ROOT, name)];
  return candidates.find((d) => isWidgetDir(d));
}

function inferVersion(html, js) {
  if (/<BPUI\.(Page|Extension)\b/.test(html)) return 'v1';
  if (/export\s+default\s+[A-Z]/.test(js) || /\{\s*\.\.\._widgetProps\s*\}/.test(html) || !html.trim()) return 'v2';
  return 'v1';
}

function inferKind(html, js, version) {
  if (/<BPUI\.Page\b/.test(html)) return 'PAGE';
  if (/<BPUI\.Extension\b/.test(html)) return 'EXTENSION';
  if (version === 'v2' && /\bconst\s+Widget\s*=\s*(function|\()/.test(js) && !/export\s+default/.test(js)) return 'LIST';
  return 'EXTENSION';
}

function load(name) {
  const dir = dirFor(name);
  if (!dir) return null;
  const html = readIf(path.join(dir, 'index.html'));
  const js = readIf(path.join(dir, 'index.js'));
  const css = readIf(path.join(dir, 'style.css'));
  const cfg = readJson(path.join(dir, 'widget.json')) || {};
  const fixtures = readJson(path.join(dir, 'fixtures.json')) || {};
  const version = cfg.version || inferVersion(html, js);
  const kind = (cfg.kind || inferKind(html, js, version)).toUpperCase();
  return {
    name,
    dir,
    html, js, css,
    fixtures,
    meta: {
      token: cfg.token || name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
      version,
      kind,
      entity: cfg.entity || (fixtures.context && fixtures.context.entity) || '',
      inputParameters: cfg.inputParameters || [],
      interactive: !!cfg.interactive,
      description: cfg.description || '',
    },
  };
}

function summaries() {
  return discover().map((name) => {
    const w = load(name);
    return {
      name,
      token: w.meta.token,
      version: w.meta.version,
      kind: w.meta.kind,
      entity: w.meta.entity,
      description: w.meta.description,
      hasFixtures: Object.keys(w.fixtures).length > 0,
    };
  });
}

function watchDirs() {
  return [path.join(ROOT, 'widgets'), ...listDirs(ROOT).filter((d) => isWidgetDir(d))];
}

module.exports = { ROOT, discover, dirFor, load, summaries, watchDirs };
