/**
 * The deployment card view (MCP Apps, design d1-hosted §2f), inlined so the
 * remote toolset reads no file. Self-contained: no external script, style,
 * font or image, so its CSP allows no origin. It talks to the host only
 * through the MCP Apps postMessage bridge: `ui/initialize`, the
 * `ui/notifications/tool-result` of `varity_show_deployment`, `tools/call`
 * of the read-only `varity_deploy_status` for Refresh, and `ui/open-link`
 * for Open (the host asks the user to confirm). It never deploys and shows
 * no checkout or account link.
 */
export const DEPLOYMENT_CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Varity deployment</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --muted: #666; --line: #ddd; --ok: #137333; --bad: #b3261e; --bg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eee; --muted: #aaa; --line: #333; --ok: #6dd58c; --bad: #f2b8b5; --bg: #1b1b1b; } }
  body { margin: 0; font: 14px/1.4 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .price { color: var(--muted); margin: 0 0 10px; }
  ol { display: flex; gap: 8px; list-style: none; padding: 0; margin: 0 0 10px; }
  li { padding: 2px 8px; border-radius: 99px; border: 1px solid var(--line); color: var(--muted); }
  li.done { color: var(--ok); border-color: var(--ok); }
  li.failed { color: var(--bad); border-color: var(--bad); }
  .failure { color: var(--bad); margin: 0 0 10px; }
  .url { word-break: break-all; margin: 0 0 10px; }
  button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  button[disabled] { opacity: .5; cursor: default; }
</style>
</head>
<body>
<div class="card">
  <h1 id="name">Loading deployment</h1>
  <p class="price" id="price"></p>
  <ol id="steps"><li data-step="accepted">Accepted</li><li data-step="building">Building</li><li data-step="live">Live</li></ol>
  <p class="failure" id="failure" hidden></p>
  <p class="url" id="url"></p>
  <button id="open" disabled>Open</button>
  <button id="refresh" disabled>Refresh</button>
</div>
<script>
(function () {
  var nextId = 1, pending = {}, current = null;
  function send(message) { window.parent.postMessage(message, "*"); }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function text(id, value) { document.getElementById(id).textContent = value; }
  var LIVE = { running: 1, live: 1, active: 1, deployed: 1 };
  var FAILED = { failed: 1, error: 1, deleted: 1 };
  function render(card) {
    if (!card) return;
    current = card;
    text("name", card.app_name || card.id || "Deployment");
    text("price", card.monthly_price_usd ? "$" + card.monthly_price_usd + " per month" + (card.billing_model ? " (" + card.billing_model.replace(/_/g, " ") + ")" : "") : "Monthly price not served yet");
    var status = String(card.status || "accepted").toLowerCase();
    var reached = LIVE[status] ? 3 : (FAILED[status] ? 0 : (status === "accepted" || status === "queued" ? 1 : 2));
    var items = document.querySelectorAll("#steps li");
    for (var i = 0; i < items.length; i++) {
      items[i].className = FAILED[status] ? (i === 0 ? "done" : "failed") : (i < reached ? "done" : "");
    }
    var failure = document.getElementById("failure");
    failure.hidden = !card.failure && !FAILED[status];
    failure.textContent = card.failure || (FAILED[status] ? "Status: " + status : "");
    text("url", card.url || "The URL appears once the deployment is live.");
    document.getElementById("open").disabled = !card.url;
    document.getElementById("refresh").disabled = !card.id;
  }
  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pending[message.id]) {
      var entry = pending[message.id];
      delete pending[message.id];
      if (message.error) entry.reject(message.error); else entry.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result" && message.params) render(message.params.structuredContent);
  });
  document.getElementById("open").addEventListener("click", function () {
    if (current && current.url) request("ui/open-link", { url: current.url });
  });
  document.getElementById("refresh").addEventListener("click", function () {
    if (!current || !current.id) return;
    request("tools/call", { name: "varity_deploy_status", arguments: { deployment_id: current.id } }).then(function (result) {
      var body = JSON.parse(result.content[0].text);
      var deployment = body.data && body.data.deployment;
      if (!deployment) return;
      render({
        id: current.id, app_name: current.app_name, monthly_price_usd: current.monthly_price_usd, billing_model: current.billing_model,
        status: deployment.status, url: deployment.status === "deleted" ? null : (deployment.url || null), failure: current.failure
      });
    }).catch(function () { text("failure", "Refresh failed. Try again."); document.getElementById("failure").hidden = false; });
  });
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "varity-deployment-card", version: "1" },
    appCapabilities: {}
  }).then(function () { send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }); });
})();
</script>
</body>
</html>
`;
