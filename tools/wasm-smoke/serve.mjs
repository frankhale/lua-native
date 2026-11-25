// The smoke server: serves the package's browser entry and the smoke page,
// and collects what each browser reports back.
//
//   node tools/wasm-smoke/serve.mjs            # http://localhost:8377/
//   PORT=9000 node tools/wasm-smoke/serve.mjs
//
// Open the address in a browser. The page runs the set on its main thread and
// in a Web Worker, shows both, and POSTs each to `/report`; this prints one
// line per report and keeps the whole thing in `build-wasm/smoke/`, which is
// how a browser that cannot be driven from here is still read from here.
//
// It serves three things and no others: `/browser.js`, the web variant of the
// release build, and `tools/wasm-smoke/`. No cross-origin isolation headers
// are sent, on purpose: the target is built not to need them (D3), and a
// server that sent them would hide it if it did.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT ?? 8377);
const REPORTS = path.join(ROOT, 'build-wasm', 'smoke');
const SERVED = ['/browser.js', '/build-wasm/release/web/', '/tools/wasm-smoke/'];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

// "Chrome 142", "Safari 26.1", "Firefox 145": enough to name a report file and
// a line of output. The full string is kept in the report.
function engineOf(agent) {
  const pick = (re) => agent.match(re)?.[1];
  const edge = pick(/Edg\/(\d+)/);
  if (edge) return `Edge ${edge}`;
  const electron = pick(/Electron\/([\d.]+)/);
  const chrome = pick(/Chrome\/(\d+)/);
  if (electron) return `Electron ${electron} (Chromium ${chrome})`;
  if (chrome) return `Chrome ${chrome}`;
  const firefox = pick(/Firefox\/([\d.]+)/);
  if (firefox) return `Firefox ${firefox}`;
  const safari = pick(/Version\/([\d.]+).*Safari/);
  if (safari) return `Safari ${safari}`;
  return 'unknown engine';
}

function saveReport(report) {
  const engine = engineOf(report.userAgent ?? '');
  const count = (s) => (report.results ?? []).filter(r => r.status === s).length;
  const line = report.loadError
    ? `DID NOT LOAD: ${report.loadError.split('\n')[0]}`
    : `${count('pass')} of ${report.cells} pass, ${count('FAIL')} FAIL, ${count('INCONCLUSIVE')} inconclusive (family ${report.family}, loaded in ${report.loadMs} ms)`;
  console.log(`[report] ${engine} / ${report.where}: ${line}`);
  for (const r of report.results ?? []) {
    if (r.status !== 'pass') console.log(`[report]   ${r.status} ${r.name}: ${r.detail.split('\n')[0]}`);
  }
  fs.mkdirSync(REPORTS, { recursive: true });
  const file = path.join(REPORTS, `${engine.replace(/[^\w.]+/g, '-')}-${report.where}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ engine, received: new Date().toISOString(), ...report }, null, 2)}\n`);
}

const server = http.createServer((request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  const send = (status, body, type = 'text/plain; charset=utf-8') => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(body);
  };

  if (request.method === 'POST' && pathname === '/report') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; if (body.length > 4e6) request.destroy(); });
    request.on('end', () => {
      try { saveReport(JSON.parse(body)); send(204, ''); } catch (error) { send(400, String(error)); }
    });
    return;
  }
  if (request.method !== 'GET') return send(405, 'GET or POST /report');
  if (pathname === '/') {
    response.writeHead(302, { location: '/tools/wasm-smoke/page/index.html' });
    return response.end();
  }
  if (!SERVED.some(prefix => pathname === prefix || (prefix.endsWith('/') && pathname.startsWith(prefix)))) {
    return send(404, `not served: ${pathname}`);
  }
  const file = path.join(ROOT, path.normalize(pathname));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(404, `no such file: ${pathname}`);
  }
  return send(200, fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream');
});

if (!fs.existsSync(path.join(ROOT, 'build-wasm', 'release', 'web', 'lua-native.mjs'))) {
  console.error("No web build. Run 'npm run build-wasm-release' first.");
  process.exit(2);
}
server.listen(PORT, 'localhost', () => {
  console.log(`lua-native smoke set: http://localhost:${PORT}/`);
});
