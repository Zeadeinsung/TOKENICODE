// Push the remote config straight into the packaged app's WebView over the
// Chrome DevTools Protocol, so the phone does not have to be typed on by hand.
//
// Run with the app in the foreground and `adb forward tcp:9222
// localabstract:webview_devtools_remote_<pid>` already set up.

const BASE = process.argv[2];
const TOKEN = process.argv[3];
if (!BASE || !TOKEN) {
  console.error("usage: node push-cfg.mjs <base> <token>");
  process.exit(2);
}

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("no page target; is the app in the foreground?");
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

function send(method, params) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
  else p.resolve(msg.result);
});

ws.addEventListener("open", async () => {
  const expr = `
    localStorage.setItem("tokenicode.base", ${JSON.stringify(BASE)});
    localStorage.setItem("tokenicode.token", ${JSON.stringify(TOKEN)});
    JSON.stringify({
      base: localStorage.getItem("tokenicode.base"),
      token: localStorage.getItem("tokenicode.token"),
    })
  `;
  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  console.log("stored:", res.result.value);
  // Reload only after the write is confirmed: the page target dies with it.
  await send("Page.reload", {});
  ws.close();
});

ws.addEventListener("error", (e) => {
  console.error("ws error", e.message || e);
  process.exit(1);
});
