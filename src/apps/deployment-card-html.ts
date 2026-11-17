/**
 * The deployment card view (MCP Apps, design d1-hosted §2f), inlined so the
 * remote toolset reads no file. Self-contained: no external script, style,
 * font or image, so its CSP allows no origin. It talks to the host only
 * through the MCP Apps postMessage bridge: `ui/initialize`, the
 * `ui/notifications/tool-result` of `varity_show_deployment`, `tools/call`
 * of the read-only `varity_show_deployment` for Refresh (served status and
 * failure reason), and `ui/open-link`
 * for Open (the host asks the user to confirm). It never deploys and shows
 * no checkout or account link. It accepts messages only from its parent
 * frame, pins the host origin from the `ui/initialize` response and drops
 * any other origin after that, and opens only http(s) URLs.
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
  var nextId = 1, pending = {}, current = null, initId = null, hostOrigin = null;
  // The host origin is unknown until it answers ui/initialize; then it is pinned.
  function send(message) { window.parent.postMessage(message, hostOrigin || "*"); }
  function safeUrl(value) {
    try {
      var url = new URL(String(value));
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch (error) { return null; }
  }
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
    document.getElementById("open").disabled = !safeUrl(card.url);
    document.getElementById("refresh").disabled = !card.id;
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    if (hostOrigin === null) {
      // Before the host answers ui/initialize, only that answer is accepted; its origin is pinned.
      if (!event.data || event.data.id !== initId || initId === null) return;
      hostOrigin = event.origin;
    } else if (event.origin !== hostOrigin) {
      return;
    }
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
    var url = current && safeUrl(current.url);
    if (url) request("ui/open-link", { url: url });
  });
  document.getElementById("refresh").addEventListener("click", function () {
    if (!current || !current.id) return;
    request("tools/call", { name: "varity_show_deployment", arguments: { deployment_id: current.id } }).then(function (result) {
      if (result && !result.isError && result.structuredContent) render(result.structuredContent);
    }).catch(function () { text("failure", "Refresh failed. Try again."); document.getElementById("failure").hidden = false; });
  });
  initId = nextId;
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
