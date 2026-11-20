// Minimal static server for the web9999 page: no dependencies, bound the same way the installer
// binds the IIS site, so the two agree about what "installed" means.
//
//   node serve.mjs <folder> <port>              # loopback only, 127.0.0.1:8782 by default
//   node serve.mjs <folder> <port> -Bind 0.0.0.0 # every interface, for a public host
//
// -Bind takes the two values install-web9999.ps1 takes and defaults to the same one: exposure is
// a decision, not a side effect of starting a fallback server. Anything else is refused rather
// than passed to listen(), because "0.0.0.0 by accident" is the failure this default exists to
// prevent.
//
// This is the fallback when the host has node but no IIS site configured. The page itself
// needs nothing from a server: it is one HTML file that calls public RPC endpoints from the
// browser. Its PHP rails (/api/web9999/coins, /api/markets) 404 here and the page shows them
// as degraded, which is the state the page was built to handle.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const BINDS = ['127.0.0.1', '0.0.0.0'];

const argv = process.argv.slice(2);
const positional = [];
let bind = '127.0.0.1';
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '-Bind' || arg === '--bind') {
    bind = argv[++i];
    continue;
  }
  positional.push(arg);
}

if (!BINDS.includes(bind)) {
  console.error(`  -Bind ${bind ?? ''} is not an address. Use ${BINDS.join(' or ')}.`);
  process.exit(2);
}

const root = positional[0] ?? '.';
const port = Number(positional[1] ?? 8782);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`  port ${positional[1]} is not a port number`);
  process.exit(2);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer(async (request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const relative = path === '/' ? 'index.html' : normalize(path.replace(/^\/+/, ''));
  if (relative.startsWith('..')) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(join(root, relative));
    response.writeHead(200, { 'content-type': types[extname(relative)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }
}).listen(port, bind, () => {
  const where = bind === '0.0.0.0' ? 'every interface, reachable from outside' : 'loopback only, not reachable from outside';
  console.log(`web9999 serving ${root} on http://${bind}:${port}/ (${where})`);
  if (bind === '127.0.0.1') {
    console.log(`  reach it through a tunnel: ssh -N -L ${port}:127.0.0.1:${port} <user>@<server>`);
  }
});
