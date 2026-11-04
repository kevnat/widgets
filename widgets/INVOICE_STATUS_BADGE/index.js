const COLORS = { PAID: "#1e6b3a", OPEN: "#a66a00", VOID: "#8a2a22" };

const Widget = function (props) {
  const status = String(props.Status || "").toUpperCase();
  const overdue = status === "OPEN" && props.DueDate && new Date(props.DueDate) < new Date("2026-10-28");
  return (
    <span className="isb-badge" style={{ borderColor: COLORS[status] || "#66727f", color: COLORS[status] || "#66727f" }}>
      {overdue ? "OVERDUE" : status || "UNKNOWN"}
    </span>
  );
};
