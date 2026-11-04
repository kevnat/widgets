const money = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(v) || 0);

const loadSummary = async (accountId) => {
  const account = await BPUI.Tools.API.get('ACCOUNT/' + encodeURIComponent(accountId));
  const invoices = await BPUI.Tools.API.requestQuery(
    BPUI.Tools.API.trimQuery("SELECT i.Id, i.Status, i.InvoiceDate, i.DueDate, i.TotalAmount, i.DueAmount FROM INVOICE i JOIN BILLING_PROFILE bp ON bp.Id = i.BillingProfileId WHERE bp.AccountId = " + Number(accountId) + " ORDER BY i.DueDate DESC"),
    { on404: () => [] }
  );
  return { account: account && account.retrieveResponse && account.retrieveResponse[0], invoices: invoices.data };
};

const AccountSummary = ({ _widgetProps }) => {
  const initial = BPUI.Tools.getNodeKey() || '';
  const [input, setInput] = React.useState(String(initial));
  const [accountId, setAccountId] = React.useState(String(initial));
  const [state, setState] = React.useState({ loading: !!initial });

  React.useEffect(() => {
    if (!accountId) { setState({ loading: false }); return; }
    let active = true;
    setState({ loading: true });
    loadSummary(accountId)
      .then((r) => { if (active) setState({ loading: false, ...r }); })
      .catch((e) => { if (active) setState({ loading: false, error: e.status === 404 ? 'Account ' + accountId + ' returned HTTP 404: it does not exist in this org, or this user cannot see it (permissions / sharing group).' : e.message }); });
    return () => { active = false; };
  }, [accountId]);

  const lookup = (
    <form className="acs-lookup" onSubmit={(e) => { e.preventDefault(); setAccountId(input.trim()); }}>
      <input className="acs-input" value={input} placeholder="Account Id" onChange={(e) => setInput(e.target.value)} />
      <button type="submit" className="acs-btn">Load account</button>
    </form>
  );

  if (state.loading) return <div>{lookup}<div className="acs-muted">Loading...</div></div>;
  if (state.error) return <div>{lookup}<div className="acs-error">{state.error}</div></div>;
  if (!state.account) return <div>{lookup}<div className="acs-muted">Enter an Account Id to load it.</div></div>;

  const open = state.invoices.filter((i) => Number(i.DueAmount || 0) > 0);
  const balance = open.reduce((sum, i) => sum + Number(i.DueAmount || 0), 0);

  return (
    <div className="acs-card">
      {lookup}
      <div className="acs-head">
        <h3 className="acs-title">{state.account.Name}</h3>
        <span className={'acs-status acs-' + String(state.account.Status).toLowerCase()}>{state.account.Status}</span>
      </div>
      <div className="acs-kpis">
        <div><div className="acs-kpi">{money(balance)}</div><div className="acs-muted">Open balance</div></div>
        <div><div className="acs-kpi">{open.length}</div><div className="acs-muted">Open invoices</div></div>
        <div><div className="acs-kpi">{state.invoices.length}</div><div className="acs-muted">Total invoices</div></div>
      </div>
      {state.invoices.length === 0 ? <div className="acs-muted">No invoices yet.</div> : (
        <table className="acs-table">
          <thead><tr><th>Invoice Id</th><th>Status</th><th>Due</th><th className="acs-num">Total</th><th className="acs-num">Amount due</th></tr></thead>
          <tbody>
            {state.invoices.slice(0, 5).map((i) => (
              <tr key={i.Id}><td>{i.Id}</td><td>{i.Status}</td><td>{BPUI.Tools.Dates.format(new Date(String(i.DueDate).slice(0, 10) + 'T00:00:00'), BPUI.Tools.getDateFormatUnicode())}</td><td className="acs-num">{money(i.TotalAmount)}</td><td className="acs-num">{money(i.DueAmount)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default AccountSummary;
