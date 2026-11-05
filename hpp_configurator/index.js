/* Edit these before deploying. Gateways are not configured here: they are queried from the org (active gateways and
   their active profiles) and picked from a dropdown. currencyCode is only the fallback when a profile has no currency. */
const CONFIG = {
  environmentId: '',
  currencyCode: 'USD',
  /* Initial payment amount. */
  defaultAmount: 100,
  /* Note field visibility: 'create-only', 'always' or 'never'. Booleans are deprecated and not supported here. */
  showNoteField: 'never',
  apiUrl: '',
  scriptUrl: 'https://cdn.aws.billingplatform.com/hosted-payments-ui@release/lib.js',
};

const NOTE_OPTIONS = ['create-only', 'always', 'never'];
const noteMode = (v) => (NOTE_OPTIONS.indexOf(v) >= 0 ? v : 'never');

const STORAGE_KEY = 'hpp_configurator.settings';
const LEGACY_STORAGE_KEY = 'ccc_hpp.settings';
const readSaved = () => {
  /* Falls back to the settings saved under the widget's previous name (ccc_hpp) so a rename does not reset them. */
  try { return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || window.localStorage.getItem(LEGACY_STORAGE_KEY)) || {}; } catch (e) { return {}; }
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

/* Styling panel. Variables come from the HPP "CSS Variables" docs; defaults are only shown as hints, a variable is
   emitted into customStyles only once the user changes it. Entries with several vars set them all to one value. */
const COLOR_CONTROLS = [
  { vars: ['--pui-button-enabled'], label: 'Button', def: '#4dbdff' },
  { vars: ['--pui-button-enabled-hover'], label: 'Button hover', def: '#45b2f3' },
  { vars: ['--pui-button-enabled-active'], label: 'Button pressed', def: '#3da7e6' },
  { vars: ['--pui-button-color'], label: 'Button text', def: '#ffffff' },
  { vars: ['--pui-button-enabled-success'], label: 'Success button', def: '#5cd755' },
  { vars: ['--pui-main-text'], label: 'Text', def: '#000000' },
  { vars: ['--pui-titles'], label: 'Titles', def: '#000000' },
  { vars: ['--pui-label-color'], label: 'Field labels', def: '#000000' },
  { vars: ['--pui-general-form-background'], label: 'Form background', def: '#f7f7f7' },
  { vars: ['--pui-input-borders'], label: 'Input border', def: '#d3dbe4' },
  { vars: ['--pui-selected-input-border', '--pui-selected-input-outline', '--pui-selected-item-border'], label: 'Focus / selected', def: '#219fef' },
  { vars: ['--pui-error-message', '--pui-error-border'], label: 'Error', def: '#ff0000' },
  { vars: ['--pui-checkbox-background-color'], label: 'Checkbox', def: '#219fef' },
];
const SIZE_CONTROLS = [
  { vars: ['--pui-inputs-border-radius'], label: 'Input radius', unit: 'px', def: 0, min: 0, max: 30, step: 1 },
  { vars: ['--pui-button-border-radius'], label: 'Button radius', unit: 'px', def: 3, min: 0, max: 30, step: 1 },
  { vars: ['--pui-payment-method-border-radius'], label: 'Payment method radius', unit: 'px', def: 0, min: 0, max: 30, step: 1 },
  { vars: ['--pui-input-height'], label: 'Input height', unit: 'rem', def: 2.2, min: 1, max: 5, step: 0.1 },
  { vars: ['--pui-button-height'], label: 'Button height', unit: 'rem', def: 2.2, min: 1, max: 5, step: 0.1 },
  { vars: ['--pui-input-font-size'], label: 'Input font size', unit: 'rem', def: 0.85, min: 0.5, max: 2, step: 0.05 },
  { vars: ['--pui-label-font-size'], label: 'Label font size', unit: 'rem', def: 0.75, min: 0.5, max: 2, step: 0.05 },
  { vars: ['--pui-form-row-gap'], label: 'Row spacing', unit: 'rem', def: 0.6, min: 0, max: 3, step: 0.1 },
];
const DEFAULT_STYLE = { vars: {}, fontFamily: '', fontGoogle: true, hideTitle: true, titleLabel: '', payLabel: '', scaleRatio: '', containerWidth: '', maxContainerWidth: '', customCss: '', cssLink: '' };

/* Turns the style state into the renderPaymentForm options it represents (only non-default values). */
const buildStyleProps = (st) => {
  const props = {};
  if (st.hideTitle) props.hideTitle = true;
  const labels = {};
  if (st.titleLabel.trim()) labels.title = st.titleLabel.trim();
  if (st.payLabel.trim()) labels.payButton = st.payLabel.trim();
  if (Object.keys(labels).length) props.labels = labels;
  const font = st.fontFamily.replace(/['"`;{}\\<>]/g, '').trim();
  const fontEntry = font ? [
    st.fontGoogle ? "@import url('https://fonts.googleapis.com/css2?family=" + encodeURIComponent(font).replace(/%20/g, '+') + ":wght@400;500;600&display=swap');" : '',
    "* { font-family: '" + font + "', sans-serif !important; }",
    ":root { --pui-payment-method-slot-button-font-family: '" + font + "', sans-serif; }",
  ].filter(Boolean).join('\n') : '';
  const decls = Object.keys(st.vars).map((k) => '  ' + k + ': ' + st.vars[k] + ';');
  const customStyles = [];
  if (fontEntry) customStyles.push({ type: 'plain', value: fontEntry });
  if (decls.length) customStyles.push({ type: 'plain', value: ':root {\n' + decls.join('\n') + '\n}' });
  if (st.customCss.trim()) customStyles.push({ type: 'plain', value: st.customCss.trim() });
  if (st.cssLink.trim()) customStyles.push({ type: 'link', value: st.cssLink.trim() });
  if (customStyles.length) props.customStyles = customStyles;
  const ratio = Number(st.scaleRatio);
  if (st.scaleRatio !== '' && ratio >= 0.5 && ratio <= 2) props.scaleRatio = ratio;
  if (st.containerWidth.trim()) props.containerWidth = st.containerWidth.trim();
  if (st.maxContainerWidth.trim()) props.maxContainerWidth = st.maxContainerWidth.trim();
  return props;
};

/* Minimal JS-literal serializer so the exported code reads like hand-written code (unquoted keys, template literals for CSS). */
const RAW = (code) => ({ raw: code });
const jsString = (v) => (v.indexOf('\n') >= 0
  ? '`' + v.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`'
  : "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
const toJs = (v, depth) => {
  const pad = '  '.repeat(depth);
  if (v && v.raw !== undefined) return v.raw;
  if (typeof v === 'string') return jsString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.length ? '[\n' + v.map((x) => pad + '  ' + toJs(x, depth + 1)).join(',\n') + ',\n' + pad + ']' : '[]';
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  return '{\n' + keys.map((k) => pad + '  ' + (/^[A-Za-z_$][\w$]*$/.test(k) ? k : "'" + k + "'") + ': ' + toJs(v[k], depth + 1)).join(',\n') + ',\n' + pad + '}';
};

const copyText = async (text) => {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back below: iframes often lack clipboard permission */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
};

const downloadText = (name, text) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
};

/* Account search. BillableBillingProfileId is the profile the account is billed through (its own, or its parent's). */
const sqlText = (v) => String(v).replace(/'/g, "''").replace(/[\r\n]+/g, ' ').slice(0, 60);
const accountSql = (term) => {
  const t = sqlText(term.trim());
  return "SELECT a.Id, a.Name, a.BillableBillingProfileId, bp.CurrencyCode, bp.Status AS BpStatus FROM ACCOUNT a LEFT JOIN BILLING_PROFILE bp ON bp.Id = a.BillableBillingProfileId WHERE UPPER(a.Status) = 'ACTIVE' AND (UPPER(a.Name) LIKE UPPER('%" + t + "%') OR TO_CHAR(a.Id) = '" + t + "') AND ROWNUM <= 25";
};
const toAccount = (r) => ({
  id: String(r.Id), name: r.Name, bpId: r.BillableBillingProfileId ? String(r.BillableBillingProfileId) : '', currency: r.CurrencyCode || '',
  usable: !!r.BillableBillingProfileId && (!r.BpStatus || String(r.BpStatus).toUpperCase() === 'ACTIVE'),
});

const CONTAINER_ID = 'hpp-configurator-container';

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

/* The access token is a JWT whose claims include environmentId; read it from there instead of asking the user. */
const tokenClaims = (token) => {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)));
  } catch (e) { return {}; }
};

const errorText = (e) => (e && (e.errorMessage || e.message)) || (typeof e === 'string' ? e : 'Payment failed');

const HppConfigurator = ({ _widgetProps }) => {
  const saved = React.useMemo(readSaved, []);
  const initialProfile = saved.profileId || BPUI.Tools.getNodeKey() || '';
  const [profileId, setProfileId] = React.useState(String(initialProfile));
  const [account, setAccount] = React.useState(saved.account || null);
  const [acctQuery, setAcctQuery] = React.useState(saved.account ? saved.account.name : '');
  const [acctState, setAcctState] = React.useState({ loading: false, results: [], open: false, error: '' });
  const [amount, setAmount] = React.useState(String(CONFIG.defaultAmount));
  const [gatewayKey, setGatewayKey] = React.useState(saved.gatewayKey || '');
  const [gateways, setGateways] = React.useState({ loading: true, options: [] });
  const [environmentId, setEnvironmentId] = React.useState(saved.environmentId || CONFIG.environmentId);
  const [envAuto, setEnvAuto] = React.useState('');
  const [currencyCode, setCurrencyCode] = React.useState(saved.currencyCode || CONFIG.currencyCode);
  const [showNote, setShowNote] = React.useState(noteMode(saved.showNoteField || CONFIG.showNoteField));
  const [style, setStyle] = React.useState(Object.assign({}, DEFAULT_STYLE, saved.style, { vars: Object.assign({}, saved.style && saved.style.vars) }));
  const [autoApply, setAutoApply] = React.useState(saved.autoApply !== false);
  const [styleOpen, setStyleOpen] = React.useState(saved.styleOpen !== false);
  const [exportTab, setExportTab] = React.useState('style');
  const [copied, setCopied] = React.useState('');
  const [request, setRequest] = React.useState(null);
  const [status, setStatus] = React.useState({ phase: 'idle' });

  React.useEffect(() => {
    writeSaved({ profileId, account, gatewayKey, environmentId, currencyCode, showNoteField: showNote, style, autoApply, styleOpen });
  }, [profileId, account, gatewayKey, environmentId, currencyCode, showNote, style, autoApply, styleOpen]);

  const resetSaved = () => {
    clearSaved();
    setGatewayKey(gateways.options.length ? gateways.options[0].key : '');
    setEnvironmentId(CONFIG.environmentId);
    setProfileId(String(BPUI.Tools.getNodeKey() || ''));
    setAccount(null);
    setAcctQuery('');
    setCurrencyCode(CONFIG.currencyCode);
    setShowNote(noteMode(CONFIG.showNoteField));
  };

  /* On visit, mint a token once just to learn the environment id. An explicit Environment Id (settings) overrides it. */
  React.useEffect(() => {
    let active = true;
    getHppSecurityToken()
      .then((t) => { const id = tokenClaims(t).environmentId; if (active && id) setEnvAuto(String(id)); })
      .catch(() => { /* not reachable (e.g. mock mode): the field stays available as a manual override */ });
    return () => { active = false; };
  }, []);

  /* Type-ahead account search (2+ characters, debounced). Skipped when the text is just the selected account's name. */
  React.useEffect(() => {
    const term = acctQuery.trim();
    if (term.length < 2 || (account && account.name === term)) { setAcctState((st) => Object.assign({}, st, { loading: false, results: [], open: false })); return undefined; }
    let active = true;
    setAcctState((st) => Object.assign({}, st, { loading: true, error: '' }));
    const t = setTimeout(() => {
      BPUI.Tools.API.requestQuery(BPUI.Tools.API.trimQuery(accountSql(term)), { on404: () => [] })
        .then((r) => { if (active) setAcctState({ loading: false, results: ((r && r.data) || []).map(toAccount), open: true, error: '' }); })
        .catch((e) => { if (active) setAcctState({ loading: false, results: [], open: true, error: (e && e.message) || 'Account search failed' }); });
    }, 350);
    return () => { active = false; clearTimeout(t); };
  }, [acctQuery]);

  const pickAccount = (a) => {
    if (!a.usable) return;
    setAccount(a);
    setAcctQuery(a.name);
    setProfileId(a.bpId);
    setAcctState({ loading: false, results: [], open: false, error: '' });
  };
  const clearAccount = () => { setAccount(null); setAcctQuery(''); setAcctState({ loading: false, results: [], open: false, error: '' }); };
  const onProfileIdChange = (v) => {
    setProfileId(v);
    if (account && v.trim() !== account.bpId) { setAccount(null); setAcctQuery(''); }
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
        if (!request.environmentId && !tokenClaims(securityToken).environmentId) throw new Error('Could not determine the Environment Id from the token. Enter it under the Environment Id override.');
        HostedPayments.renderPaymentForm(Object.assign({
          securityToken,
          environmentId: request.environmentId || String(tokenClaims(securityToken).environmentId || ''),
          currencyCode: request.currencyCode,
          apiUrl: hppApiUrl(),
          billingProfileId: request.profileId,
          targetSelector: '#' + CONTAINER_ID,
          amount: request.amount,
          showNoteField: noteMode(request.showNoteField),
          paymentGateways: request.gateways,
        }, request.style), {
          captureCompleted: (r) => set(r && r.isSuccess ? { phase: 'success', paymentId: r.paymentId, amount: r.amount } : { phase: 'error', message: errorText(r) }),
        });
        set({ phase: 'ready' });
      } catch (e) {
        set({ phase: 'error', message: e.message });
      }
    })();
    return () => { active = false; container.innerHTML = ''; };
  }, [request]);

  const styleProps = React.useMemo(() => buildStyleProps(style), [style]);
  const styleJson = JSON.stringify(styleProps);

  /* The SDK has no style-update call, so a style change re-renders the form (new token, typed card data is lost). */
  React.useEffect(() => {
    if (!request || !autoApply) return undefined;
    const t = setTimeout(() => {
      setRequest((r) => (r && JSON.stringify(r.style) !== styleJson ? Object.assign({}, r, { style: styleProps, n: Date.now() }) : r));
    }, 700);
    return () => clearTimeout(t);
  }, [styleJson, autoApply]);

  const amountNum = Number(amount);
  const selected = gateways.options.find((o) => o.key === gatewayKey);
  const problem = !profileId.trim() ? 'Pick an account or enter a Billing Profile Id.' : !(amountNum > 0) ? 'Enter an amount greater than 0.' : !selected ? 'No active payment gateway is selected.' : '';

  const setVars = (vars, value) => setStyle((st) => {
    const next = Object.assign({}, st.vars);
    vars.forEach((v) => { if (value === '') delete next[v]; else next[v] = value; });
    return Object.assign({}, st, { vars: next });
  });
  const setField = (key) => (value) => setStyle((st) => Object.assign({}, st, { [key]: value }));

  const exportText = (() => {
    if (exportTab === 'style') {
      const keys = Object.keys(styleProps);
      return '// Add these options to your HostedPayments.renderPaymentForm({ ... }) config.\n' + (keys.length ? keys.map((k) => '  ' + k + ': ' + toJs(styleProps[k], 1) + ',').join('\n') : '// (no style changes yet)');
    }
    const cfg = {
      securityToken: RAW('securityToken'),
      environmentId: environmentId.trim() || envAuto,
      currencyCode: (selected && selected.currency) || (account && account.currency) || currencyCode.trim() || 'USD',
      apiUrl: RAW('HPP_API_URL'),
      billingProfileId: profileId.trim(),
      paymentGateways: selected ? selected.gateways : {},
      amount: amountNum > 0 ? amountNum : 0,
      targetSelector: '#payment-container',
      showNoteField: noteMode(showNote),
    };
    Object.assign(cfg, styleProps);
    return [
      '// Load https://cdn.aws.billingplatform.com/hosted-payments-ui@release/lib.js first, and fetch a fresh securityToken per render.',
      "// In a BP widget: window.location.origin + '/' + BPSystem.organization + '/hostedPayments/1.0'. Elsewhere: https://<host>/<org>/hostedPayments/1.0",
      "const HPP_API_URL = window.location.origin + '/' + BPSystem.organization + '/hostedPayments/1.0';",
      '',
      'HostedPayments.renderPaymentForm(' + toJs(cfg, 0) + ', {\n  captureCompleted: (result) => console.log(result),\n});',
    ].join('\n');
  })();

  const doCopy = async () => {
    const ok = await copyText(exportText);
    setCopied(ok ? 'Copied' : 'Copy failed - select the text and copy it manually');
    setTimeout(() => setCopied(''), 2500);
  };

  const submit = (e) => {
    e.preventDefault();
    if (problem) { setStatus({ phase: 'error', message: problem }); return; }
    setRequest({ profileId: profileId.trim(), amount: amountNum, gateways: selected.gateways, environmentId: environmentId.trim(), currencyCode: selected.currency || (account && account.currency) || currencyCode.trim() || 'USD', showNoteField: showNote, style: styleProps, n: Date.now() });
  };

  const field = (label, value, set, extra) => (
    <label className="hpp-field">
      <span className="hpp-label">{label}</span>
      <input className="hpp-input" value={value} onChange={(e) => set(e.target.value)} {...(extra || {})} />
    </label>
  );

  const stylePanel = (
    <details className="hpp-panel hpp-style" open={styleOpen} onToggle={(e) => setStyleOpen(e.currentTarget.open)}>
      <summary className="hpp-panel-title">Style</summary>
      <div className="hpp-panel-body">
      <label className="hpp-check">
        <input type="checkbox" checked={autoApply} onChange={(e) => setAutoApply(e.target.checked)} />
        Re-render the form automatically when styles change
      </label>
      <div className="hpp-grid">
      <div className="hpp-group hpp-group-tall">
      <h4 className="hpp-h">Colors</h4>
      {COLOR_CONTROLS.map((c) => {
        const cur = style.vars[c.vars[0]];
        return (
          <div className="hpp-ctl" key={c.vars[0]}>
            <span className="hpp-label">{c.label}</span>
            <span className="hpp-ctlr">
              <input type="color" className="hpp-color" value={cur || c.def} onChange={(e) => setVars(c.vars, e.target.value)} />
              <code className="hpp-code">{cur || 'default'}</code>
              <button type="button" className="hpp-link" disabled={!cur} onClick={() => setVars(c.vars, '')}>reset</button>
            </span>
          </div>
        );
      })}
      </div>
      <div className="hpp-group">
      <h4 className="hpp-h">Shape and size</h4>
      {SIZE_CONTROLS.map((c) => {
        const cur = style.vars[c.vars[0]];
        return (
          <div className="hpp-ctl" key={c.vars[0]}>
            <span className="hpp-label">{c.label} ({c.unit})</span>
            <span className="hpp-ctlr">
              <input type="number" className="hpp-input hpp-num" min={c.min} max={c.max} step={c.step} placeholder={String(c.def)}
                value={cur ? parseFloat(cur) : ''} onChange={(e) => setVars(c.vars, e.target.value === '' ? '' : e.target.value + c.unit)} />
              <button type="button" className="hpp-link" disabled={!cur} onClick={() => setVars(c.vars, '')}>reset</button>
            </span>
          </div>
        );
      })}
      </div>
      <div className="hpp-group">
      <h4 className="hpp-h">Text and layout</h4>
      <label className="hpp-check">
        <input type="checkbox" checked={style.hideTitle} onChange={(e) => setField('hideTitle')(e.target.checked)} />
        Hide the form title
      </label>
      {field('Font family (optional)', style.fontFamily, setField('fontFamily'), { placeholder: 'Inter' })}
      <label className="hpp-check">
        <input type="checkbox" checked={style.fontGoogle} onChange={(e) => setField('fontGoogle')(e.target.checked)} />
        Load it from Google Fonts (untick for system or self-hosted fonts)
      </label>
      {field('Title text (when shown)', style.titleLabel, setField('titleLabel'), { placeholder: 'Payment Details' })}
      {field('Pay button text', style.payLabel, setField('payLabel'), { placeholder: 'Pay' })}
      {field('Scale ratio (0.5 to 2)', style.scaleRatio, setField('scaleRatio'), { placeholder: '1', inputMode: 'decimal' })}
      {field('Container width', style.containerWidth, setField('containerWidth'), { placeholder: '100% or 450px' })}
      {field('Max container width', style.maxContainerWidth, setField('maxContainerWidth'), { placeholder: '480px' })}
      </div>
      <div className="hpp-group">
      <h4 className="hpp-h">Custom CSS</h4>
      <label className="hpp-field">
        <span className="hpp-label">Extra rules (match classes by prefix, e.g. [class*="btnSubmit__"])</span>
        <textarea className="hpp-input hpp-area" rows={4} value={style.customCss} placeholder={'[class*="btnSubmit__"] { text-transform: uppercase; }'}
          onChange={(e) => setField('customCss')(e.target.value)} />
      </label>
      {field('External stylesheet URL (optional)', style.cssLink, setField('cssLink'), { placeholder: 'https://example.com/hpp.css' })}
      <div className="hpp-muted">customStyles allows up to 5 entries; this panel uses at most 4.</div>
      <button type="button" className="hpp-link" onClick={() => setStyle(Object.assign({}, DEFAULT_STYLE, { vars: {} }))}>Reset all styles</button>
      </div>
      <div className="hpp-group hpp-group-wide">
      <h4 className="hpp-h">Export</h4>
      <div className="hpp-tabs">
        <button type="button" className={'hpp-tab' + (exportTab === 'style' ? ' on' : '')} onClick={() => setExportTab('style')}>Style options</button>
        <button type="button" className={'hpp-tab' + (exportTab === 'full' ? ' on' : '')} onClick={() => setExportTab('full')}>Full render call</button>
      </div>
      <textarea className="hpp-input hpp-area hpp-export" readOnly rows={12} value={exportText} onFocus={(e) => e.target.select()} />
      <div className="hpp-actions">
        <button type="button" className="hpp-btn" onClick={doCopy}>Copy code</button>
        <button type="button" className="hpp-btn hpp-btn-alt" onClick={() => downloadText(exportTab === 'style' ? 'hpp-style-options.js' : 'hpp-render.js', exportText)}>Download .js</button>
        {copied && <span className="hpp-muted">{copied}</span>}
      </div>
      </div>
      </div>
      </div>
    </details>
  );

  return (
    <div className="hpp-layout">
      <details className="hpp-panel" open>
        <summary className="hpp-panel-title">Payment settings</summary>
        <div className="hpp-panel-body">
          <form id="hpp-configurator-form" className="hpp-form-row" onSubmit={submit}>
            <div className="hpp-field hpp-field-wide hpp-search">
              <span className="hpp-label">Account (search by name or Id)</span>
              <input className="hpp-input" value={acctQuery} placeholder="Start typing an account name"
                onChange={(e) => { setAcctQuery(e.target.value); if (account && e.target.value.trim() !== account.name) setAccount(null); }}
                onFocus={() => { if (acctState.results.length) setAcctState((st) => Object.assign({}, st, { open: true })); }} autoComplete="off" />
              {account && <span className="hpp-hint">Billing profile {account.bpId}{account.currency ? ' (' + account.currency + ')' : ''} <button type="button" className="hpp-link" onClick={clearAccount}>clear</button></span>}
              {acctState.loading && <span className="hpp-hint">Searching...</span>}
              {acctState.open && (
                <ul className="hpp-results">
                  {acctState.error && <li className="hpp-result-msg hpp-error">{acctState.error}</li>}
                  {!acctState.error && !acctState.results.length && <li className="hpp-result-msg">No matching active accounts</li>}
                  {acctState.results.map((a) => (
                    <li key={a.id} className={'hpp-result' + (a.usable ? '' : ' off')} onMouseDown={(e) => { e.preventDefault(); pickAccount(a); }}>
                      {a.name} <span className="hpp-hint">#{a.id}{a.usable ? '' : ' - no active billing profile'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {field('Billing Profile Id (optional)', profileId, onProfileIdChange, { placeholder: 'or set by the account' })}
            {field('Amount', amount, setAmount, { placeholder: '0.00', inputMode: 'decimal' })}
            <label className="hpp-field hpp-field-wide">
              <span className="hpp-label">Payment gateway</span>
              <select className="hpp-input" value={gatewayKey} disabled={gateways.loading || !gateways.options.length} onChange={(e) => setGatewayKey(e.target.value)}>
                {gateways.loading && <option value="">Loading gateways...</option>}
                {!gateways.loading && !gateways.options.length && <option value="">No active gateways</option>}
                {gateways.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
            </label>
            {field('Environment Id (auto-detected)', environmentId, setEnvironmentId, { placeholder: envAuto || 'detecting...', title: 'Read from the security token. Type a value only to override it.' })}
            {field('Fallback currency', currencyCode, setCurrencyCode, { title: 'Used when the selected gateway profile has no currency' })}
            <label className="hpp-field">
              <span className="hpp-label">Note field</span>
              <select className="hpp-input" value={showNote} onChange={(e) => setShowNote(e.target.value)}>
                {NOTE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
            <div className="hpp-form-actions">
              <button type="button" className="hpp-link" onClick={resetSaved}>Reset to defaults</button>
            </div>
          </form>
          {gateways.error && <div className="hpp-error">{gateways.error}</div>}
        </div>
      </details>
      <div className={'hpp-main' + (styleOpen ? '' : ' hpp-main-collapsed')}>
      {stylePanel}
      <div className="hpp-card">
        <div className="hpp-card-head">
          <h3 className="hpp-title">Make a payment</h3>
          <button type="submit" form="hpp-configurator-form" className="hpp-btn" disabled={status.phase === 'loading'}>{request ? 'Reload payment form' : 'Load payment form'}</button>
        </div>
        {status.phase === 'loading' && <div className="hpp-muted">Loading payment form...</div>}
        {status.phase === 'error' && <div className="hpp-error">{status.message}</div>}
        {status.phase === 'success' && <div className="hpp-success">Payment captured{status.paymentId ? ' (payment ' + status.paymentId + ')' : ''}.</div>}
        <div id={CONTAINER_ID} className="hpp-container" />
      </div>
      </div>
    </div>
  );
};

export default HppConfigurator;
