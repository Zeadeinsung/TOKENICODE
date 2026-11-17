#!/usr/bin/env node
// MCP stdio <-> WebSocket bridge.
//
// Claude Code's interactive UI auto-discovers IDEs through ~/.claude/ide/*.lock,
// but `-p` / stream-json sessions (the mode tokenicode runs) never mount that UI
// hook. This proxy lets the same IDE bridge reach those sessions as a regular
// stdio MCP server: the CLI spawns us, we relay newline-delimited JSON-RPC to
// the WEBSOCKET server that tokenicode already runs in-process.
//
// Usage: node ide-mcp-stdio.mjs ws://127.0.0.1:<port>/?token=<authToken>

const url = process.argv[2];
if (!url) {
  console.error('usage: ide-mcp-stdio.mjs <ws-url>');
  process.exit(2);
}

const ws = new WebSocket(url);
const pending = [];
let buffer = '';

function forward(line) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(line);
  } else if (ws.readyState === WebSocket.CONNECTING) {
    pending.push(line);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) forward(line);
  }
});
process.stdin.on('end', () => {
  if (buffer.trim()) forward(buffer.trim());
});
process.stdin.on('error', () => process.exit(0));

ws.addEventListener('open', () => {
  for (const line of pending) ws.send(line);
  pending.length = 0;
});

ws.addEventListener('message', (event) => {
  const data = typeof event.data === 'string' ? event.data : String(event.data);
  process.stdout.write(data + '\n');
});

ws.addEventListener('close', () => process.exit(0));
ws.addEventListener('error', (event) => {
  console.error('[ide-mcp-stdio] websocket error:', event.message || event);
  process.exit(1);
});
