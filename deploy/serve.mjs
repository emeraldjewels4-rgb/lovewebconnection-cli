// Minimal static server for the web9999 page: no dependencies, bound the same way the installer
// binds the IIS site, so the two agree about what "installed" means.
//
//   node serve.mjs <folder> <port>                              # loopback only, 127.0.0.1:8782 by default
//   node serve.mjs <folder> <port> -Bind 0.0.0.0                # every interface, for a public host
//   node serve.mjs <folder> <port> -Upstream https://account.x10.mx
//   node serve.mjs <folder> <port> -Upstream https://domain/web9999-interface
//   node serve.mjs -Upstream https://account.x10.mx -Probe        # ask the origin for coins, then exit
//
// -Bind takes the two values install-web9999.ps1 takes and defaults to the same one: exposure is
// a decision, not a side effect of starting a fallback server. Anything else is refused rather
// than passed to listen(), because "0.0.0.0 by accident" is the failure this default exists to
// prevent.
//
// -Upstream gives this server the same /api/* reverse proxy the IIS site gets from
// proxy-web9999.ps1: the page calls its rails same-origin and absolutely (/api/web9999/coins,
// /api/markets, /api/monero/stats.php), so without it the fallback serves a page whose every
// read 404s. It is off by default, and off is honest: /api/* answers 404 and the page shows
// those cells as degraded, which is the state the page was built to handle and better than a
// proxy to an origin nobody chose. The origin may carry a base path, and requests keep it in
// front of /api/: the deployment can sit at the domain root or in a subdirectory.
//
// This is a fallback for hosts without IIS. It proxies; it does not cache, retry, or rewrite
// bodies - what the origin says is what the browser gets.
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const BINDS = ['127.0.0.1', '0.0.0.0'];
const UPSTREAM_TIMEOUT_MS = 20_000;


// The same rules proxy-web9999.ps1 applies, so the two servers accept and refuse the same input:
// https only, an origin with an optional base path, no query or fragment, and no dot segments.
// Refusing here rather than normalising keeps a typo visible instead of silently proxying the
// rails somewhere unintended.
function parseUpstream(text) {
  if (!text) return null;
  if (!/^https:\/\//.test(text)) {
    throw new Error(`-Upstream ${text} is not https: plain http would put the API data on the wire in the clear`);
  }
  // Checked on the text as typed: URL() quietly resolves /a/../b to /b, so accepting it would
  // normalise a typo into a different base path instead of pointing at it.
  const rawPath = text.replace(/^https:\/\/[^/?#]*/, '');
  if (/(^|\/)\.{1,2}(\/|$)/.test(rawPath)) {
    throw new Error(`-Upstream ${text} has a . or .. segment, which is a typo rather than a base path`);
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`-Upstream ${text} is not a URL`);
  }
  if (url.search || url.hash) throw new Error(`-Upstream ${text} must not carry a query string or fragment`);
  if (!url.host) throw new Error(`-Upstream ${text} has no host`);
  const base = url.pathname.replace(/\/+$/, '');
  if (base !== '' && !/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(base)) {
    throw new Error(`-Upstream ${text} has a path that is not plain directory names`);
  }
  return { origin: url.origin, base, text: `${url.origin}${base}` };
}

// Streamed through untouched: the rails answer JSON (and one PHP page), and a proxy that parses
// and rebuilds a body is a proxy that can corrupt one.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function forwardable(headers) {
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) kept[name] = value;
  }
  return kept;
}

function proxyToUpstream(req, res, upstream) {
  const target = new URL(`${upstream.origin}${upstream.base}${req.url}`);
  // Only Host is rewritten, and that is the one header that decides which vhost answers on
  // shared hosting - the same reason the IIS rule and the nginx block set it. The rails read
  // nothing else from this proxy, so no other header is invented for them.
  const headers = forwardable(req.headers);
  headers.host = target.host;

  const forwarded = httpsRequest(target, { method: req.method, headers, timeout: UPSTREAM_TIMEOUT_MS }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, forwardable(answer.headers));
    answer.pipe(res);
  });
  forwarded.on('timeout', () => forwarded.destroy(new Error(`no answer within ${UPSTREAM_TIMEOUT_MS / 1000}s`)));
  forwarded.on('error', (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // Never 200 with an apology: the page treats a non-OK response as degraded and says so.
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`/api/* proxy to ${upstream.text} failed: ${error.message}\n`);
  });
  req.pipe(forwarded);
}

// What an answer to /api/web9999/coins actually is. A base path one directory too high - or an
// origin that serves the site itself - comes back 200 with HTML, and a proxy that looks only at the
// status reports the rails as configured while the page fails to parse what it got. The same test,
// in the same words, as Test-ApiAnswer in proxy-web9999.ps1, so the two servers agree on "working".
export function classifyCoinsAnswer(contentType, body) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const text = String(body ?? '').trimStart();
  const kind =
    /^(<!doctype html|<html|<head|<body)/i.test(text) || type.includes('html')
      ? 'HTML'
      : type === 'application/json' || /^[{\[]/.test(text)
        ? 'JSON'
        : 'something else';
  if (type !== 'application/json') {
    const served = type ? `as ${type}` : 'with no content type';
    return { ok: false, kind, why: `it answered with ${kind}, ${served}, not application/json` };
  }
  if (!text) return { ok: false, kind, why: 'the content type says JSON but the body is empty' };
  try {
    JSON.parse(text);
  } catch {
    return { ok: false, kind, why: 'the content type says JSON but the body does not parse as JSON' };
  }
  return { ok: true, kind, why: '' };
}

// Ask the origin what /api/web9999/coins actually is. Its answer describes the world the server is
// launched into, and the alternative is finding out from a page that silently renders nothing: this
// proxy copies whatever the origin answers, so a wrong base path is a 200 the browser cannot parse.
//
// Used twice. At startup, where it stays a line in the log and changes no exit code. And on demand
// with -Probe, because an origin can change under a running server - a redeploy on the far side, a
// DNS switch - and the startup line then describes something that is no longer true. Not a timer:
// it runs when someone asks it to, and a probe is a question, so it answers with ok/not-ok rather
// than a stack.
function checkUpstreamCoins(upstream) {
  const target = `${upstream.text}/api/web9999/coins`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ target, ...result });
    };
    const chunks = [];
    const probe = httpsRequest(
      target,
      { method: 'GET', timeout: UPSTREAM_TIMEOUT_MS, headers: { accept: 'application/json' } },
      (answer) => {
        answer.on('data', (chunk) => {
          if (chunks.length < 64) chunks.push(chunk);
        });
        answer.on('end', () => {
          const status = answer.statusCode ?? 0;
          const verdict = classifyCoinsAnswer(answer.headers['content-type'], Buffer.concat(chunks).toString('utf8'));
          if (status < 200 || status >= 300) {
            console.log(
              `  rails check: ${target} answered HTTP ${status}; the rails are not there - check -Upstream, and that api/web9999/coins exists at the origin`
            );
            finish({ ok: false, status, verdict });
            return;
          }
          if (verdict.ok) {
            console.log(`  rails check: ${target} answers JSON`);
            finish({ ok: true, status, verdict });
            return;
          }
          console.log(`  rails check: MISROUTED BASE PATH - ${target} ${verdict.why}`);
          console.log(
            '               the page cannot parse that, so its coin table reads as unavailable; -Upstream must be the directory that holds api/web9999/coins'
          );
          finish({ ok: false, status, verdict });
        });
      }
    );
    probe.on('timeout', () => probe.destroy(new Error(`no answer within ${UPSTREAM_TIMEOUT_MS / 1000}s`)));
    probe.on('error', (error) => {
      console.log(`  rails check: could not reach ${target}: ${error.message}`);
      finish({ ok: false, status: null, verdict: null, error: error.message });
    });
    probe.end();
  });
}

// The same file is both a server and the unit its test imports. Everything above is behaviour;
// this is the part that only makes sense when the file is run, so an import starts no listener and
// reads no process argv it did not write.
function main() {
  const argv = process.argv.slice(2);
  const positional = [];
  let bind = '127.0.0.1';
  let upstreamArg = '';
  let probeOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-Bind') {
      bind = argv[++i];
      continue;
    }
    if (arg === '-Upstream') {
      upstreamArg = argv[++i] ?? '';
      continue;
    }
    if (arg === '-Probe' || arg === '--probe') {
      probeOnly = true;
      continue;
    }
    // Anything else that starts with a dash is a typo, and passing it on made the failure arrive as
    // "port -Upsteam is not a port number" instead of naming the option that was misspelled.
    if (arg.startsWith('-')) {
      console.error(`  unknown option ${arg}. Use -Bind, -Upstream, or <folder> <port>.`);
      process.exit(2);
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

  let upstream = null;
  try {
    upstream = parseUpstream(upstreamArg);
  } catch (error) {
    console.error(`  REFUSED: ${error.message}`);
    console.error('  nothing was started. Fix the origin, or leave -Upstream off to serve the page alone.');
    process.exit(2);
  }

  // -Probe asks the question and exits: no listener, no page, no timer. Exit 0 means the origin
  // answered JSON, 2 means it did not - the code this file already returns when it refuses to start,
  // so a script sees one contract either way.
  if (probeOnly) {
    if (!upstream) {
      console.error('  REFUSED: -Probe needs -Upstream - it asks that origin for /api/web9999/coins');
      process.exit(2);
    }
    checkUpstreamCoins(upstream).then((result) => {
      process.exitCode = result.ok ? 0 : 2;
    });
    return;
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

  const server = createServer(async (request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]);

    if (upstream && path.startsWith('/api/')) {
      proxyToUpstream(request, response, upstream);
      return;
    }

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
  });

  // A port that is already taken is the likeliest way this server fails to start, and Node's default is
  // a stack trace whose one useful fact - the port - is buried in EADDRINUSE. It is said in a sentence
  // instead, and with exit 2: the code this file already uses for every reason it refuses to start, so
  // a caller sees one contract rather than a second, incidental one.
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`  port ${port} is already in use - another process is listening on ${bind}:${port}; stop it or pass a different port`);
      process.exit(2);
    }
    console.error(`  cannot listen on ${bind}:${port}: ${error.message}`);
    process.exit(2);
  });

  server.listen(port, bind, () => {
    const where = bind === '0.0.0.0' ? 'every interface, reachable from outside' : 'loopback only, not reachable from outside';
    console.log(`web9999 serving ${root} on http://${bind}:${port}/ (${where})`);
    console.log(
      upstream
        ? `  rails: /api/* is proxied to ${upstream.text}`
        : '  rails: /api/* is not proxied - it answers 404 here and the page shows those cells as degraded. Pass -Upstream https://<x10 host> to forward them.'
    );
    if (bind === '127.0.0.1') {
      console.log(`  reach it through a tunnel: ssh -N -L ${port}:127.0.0.1:${port} <user>@<server>`);
    }
    if (upstream) checkUpstreamCoins(upstream);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
