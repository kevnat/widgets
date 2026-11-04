const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const widgets = require('./lib/widgets');
const { compile } = require('./lib/compile');
const { lint } = require('./lib/lint');
const bp = require('./lib/bp');

const PORT = Number(process.env.PORT || 5179);
const HOST = '127.0.0.1';
const ROOT = __dirname;

const VENDOR = {
  '/vendor/react.js': 'node_modules/react/umd/react.development.js',
  '/vendor/react-dom.js': 'node_modules/react-dom/umd/react-dom.development.js',
  '/vendor/jquery.js': 'node_modules/jquery/dist/jquery.min.js',
  '/vendor/moment.js': 'node_modules/moment/min/moment.min.js',
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

const sseClients = new Set();

function send(res, status, body, type) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': type || (isObj ? 'application/json' : 'text/plain; charset=utf-8'), 'Cache-Control': 'no-store' });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

// The server holds a live BP session, so only the local browser may talk to it.
// The HPP library runs in an iframe from this CDN origin and calls the hostedPayments proxy directly, so that one
// origin is allowed on those routes (never on authenticate-session, which uses the stored session).
const HPP_ORIGIN = 'https://cdn.aws.billingplatform.com';
const HPP_ROUTE = /^\/[^/]+\/hostedPayments\/1\.0\/(.+)$/;
function isHppCdnCall(req, p) {
  const m = HPP_ROUTE.exec(p);
  return !!m && req.headers.origin === HPP_ORIGIN && m[1] !== 'authenticate-session';
}
function hppCorsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': HPP_ORIGIN,
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function guard(req, allowOrigin) {
  const hostHeader = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostHeader)) return 'Bad Host header';
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && !allowOrigin) {
    try {
      if (new URL(origin).host !== req.headers.host) return 'Cross-origin request blocked';
    } catch (e) { return 'Bad Origin'; }
  }
  return null;
}

function payload(name) {
  const w = widgets.load(name);
  if (!w) return null;
  return w;
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/widgets' && req.method === 'GET') return send(res, 200, widgets.summaries());

  let m = /^\/api\/widget\/([^/]+)$/.exec(p);
  if (m && req.method === 'GET') {
    const w = payload(decodeURIComponent(m[1]));
    if (!w) return send(res, 404, { error: 'No such widget' });
    const compiled = await compile(w);
    return send(res, 200, {
      name: w.name, meta: w.meta, fixtures: w.fixtures,
      source: { html: w.html, js: w.js, css: w.css },
      compiled, lint: lint(w),
    });
  }

  if (p === '/api/conn' && req.method === 'GET') {
    const cfg = bp.loadConfig();
    return send(res, 200, Object.assign(bp.publicState(), { defaults: { baseUrl: cfg.baseUrl, username: cfg.username, authType: cfg.authType, hasEnvPassword: !!cfg.password } }));
  }
  if (p === '/api/conn' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const cfg = bp.loadConfig();
    if (!body.password && body.authType === 'password' && cfg.password) body.password = cfg.password;
    try { return send(res, 200, await bp.connect(body)); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/conn' && req.method === 'DELETE') return send(res, 200, bp.disconnect());
  if (p === '/api/conn/writes' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    try { return send(res, 200, bp.setWrites(body.enabled)); } catch (e) { return send(res, 400, { error: e.message }); }
  }

  m = /^\/api\/deploy\/([^/]+)$/.exec(p);
  if (m && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const w = payload(decodeURIComponent(m[1]));
    if (!w) return send(res, 404, { error: 'No such widget' });
    const st = bp.publicState();
    if (!st.connected) return send(res, 400, { error: 'Not connected to a BP instance' });
    if (!st.writes) return send(res, 403, { error: 'Writes are disabled. Enable them in the Connection panel first.' });
    if (body.confirm !== st.host) return send(res, 400, { error: 'Confirmation must equal the target host (' + st.host + ')' });
    const errors = lint(w).filter((l) => l.severity === 'error');
    if (errors.length && !body.force) return send(res, 422, { error: 'Lint errors block deploy', lint: errors });
    const compiled = await compile(w);
    if (!compiled.ok) return send(res, 422, { error: 'Local compile failed', compiled });
    const steps = [];
    try {
      const result = await bp.deploy(w, compiled, { enable: body.enable }, (s) => steps.push(s));
      return send(res, 200, { steps, result });
    } catch (e) {
      return send(res, 502, { steps, error: e.message });
    }
  }

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  return send(res, 404, { error: 'Unknown API route' });
}

async function handleProxy(req, res, url) {
  const restPath = url.pathname.replace(/^\/bp\//, '') + url.search;
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  try {
    const r = await bp.forward(req.method, restPath, body);
    res.writeHead(r.status, { 'Content-Type': r.contentType, 'Cache-Control': 'no-store' });
    res.end(r.body);
  } catch (e) {
    send(res, 502, { ErrorCode: 'HARNESS_PROXY_ERROR', ErrorText: e.message });
  }
}

async function handleHpp(req, res, url, rest, cors) {
  try {
    let r;
    if (rest === 'authenticate-session' && req.method === 'POST') r = await bp.authenticateSession();
    else r = await bp.forwardHpp(req.method, rest + url.search, req.headers, ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req));
    res.writeHead(r.status, Object.assign({ 'Content-Type': r.contentType, 'Cache-Control': 'no-store' }, cors));
    res.end(r.body);
  } catch (e) {
    res.writeHead(502, Object.assign({ 'Content-Type': 'application/json' }, cors));
    res.end(JSON.stringify({ message: e.message }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const cdnCall = isHppCdnCall(req, p);
  const bad = guard(req, cdnCall);
  if (bad) return send(res, 403, bad);
  if (cdnCall && req.method === 'OPTIONS') { res.writeHead(204, hppCorsHeaders(req)); return res.end(); }
  try {
    if (p.startsWith('/api/')) return await handleApi(req, res, url);
    if (p.startsWith('/bp/')) return await handleProxy(req, res, url);
    const hpp = HPP_ROUTE.exec(p);
    if (hpp) return await handleHpp(req, res, url, hpp[1], cdnCall ? hppCorsHeaders(req) : undefined);
    if (VENDOR[p]) return serveFile(res, path.join(ROOT, VENDOR[p]));
    if (p === '/' ) return serveFile(res, path.join(ROOT, 'ui/index.html'));
    if (p === '/preview') return serveFile(res, path.join(ROOT, 'ui/preview.html'));
    if (p.startsWith('/ui/') || p.startsWith('/runtime/')) {
      const file = path.normalize(path.join(ROOT, p));
      if (!file.startsWith(path.join(ROOT, 'ui')) && !file.startsWith(path.join(ROOT, 'runtime'))) return send(res, 403, 'Forbidden');
      return serveFile(res, file);
    }
    return send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

let timer = null;
function broadcast(kind, name) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    for (const c of sseClients) c.write('data: ' + JSON.stringify({ kind, name }) + '\n\n');
  }, 120);
}

function startWatching() {
  const seen = new Set();
  for (const dir of widgets.watchDirs()) {
    if (seen.has(dir) || !fs.existsSync(dir)) continue;
    seen.add(dir);
    try {
      fs.watch(dir, { recursive: true }, (evt, file) => {
        if (!file) return;
        const rel = path.relative(widgets.ROOT, path.join(dir, file)).split(path.sep);
        const name = rel[0] === 'widgets' ? rel[1] : rel[0];
        broadcast(rel.length <= 2 && rel[0] === 'widgets' ? 'list' : 'widget', name);
      });
    } catch (e) { console.warn('watch failed for', dir, e.message); }
  }
  // runtime / ui edits reload everything (harness development)
  for (const dir of ['runtime', 'ui']) {
    try { fs.watch(path.join(ROOT, dir), () => broadcast('all', '')); } catch (e) { /* ignore */ }
  }
}

server.listen(PORT, HOST, () => {
  console.log('\n  BP Widget Harness  http://localhost:' + PORT);
  console.log('  Widgets: ' + (widgets.discover().join(', ') || '(none yet - add a folder under widgets/)') + '\n');
  startWatching();
});
