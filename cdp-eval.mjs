// Drive a Chromium page over CDP: evaluate the JS in <exprFile> against the
// page target on <port> and print the result. Debug helper.
//
//   node cdp-eval.mjs <port> <exprFile> [urlSubstring]
import { readFileSync } from "node:fs";

const port = process.argv[2] || "9333";
const exprFile = process.argv[3];
const urlMatch = process.argv[4];
if (!exprFile) {
  console.error("usage: node cdp-eval.mjs <port> <exprFile> [urlSubstring]");
  process.exit(2);
}
const expression = readFileSync(exprFile, "utf8");

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const pages = targets.filter((t) => t.type === "page");
const page = urlMatch ? pages.find((p) => p.url.includes(urlMatch)) : pages[0];
if (!page) {
  console.error("no matching page target");
  process.exit(1);
}
console.log("#", page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method) return; // ignore events
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
});

ws.addEventListener("open", async () => {
  try {
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      console.log("EXCEPTION:", JSON.stringify(res.exceptionDetails, null, 1));
    } else {
      const v = res.result?.value;
      console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1));
    }
  } catch (e) {
    console.error("eval failed:", e.message);
  }
  ws.close();
});
