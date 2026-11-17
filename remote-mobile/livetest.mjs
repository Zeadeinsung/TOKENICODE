const token = process.argv[2];
const ws = new WebSocket(`ws://100.118.193.101:8787/ws?token=${token}`);
let id = 0;
const pend = new Map();
function call(op, params = {}) {
  return new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, { res, rej });
    ws.send(JSON.stringify({ op, id: i, ...params }));
    setTimeout(() => { if (pend.delete(i)) rej(new Error("timeout " + op)); }, 20000);
  });
}
let deltas = 0, texts = "", stdinId = null, cliId = null;
ws.onmessage = (e) => {
  const v = JSON.parse(e.data);
  if (v.ev === "rpc:result") {
    const p = pend.get(v.id);
    if (p) { pend.delete(v.id); v.ok ? p.res(v.data) : p.rej(new Error(v.error)); }
    return;
  }
  const ch = v.ev;
  if (!ch.startsWith("claude:stream:")) { console.log("EVENT", ch); return; }
  const d = v.data || {};
  if (d.session_id && !cliId) cliId = d.session_id;
  if (d.type === "stream_event" && d.event?.type === "content_block_delta") {
    const dl = d.event.delta || {};
    if (dl.type === "text_delta") { deltas++; texts += dl.text; process.stdout.write("·"); }
    else if (dl.type === "thinking_delta") process.stdout.write("");
    return;
  }
  if (d.type === "assistant") {
    const c = d.message?.content;
    if (Array.isArray(c)) for (const b of c) if (b.type === "text") console.log("\n[assistant text]", JSON.stringify(b.text).slice(0, 200));
  }
  if (d.type === "result") console.log("\n[result] cost=$" + d.total_cost_usd + " dur=" + d.duration_ms + "ms err=" + d.is_error);
  if (d.type === "process_exit") console.log("[process_exit]");
  if (d.type === "system" && d.subtype === "init") console.log("[init] session_id=" + d.session_id + " cwd=" + d.cwd);
  if (d.type === "tokenicode_permission_request") console.log("[permission]", d.tool_name);
};

ws.onopen = async () => {
  try {
    const info = await call("startSession", {
      params: { cwd: "D:\\tmp-remote-test", prompt: "Reply with exactly: REMOTE-OK-123. Nothing else.", permissionMode: "bypassPermissions" },
    });
    stdinId = info.stdin_id;
    console.log("started stdin_id=" + stdinId + " cli=" + info.cli_session_id);
    setTimeout(async () => {
      console.log(`\n=== after 15s: deltas=${deltas} textLen=${texts.length} ===`);
      console.log("accumulated text:", JSON.stringify(texts));
      console.log("active now ->", JSON.stringify(await call("listActive")));
      process.exit(0);
    }, 15000);
  } catch (e) {
    console.log("ERR", e.message);
    process.exit(1);
  }
};
ws.onerror = () => { console.log("WS ERROR"); process.exit(1); };
