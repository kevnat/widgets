BPSystem.initialize();

var invoice = new BPUI.ReferenceObject();
var activities = new BPUI.ReferenceObject();
var profile = new BPUI.ReferenceObject();

function money(v) {
  return v == null || v === "" ? "" : "$" + Number(v).toFixed(2);
}

BPUI.afterRender = function () {
  var id = BPSystem.nodeKey;
  if (!id) {
    BPActions.handleError("No invoice selected: nodeKey is empty");
    return;
  }
  invoice.set(BPConnection.Invoice.retrieve(id));
  activities.set(
    BPConnection.Activity.query(
      "select ProductId, Quantity, Rate, RatedAmount from Activity where InvoiceId = " + id
    ).collection()
  );
  BPActions.refreshState("invoice");
};

function statusChanged(value) {
  console.log("Status changed to " + value);
}

function addLine(index) {
  activities.get().addNew({ InvoiceId: BPSystem.nodeKey, Quantity: 1, Rate: 0, RatedAmount: 0 }, index + 1);
  BPActions.refreshState("activities");
}

function recalc(row, column) {
  var el = activities.get().elements[row];
  if (column === 2 || column === 3) {
    el.RatedAmount = (Number(el.Quantity) * Number(el.Rate)).toFixed(2);
    var total = 0;
    activities.get().forEach(function (a) { total += Number(a.RatedAmount || 0); });
    invoice.get().TotalAmount = total.toFixed(2);
    BPActions.refreshState("activities");
  }
}

function save() {
  BPActions.clearErrors();
  BPConnection.Invoice.update(invoice.get())
    .done(function () {
      console.log("Invoice saved");
    })
    .fail(function (err) {
      BPActions.handleError(err);
    });
}

function cancel() {
  console.log("Cancel clicked");
}

function showProfile() {
  profile.set(BPConnection.BillingProfile.retrieveFiltered("AccountId = " + invoice.get().AccountId).single());
  BPActions.refreshState("profile");
  BPActions.showDialog("profileDialog", { title: "Billing Profile", modal: true, width: 420 });
}
