# BP Widget Harness

Local harness for iterating on BillingPlatform Web Toolkit widgets (V1 JSX and V2 New Format), then
testing them against your BP instance and pushing them to it.

```bash
npm install
npm start          # http://localhost:5179
```

In Claude desktop the Browser pane starts it through `.claude/launch.json` (`widget-harness`).

## Widget layout

One folder per widget, either `widgets/<TOKEN>/` or any root-level folder with an `index.js`/`index.html`
(e.g. `lockbox_files/`). Same three files you paste into the BP widget IDE:

| File | Notes |
|---|---|
| `index.html` | V1: JSX body (`<BPUI.Page>...`). V2: empty or `<Name {..._widgetProps} />` |
| `index.js` | V1: controller. V2: component + `export default Name;`. List: `const Widget = function (props) {}` |
| `style.css` | Widget CSS |
| `widget.json` (optional) | `kind` PAGE/EXTENSION/LIST, `version` v1/v2, `entity`, `inputParameters`, `description`. Inferred if missing |
| `fixtures.json` (optional) | Mock data, see below |

Edits hot-reload the preview. New root-level folders need a server restart; new `widgets/*` folders appear live.

## What the harness gives you

- **Preview** in an iframe, framed as an Extension field, a Page, or a List column. Viewport presets,
  record context (`nodeKey`, `nodeName`, mode R/E/N/L), BP's ~10px root font-size, simulated native Save
  for `BPActions.overrideSubmitButton`.
- **Toolkit emulation**: `BPSystem`, `BPActions`, `BPUI` (Page, Extension, FormLayout, Panel, Divider, Message,
  InputField, OutputField, EmbeddedList, TableColumn, Dialog, Button, Link; Grid approximated; other tags render a
  visible placeholder), `BPConnection` / `BPCollection` / `BPObject` / `BrmAggregate`, `BPUI.Tools.*`, `$.ajax` to `rest/2.0/...`.
  Mirrors documented gotchas: `queryAnsiSql` required (500), 404 on empty `query`, `refreshState` required after `set()`
  (toggle "Strict BP behaviour"), `afterRender` not fired in V2, `requestQuery` needs `opts`.
- **Compile**: esbuild with the same V2 wrapper idea as BP's Compilation Service; errors map back to file:line.
- **Lint**: the Immutable Rules (ASCII, comments in V1, export-default regex, no API calls in List widgets, ...).
- **Network / Console** panels for every REST call and `console.*`.

## Mock data (`fixtures.json`)

```json
{
  "context": { "nodeKey": "1001", "nodeName": "Account", "mode": "R" },
  "entities": { "Account": [ { "Id": "1001", "Name": "Acme" } ] },
  "queries":  [ { "match": "LOCKBOX_RECORD", "rows": [ { "Created": "2026-10-02T14:30:00" } ] } ],
  "meta":     { "Invoice": { "Status": { "type": "SELECT1", "options": ["OPEN", "PAID"] } } },
  "listRows": [ { "Status": "OPEN" } ]
}
```

`entities` back `retrieve`/`retrieveFiltered`/`query` (simple `=`/`<`/`>` AND-conditions only; joins and
aggregates are not evaluated). Use `queries[]` (regex on the SQL) for anything richer. Writes mutate an in-memory copy.

## Live BP

Pick **Live BP**, enter `https://host/org_name` and either username/password, an existing Session Id, or an OAuth
bearer token (or copy `harness.config.example.json` to `harness.config.json`, and set `BP_PASSWORD` in the environment).
The session lives in the local server's memory only; the server listens on 127.0.0.1 and rejects foreign Host/Origin headers.

- **Read-only by default.** Widget GETs pass through; POST/PUT/PATCH/DELETE return 403 until you tick *Allow writes*
  (red banner stays up while writes are on). Use a sandbox.
- **Deploy to BP** (bottom panel): upserts the `WIDGET` record by Token with `CompilationStatus = PENDING`, tries plaintext
  then base64 source, polls until `PROCESSED`/`ERROR` and decodes `ErrorMessage`. Requires writes enabled and typing the host.
  Enabling, wiring (Buttons and Actions / EXTENSION_WIDGET field / List layout / Page lookup) and role access stay manual.

## Known gaps

Unverified in the docs and best-guessed: `BPUI.Tools.API.*Entities` signatures, `getPageMode()` return values,
`undelete`, `Grid` tree view, charts and other `BPUI.*` tags. The harness warns once in the console when you hit one.
The REST body wrapper for Deploy is `{"brmObjects":[{...}]}`; confirm against your org on first deploy.
