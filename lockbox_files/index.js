// src/payments/extensions/LockboxFileReference/api/getLockboxData/index.ts
var getLockboxData = async (paymentItemId) => {
  const query = BPUI.Tools.API.trimQuery(`
    SELECT lr.LockboxUploadHistoryId, luh.Created, luh.LockboxFile
    FROM PAYMENT p
    JOIN LOCKBOX_RECORD lr ON lr.Id = p.LockboxRecordId
    JOIN LOCKBOX_UPLOAD_HISTORY luh ON luh.Id = lr.LockboxUploadHistoryId
    WHERE p.Id = ${paymentItemId}
  `);
  const response = await BPUI.Tools.API.requestQuery(query, {
    on404: () => []
  });
  const record = response.data[0];
  if (!record?.LockboxUploadHistoryId) {
    return null;
  }
  const lockboxFile = record.LockboxFile ? String(record.LockboxFile) : "";
  const created = record.Created ? BPUI.Tools.Dates.format(new Date(String(record.Created)), BPUI.Tools.getDateFormatUnicode()) : "";
  return {
    lockboxUploadHistoryId: String(record.LockboxUploadHistoryId),
    lockboxFile,
    created
  };
};

// src/payments/extensions/LockboxFileReference/constants/index.ts
var PAYMENT_ITEM_ID = Number(BPUI.Tools.getNodeKey());

// src/payments/extensions/LockboxFileReference/style.module.css
var style_default = { link: "ezkKqa_link", secondary: "ezkKqa_secondary", container: "ezkKqa_container" };

// src/payments/extensions/LockboxFileReference/.bpWidget.tsx
var LockboxFileReferenceWidget = () => {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    let active = true;
    const fetchData = async () => {
      try {
        const result = await getLockboxData(PAYMENT_ITEM_ID);
        if (active) {
          setData(result);
        }
      } catch (e) {
        console.error("[LockboxFileReferenceWidget] Failed to fetch data", e);
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchData();
    return () => {
      active = false;
    };
  }, []);
  if (loading || !data) {
    return <span />;
  }
  const lockboxUrl = `${location.origin}/${BPUI.Tools.getOrgName()}/admin.jsp?name=LOCKBOX_UPLOAD_HISTORY&key=${data.lockboxUploadHistoryId}&mode=R`;
  return <div className={style_default.container}>
      <a
    href={lockboxUrl}
    className={style_default.link}
  >
        {data.lockboxFile || data.lockboxUploadHistoryId}
      </a>
      {data.created && <div className={style_default.secondary}>Received: {data.created}</div>}
    </div>;
};
