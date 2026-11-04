/* Edit these before deploying. Gateways are not configured here: they are queried from the org (active gateways and
   their active profiles) and picked from a dropdown. currencyCode is only the fallback when a profile has no currency. */
const CONFIG = {
  environmentId: '',
  currencyCode: 'USD',
  /* Note field visibility: 'create-only', 'always' or 'never'. Booleans are deprecated and not supported here. */
  showNoteField: 'never',
  apiUrl: '',
  scriptUrl: 'https://cdn.aws.billingplatform.com/hosted-payments-ui@release/lib.js',
};

const NOTE_OPTIONS = ['create-only', 'always', 'never'];
const noteMode = (v) => (NOTE_OPTIONS.indexOf(v) >= 0 ? v : 'never');

const STORAGE_KEY = 'ccc_hpp.settings';
const readSaved = () => {
  try { return JSON.parse(window.localStorage.getItem(STORAGE_KEY)) || {}; } catch (e) { return {}; }
};
const writeSaved = (v) => {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch (e) { /* storage blocked: values just are not remembered */ }
};
const clearSaved = () => {
  try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nothing to clear */ }
};

/* Active gateway profiles, each joined to its gateway. Both the gateway and its profile must be ACTIVE. */
const GATEWAY_SQL = "SELECT p.Id, p.ProfileName, p.Currency, p.DefaultFlag, g.GATEWAY_NAME, g.GATEWAY_TYPE FROM PAYMENT_GATEWAY_PROFILE p JOIN PAYMENT_GATEWAY g ON g.Id = p.PaymentGatewayId WHERE UPPER(p.Status) = 'ACTIVE' AND UPPER(g.STATUS) = 'ACTIVE'";

/* Maps a gateway to the paymentGateways key HPP expects. Wallet gateways are typed ACH in BP, so go by name first. */
const methodOf = (name, type) => {
  const n = String(name || '').toLowerCase();
  if (n.indexOf('applepay') >= 0) return 'applePay';
  if (n.indexOf('googlepay') >= 0) return 'googlePay';
  if (n.indexOf('paypal') >= 0) return 'paypal';
  if (/_dd$|_ach$/.test(n)) return 'directDebit';
  if (/_cc$/.test(n)) return 'creditCard';
  return String(type || '').toUpperCase() === 'ACH' ? 'directDebit' : 'creditCard';
};

const buildGatewayOptions = (data) => {
  const rows = (data || []).map((r) => ({
    id: String(r.Id), profile: r.ProfileName, gateway: r.GATEWAY_NAME, method: methodOf(r.GATEWAY_NAME, r.GATEWAY_TYPE),
    currency: r.Currency || '', isDefault: String(r.DefaultFlag) === '1',
  })).sort((a, b) => (a.gateway + a.profile).localeCompare(b.gateway + b.profile));
  const options = rows.map((r) => ({
    key: 'p:' + r.id,
    label: r.gateway + ' / ' + r.profile + (r.isDefault ? ' (default)' : '') + (r.currency ? ' - ' + r.currency : ''),
    gateways: { [r.method]: { gateway: r.gateway, profile: r.profile } },
    currency: r.currency,
  }));
  const defaults = {};
  const defaultRows = rows.filter((r) => r.isDefault && !defaults[r.method] && (defaults[r.method] = { gateway: r.gateway, profile: r.profile }));
  if (defaultRows.length) {
    const currencies = defaultRows.map((r) => r.currency).filter((c, i, all) => c && all.indexOf(c) === i);
    options.unshift({
      key: 'defaults',
      label: 'All default gateways (' + defaultRows.map((r) => r.gateway).join(', ') + ')',
      gateways: defaults,
      currency: currencies.length === 1 ? currencies[0] : '',
    });
  }
  return options;
};

const CONTAINER_ID = 'ccc-hpp-container';

/* The token call must stay same-origin (BP itself, or the harness proxy); only the HPP library's own API calls use CONFIG.apiUrl. */
const tokenUrl = () => window.location.origin + '/' + BPSystem.organization + '/hostedPayments/1.0/authenticate-session';

const hppApiUrl = () => CONFIG.apiUrl || (window.location.origin + '/' + BPSystem.organization + '/hostedPayments/1.0');

let scriptPromise = null;
const loadHppScript = () => {
  if (window.HostedPayments) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CONFIG.scriptUrl;
      script.onload = () => resolve();
      script.onerror = () => { scriptPromise = null; reject(new Error('Could not load the HPP library from ' + CONFIG.scriptUrl)); };
      document.body.append(script);
    });
  }
  return scriptPromise;
};

const getHppSecurityToken = async () => {
  let response;
  try {
    response = await fetch(tokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', sessionid: BPSystem.sessionId },
      body: JSON.stringify({ sessionId: BPSystem.sessionId }),
    });
  } catch (e) {
    throw new Error('Token request to ' + tokenUrl() + ' failed (' + e.message + ')');
  }
  const data = await response.json().catch(() => ({}));
  const token = data && data.accessToken && data.accessToken.content;
  if (!response.ok || !token) throw new Error((data && data.message) || 'Could not get an HPP security token (HTTP ' + response.status + ')');
  return token;
};

const errorText = (e) => (e && (e.errorMessage || e.message)) || (typeof e === 'string' ? e : 'Payment failed');

const CccHpp = ({ _widgetProps }) => {
  const saved = React.useMemo(readSaved, []);
  const initialProfile = saved.profileId || BPUI.Tools.getNodeKey() || '';
  const [profileId, setProfileId] = React.useState(String(initialProfile));
  const [amount, setAmount] = React.useState('');
  const [gatewayKey, setGatewayKey] = React.useState(saved.gatewayKey || '');
  const [gateways, setGateways] = React.useState({ loading: true, options: [] });
  const [environmentId, setEnvironmentId] = React.useState(saved.environmentId || CONFIG.environmentId);
  const [currencyCode, setCurrencyCode] = React.useState(saved.currencyCode || CONFIG.currencyCode);
  const [showNote, setShowNote] = React.useState(noteMode(saved.showNoteField || CONFIG.showNoteField));
  const [request, setRequest] = React.useState(null);
  const [status, setStatus] = React.useState({ phase: 'idle' });

  React.useEffect(() => {
    writeSaved({ profileId, gatewayKey, environmentId, currencyCode, showNoteField: showNote });
  }, [profileId, gatewayKey, environmentId, currencyCode, showNote]);

  const resetSaved = () => {
    clearSaved();
    setGatewayKey(gateways.options.length ? gateways.options[0].key : '');
    setEnvironmentId(CONFIG.environmentId);
    setProfileId(String(BPUI.Tools.getNodeKey() || ''));
    setCurrencyCode(CONFIG.currencyCode);
    setShowNote(noteMode(CONFIG.showNoteField));
  };

  React.useEffect(() => {
    let active = true;
    BPUI.Tools.API.requestQuery(BPUI.Tools.API.trimQuery(GATEWAY_SQL), { on404: () => [] })
      .then((r) => {
        if (!active) return;
        const options = buildGatewayOptions(r && r.data);
        setGateways({ loading: false, options });
        setGatewayKey((cur) => (options.some((o) => o.key === cur) ? cur : (options.length ? options[0].key : '')));
      })
      .catch((e) => { if (active) setGateways({ loading: false, options: [], error: (e && e.message) || 'Could not load payment gateways' }); });
    return () => { active = false; };
  }, []);

  React.useEffect(() => {
    if (!request) return undefined;
    let active = true;
    const container = document.getElementById(CONTAINER_ID);
    const set = (s) => { if (active) setStatus(s); };
    container.innerHTML = '';
    set({ phase: 'loading' });
    (async () => {
      try {
        await loadHppScript();
        const securityToken = await getHppSecurityToken();
        if (!active) return;
        const sdk = HostedPayments.renderPaymentForm({
          securityToken,
          environmentId: request.environmentId,
          currencyCode: request.currencyCode,
          apiUrl: hppApiUrl(),
          billingProfileId: request.profileId,
          targetSelector: '#' + CONTAINER_ID,
          amount: request.amount,
          hideTitle: true,
          showNoteField: noteMode(request.showNoteField),
          errorPlacementStrategy: 'none',
          paymentGateways: request.gateways,
        }, {
          captureCompleted: (r) => set(r && r.isSuccess ? { phase: 'success', paymentId: r.paymentId, amount: r.amount } : { phase: 'error', message: errorText(r) }),
        });
        if (sdk && typeof sdk.subscribe === 'function') {
          sdk.subscribe(['error'], (s) => { if (s && s.error) set({ phase: 'error', message: errorText(s.error) }); });
        }
        set({ phase: 'ready' });
      } catch (e) {
        set({ phase: 'error', message: e.message });
      }
    })();
    return () => { active = false; container.innerHTML = ''; };
  }, [request]);

  const amountNum = Number(amount);
  const selected = gateways.options.find((o) => o.key === gatewayKey);
  const problem = !profileId.trim() ? 'Enter a Billing Profile Id.' : !(amountNum > 0) ? 'Enter an amount greater than 0.' : !selected ? 'No active payment gateway is selected.' : !environmentId.trim() ? 'Enter the Environment Id.' : '';

  const submit = (e) => {
    e.preventDefault();
    if (problem) { setStatus({ phase: 'error', message: problem }); return; }
    setRequest({ profileId: profileId.trim(), amount: amountNum, gateways: selected.gateways, environmentId: environmentId.trim(), currencyCode: selected.currency || currencyCode.trim() || 'USD', showNoteField: showNote, n: Date.now() });
  };

  const field = (label, value, set, extra) => (
    <label className="hpp-field">
      <span className="hpp-label">{label}</span>
      <input className="hpp-input" value={value} onChange={(e) => set(e.target.value)} {...(extra || {})} />
    </label>
  );

  return (
    <div className="hpp-card">
      <h3 className="hpp-title">Make a payment</h3>
      <form className="hpp-form" onSubmit={submit}>
        {field('Billing Profile Id', profileId, setProfileId, { placeholder: 'e.g. 1001' })}
        {field('Amount', amount, setAmount, { placeholder: '0.00', inputMode: 'decimal' })}
        <label className="hpp-field">
          <span className="hpp-label">Payment gateway</span>
          <select className="hpp-input" value={gatewayKey} disabled={gateways.loading || !gateways.options.length} onChange={(e) => setGatewayKey(e.target.value)}>
            {gateways.loading && <option value="">Loading gateways...</option>}
            {!gateways.loading && !gateways.options.length && <option value="">No active gateways</option>}
            {gateways.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        {gateways.error && <div className="hpp-error">{gateways.error}</div>}
        <details className="hpp-settings">
          <summary>HPP settings</summary>
          {field('Environment Id', environmentId, setEnvironmentId)}
          {field('Fallback currency (used when the gateway profile has none)', currencyCode, setCurrencyCode)}
          <label className="hpp-field">
            <span className="hpp-label">Note field</span>
            <select className="hpp-input" value={showNote} onChange={(e) => setShowNote(e.target.value)}>
              {NOTE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <button type="button" className="hpp-link" onClick={resetSaved}>Reset to defaults</button>
        </details>
        <button type="submit" className="hpp-btn" disabled={status.phase === 'loading'}>{request ? 'Reload payment form' : 'Load payment form'}</button>
      </form>
      {status.phase === 'loading' && <div className="hpp-muted">Loading payment form...</div>}
      {status.phase === 'error' && <div className="hpp-error">{status.message}</div>}
      {status.phase === 'success' && <div className="hpp-success">Payment captured{status.paymentId ? ' (payment ' + status.paymentId + ')' : ''}.</div>}
      <div id={CONTAINER_ID} className="hpp-container" />
    </div>
  );
};

export default CccHpp;
