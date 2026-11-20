// Minimal static server for the web9999 page: no dependencies, binds every interface.
//
//   node serve.mjs <folder> <port>        # default ./ 8782
//
// This is the fallback when the host has node but no IIS site configured. The page itself
// needs nothing from a server: it is one HTML file that calls public RPC endpoints from the
// browser. Its PHP rails (/api/web9999/coins, /api/markets) 404 here and the page shows them
// as degraded, which is the state the page was built to handle.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.argv[2] ?? '.';
const port = Number(process.argv[3] ?? 8782);

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
}).listen(port, '0.0.0.0', () => {
  console.log(`web9999 serving ${root} on http://0.0.0.0:${port}/`);
});
