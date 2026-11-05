// Holds the (single) BP connection and forwards REST calls. The session lives only in server memory.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'harness.config.json'), 'utf8')); } catch (e) { /* optional */ }
  return {
    baseUrl: process.env.BP_BASE_URL || cfg.baseUrl || '',
    username: process.env.BP_USERNAME || cfg.username || '',
    password: process.env.BP_PASSWORD || '',
    authType: cfg.authType || 'password',
  };
}

const state = {
  connected: false,
  baseUrl: '',
  authType: '',
  username: '',
  sessionId: '',
  bearer: '',
  readOnlySession: false,
  writes: false,
  connectedAt: null,
};

function normalizeBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/rest\/2\.0$/i, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function host() {
  try { return new URL(state.baseUrl).host; } catch (e) { return ''; }
}

function publicState() {
  return {
    connected: state.connected,
    baseUrl: state.baseUrl,
    host: host(),
    authType: state.authType,
    username: state.username,
    writes: state.writes,
    readOnlySession: state.readOnlySession,
    connectedAt: state.connectedAt,
  };
}

function authHeaders() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (state.bearer) h.Authorization = 'Bearer ' + state.bearer;
  else if (state.sessionId) h.sessionId = state.sessionId;
  return h;
}

async function connect(opts) {
  const baseUrl = normalizeBase(opts.baseUrl);
  if (!opts.baseUrl) throw new Error('Base URL is required (e.g. https://acme.billingplatform.com/acme_org)');
  const next = { connected: false, baseUrl, authType: opts.authType, username: opts.username || '', sessionId: '', bearer: '', readOnlySession: false, writes: false, connectedAt: null };

  if (opts.authType === 'session') {
    if (!opts.sessionId) throw new Error('Session Id is required');
    next.sessionId = String(opts.sessionId).trim();
  } else if (opts.authType === 'bearer') {
    if (!opts.token) throw new Error('Access token is required');
    next.bearer = String(opts.token).trim();
  } else {
    if (!opts.username || !opts.password) throw new Error('Username and password are required');
    const res = await fetch(baseUrl + '/rest/2.0/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: opts.username, password: opts.password }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Login returned non-JSON (HTTP ' + res.status + '). Check the base URL includes the org path.'); }
    const lr = Array.isArray(data.loginResponse) ? data.loginResponse[0] : data.loginResponse;
    const sid = lr && (lr.SessionId || lr.sessionId);
    const ro = lr && (lr.RO_SessionId || lr.roSessionId);
    if (!sid && !ro) throw new Error('Login failed: ' + (lr && (lr.ErrorText || lr.Message) || data.ErrorText || text.slice(0, 200)));
    next.sessionId = sid || ro;
    next.readOnlySession = !sid && !!ro;
  }

  Object.assign(state, next, { connected: true, connectedAt: new Date().toISOString() });

  // Cheap probe so a bad session fails here rather than inside a widget.
  const probe = await forward('GET', 'query?sql=' + encodeURIComponent('select Id from ACCOUNT where rownum < 2'));
  if (probe.status === 401 || probe.status === 403) {
    state.connected = false;
    throw new Error('BP rejected the session (HTTP ' + probe.status + ')');
  }
  return publicState();
}

function disconnect() {
  Object.assign(state, { connected: false, sessionId: '', bearer: '', writes: false, connectedAt: null, readOnlySession: false });
  return publicState();
}

function setWrites(enabled) {
  if (!state.connected) throw new Error('Not connected');
  if (enabled && state.readOnlySession) throw new Error('This is a read-only session (RO_SessionId)');
  state.writes = !!enabled;
  return publicState();
}

// restPath is everything after /rest/2.0/ (including the query string)
async function forward(method, restPath, body) {
  if (!state.connected) return { status: 503, body: JSON.stringify({ ErrorCode: 'HARNESS_NOT_CONNECTED', ErrorText: 'Harness is not connected to a BP instance' }), contentType: 'application/json' };
  const isRead = method === 'GET' || method === 'HEAD';
  if (!isRead && !state.writes) {
    return {
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ ErrorCode: 'HARNESS_READ_ONLY', ErrorText: 'Blocked by harness: ' + method + ' ' + restPath.split('?')[0] + '. Writes are disabled; enable them in the Connection panel to allow changes to ' + host() + '.' }),
    };
  }
  const res = await fetch(state.baseUrl + '/rest/2.0/' + restPath.replace(/^\/+/, ''), {
    method,
    headers: authHeaders(),
    body: isRead || body == null || body === '' ? undefined : body,
  });
  const text = await res.text();
  return { status: res.status, body: text, contentType: res.headers.get('content-type') || 'application/json' };
}

// Mints an HPP security token for the current session (POST {org}/hostedPayments/1.0/authenticate-session).
// Not a data write, so it bypasses the read-only guard in forward(). Needs a session id (not a bearer token).
async function authenticateSession() {
  if (!state.connected) return { status: 503, body: JSON.stringify({ message: 'Harness is not connected to a BP instance (use Live BP mode)' }), contentType: 'application/json' };
  if (!state.sessionId) return { status: 400, body: JSON.stringify({ message: 'authenticate-session needs a session id; connect with username/password or a Session Id, not an OAuth bearer token' }), contentType: 'application/json' };
  const res = await fetch(state.baseUrl + '/hostedPayments/1.0/authenticate-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', sessionid: state.sessionId },
    body: JSON.stringify({ sessionId: state.sessionId }),
  });
  return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') || 'application/json' };
}

// Generic pass-through for the HPP library's own calls ({org}/hostedPayments/1.0/*). Auth comes from the headers the
// library sends (Bearer token, environmentId). Anything but a GET can move money, so it honors the writes switch.
const SKIP_REQ = new Set(['host', 'origin', 'referer', 'cookie', 'content-length', 'connection', 'accept-encoding', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest']);
async function forwardHpp(method, subPath, headers, body) {
  if (!state.connected) return { status: 503, body: JSON.stringify({ message: 'Harness is not connected to a BP instance (use Live BP mode)' }), contentType: 'application/json' };
  const isRead = method === 'GET' || method === 'HEAD';
  if (!isRead && !state.writes) {
    return { status: 403, contentType: 'application/json', body: JSON.stringify({ ErrorCode: 'HARNESS_READ_ONLY', message: 'Blocked by harness: ' + method + ' hostedPayments/1.0/' + subPath.split('?')[0] + '. Enable writes in the Connection panel (sandbox only) to let the payment form post to ' + host() + '.' }) };
  }
  const fwd = {};
  for (const [k, v] of Object.entries(headers)) if (!SKIP_REQ.has(k.toLowerCase())) fwd[k] = v;
  const res = await fetch(state.baseUrl + '/hostedPayments/1.0/' + subPath.replace(/^\/+/, ''), { method, headers: fwd, body: isRead || !body ? undefined : body });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'application/json' };
}

function json(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function errorOf(data) {
  if (!data) return 'non-JSON response';
  for (const key of Object.keys(data)) {
    const v = Array.isArray(data[key]) ? data[key][0] : data[key];
    if (v && typeof v === 'object' && v.ErrorCode && String(v.ErrorCode) !== '0') return v.ErrorCode + ': ' + (v.ErrorText || '');
  }
  if (data.ErrorCode && String(data.ErrorCode) !== '0') return data.ErrorCode + ': ' + (data.ErrorText || '');
  return '';
}

function firstRow(data) {
  if (!data) return null;
  const k = Object.keys(data).find((x) => Array.isArray(data[x]));
  return k ? data[k][0] : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pushes widget source to the WIDGET entity and waits for the Compilation Service.
async function deploy(w, compiled, opts, onStep) {
  const step = onStep || (() => {});
  const token = w.meta.token;
  const html = w.meta.version === 'v2' ? (/\{\s*\.\.\._widgetProps\s*\}/.test(w.html) ? '' : w.html) : w.html;
  const make = (enc) => {
    const f = enc ? (s) => Buffer.from(s, 'utf8').toString('base64') : (s) => s;
    return { Html: f(html), JavaScript: f(w.js), Css: f(w.css) };
  };

  step('Looking up WIDGET ' + token);
  const found = await forward('GET', 'WIDGET?queryAnsiSql=' + encodeURIComponent("Token = '" + token + "'"));
  const foundData = json(found.body);
  let existing = found.status === 404 ? null : firstRow(foundData);
  if (existing && !existing.Id) existing = null;
  if (found.status >= 400 && found.status !== 404) throw new Error('Lookup failed: HTTP ' + found.status + ' ' + found.body.slice(0, 200));

  async function write(enc) {
    const src = make(enc);
    if (existing) {
      step('Updating WIDGET ' + existing.Id + (enc ? ' (base64)' : ''));
      const body = Object.assign({ Id: existing.Id, CompilationStatus: 'PENDING' }, src);
      if (opts.enable != null) body.EnabledFlag = opts.enable ? 1 : 0;
      return forward('PUT', 'WIDGET', JSON.stringify({ brmObjects: [body] }));
    }
    step('Creating WIDGET ' + token + (enc ? ' (base64)' : ''));
    const body = Object.assign({ Token: token, WidgetKind: w.meta.kind, CompilationStatus: 'PENDING', EnabledFlag: opts.enable ? 1 : 0 }, src);
    return forward('POST', 'WIDGET', JSON.stringify({ brmObjects: [body] }));
  }

  let res = await write(false);
  let data = json(res.body);
  let err = res.status >= 400 ? 'HTTP ' + res.status : errorOf(data);
  if (err && /base64|BAD_TRANSACTION_STATUS/i.test(err + res.body)) {
    step('Plaintext rejected (' + err.slice(0, 80) + '), retrying base64');
    res = await write(true);
    data = json(res.body);
    err = res.status >= 400 ? 'HTTP ' + res.status : errorOf(data);
  }
  if (err) throw new Error('Save failed: ' + err + ' ' + (res.body || '').slice(0, 300));

  const row = firstRow(data) || {};
  const id = (existing && existing.Id) || row.Id;
  if (!id) throw new Error('Save returned no Id: ' + res.body.slice(0, 300));
  step('Saved as WIDGET ' + id + '. Waiting for compile (HTTP 200 only means the source was stored)');

  /* BP compiles asynchronously and can take a few minutes: poll for up to 4 minutes, but only log when the status changes
     or every 15 seconds, so a long wait does not become a wall of identical lines. */
  const POLL_MS = 3000;
  const MAX_POLLS = 80;
  let last = {};
  let shown = '';
  let finished = false;
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);
    const r = await forward('GET', 'WIDGET/' + encodeURIComponent(id));
    last = firstRow(json(r.body)) || {};
    const st = last.CompilationStatus || '?';
    if (st !== shown) { step('CompilationStatus = ' + st); shown = st; } else if ((i + 1) % 5 === 0) step('Still ' + st + ' after ' + Math.round(((i + 1) * POLL_MS) / 1000) + 's');
    if (st === 'PROCESSED' || st === 'ERROR') { finished = true; break; }
  }
  if (!finished) step('Stopped waiting after ' + Math.round((MAX_POLLS * POLL_MS) / 1000) + 's. BP may still be compiling: use Check status.');
  let errorMessage = '';
  if (last.ErrorMessage) {
    try { errorMessage = Buffer.from(String(last.ErrorMessage), 'base64').toString('utf8'); } catch (e) { errorMessage = String(last.ErrorMessage); }
  }
  return {
    id, token,
    status: last.CompilationStatus || 'UNKNOWN',
    version: last.Version || '',
    enabled: last.EnabledFlag,
    errorMessage,
    finished,
  };
}

// Reads the current compile state of a widget by token, without changing anything.
async function widgetStatus(token) {
  const found = await forward('GET', 'WIDGET?queryAnsiSql=' + encodeURIComponent("Token = '" + String(token).replace(/'/g, "''") + "'"));
  const row = found.status === 404 ? null : firstRow(json(found.body));
  if (!row || !row.Id) return { found: false };
  const r = await forward('GET', 'WIDGET/' + encodeURIComponent(row.Id));
  const last = firstRow(json(r.body)) || {};
  let errorMessage = '';
  if (last.ErrorMessage) {
    try { errorMessage = Buffer.from(String(last.ErrorMessage), 'base64').toString('utf8'); } catch (e) { errorMessage = String(last.ErrorMessage); }
  }
  return { found: true, id: row.Id, token, status: last.CompilationStatus || 'UNKNOWN', version: last.Version || '', enabled: last.EnabledFlag, errorMessage, finished: last.CompilationStatus === 'PROCESSED' || last.CompilationStatus === 'ERROR' };
}

module.exports = { loadConfig, connect, disconnect, setWrites, forward, authenticateSession, forwardHpp, widgetStatus, deploy, publicState, host, state };
