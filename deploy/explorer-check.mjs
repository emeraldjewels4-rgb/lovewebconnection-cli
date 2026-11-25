#!/usr/bin/env node
/**
 * Read-only acceptance check for the deployed explorer page.
 *
 *   npm run explorer:check
 *   npm run explorer:check -- --base https://example.com
 *
 * The explorer is uploaded by hand through a host's file manager, so nothing in
 * this repo can see what the host actually serves afterwards. These are the nine
 * things that separate a working deploy from the failure modes this folder has
 * already hit: the folder URL answering with its own index rather than the site
 * root's absolute DirectoryIndex, the uploaded page being the one in this
 * checkout (a host may normalise line endings, so the comparison ignores CR), the
 * page asking for the same app.js version the checkout does, app.js being
 * revalidated rather than cached for the year the parent site sets, app.js and
 * lookup-state.js being the files in this checkout (a script left behind by an
 * earlier upload is otherwise invisible, because the page only names a version),
 * a missing subfolder still being a 404, the site root still being the dashboard,
 * and the proxy answering the page's own call instead of refusing it.
 *
 * Read-only: it sends GETs with `cache-control: no-cache`, so a proxy cannot
 * hand back the page a previous deploy left, plus one POST - eth_chainId through
 * rpc.php, from this site's own Origin - which reads the chain id and changes
 * nothing. That POST is the only request that reaches a chain endpoint. It writes
 * nothing. Exit status is 0 when all nine pass, 1 when any fails or the host
 * cannot be reached, and 2 for a usage error.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SOURCE_DIR = join(import.meta.dirname, "..", "explorer");
const DEFAULT_BASE = "https://fiatgod.x10.mx";
const TIMEOUT_MS = 20_000;
const CHECK_COUNT = 9;

const USAGE = `usage: node deploy/explorer-check.mjs [--base URL]

  --base URL   site root to check (default ${DEFAULT_BASE})
  -h, --help   this text

Checks the deployed explorer: GETs, plus the one POST the page itself makes:
  1  /explorer/ answers 200
  2  /explorer/ is explorer/index.html from this checkout, CR ignored
  3  the page asks for the same app.js version the checkout does
  4  /explorer/app.js is revalidated, not cached for a year
  5  /explorer/app.js is explorer/app.js from this checkout, CR ignored
  6  /explorer/lookup-state.js is explorer/lookup-state.js from this checkout
  7  /explorer/nope/ answers 404
  8  / still answers 200 with something other than the explorer page
  9  /explorer/rpc.php answers eth_chainId to this site's own origin`;

class UsageError extends Error {}

function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        base: { type: "string", default: DEFAULT_BASE },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    // An unknown option or a flag missing its value is a usage error, not a failed check.
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  if (values.help) return { help: true };

  let base;
  try {
    base = new URL(values.base);
  } catch {
    throw new UsageError(`--base is not a URL: ${values.base}`);
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new UsageError(`--base must be an http or https URL, not ${base.protocol}`);
  }
  // Resolved against, so a base without the trailing slash would otherwise make
  // `new URL("explorer/", base)` replace the last path segment.
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return { base };
}

/** A host may store CRLF; the page itself is checked line by line, not byte by byte. */
function withoutCr(text) {
  return text.replace(/\r\n?/g, "\n");
}

async function get(url) {
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "follow",
    // So an intermediary cannot answer with the copy a previous deploy left.
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

/**
 * The one request this script does not send as a GET. rpc.php refuses anything but
 * a POST before it looks at the caller, and past that it answers only the page it
 * is served with, so the Origin is this site's own - the header every browser
 * attaches to the page's own call - and the body is eth_chainId, the call the
 * page makes first, which reads the chain id and changes nothing.
 */
async function postJson(url, body, origin) {
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    redirect: "follow",
    headers: { "content-type": "application/json", origin, "cache-control": "no-cache" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

/** `<n> B served, <m> B in the checkout`, the detail for a body comparison. */
function sizeDetail(served, expected) {
  return `${Buffer.byteLength(served)} B served, ${Buffer.byteLength(expected)} B in the checkout`;
}

/** A refusal's body on one line, short enough for the detail column. */
function shortBody(text) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 120)}...` : line;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const { base } = options;

  const page = await readFile(join(SOURCE_DIR, "index.html"), "utf8");
  const version = /app\.js\?v=([\w.-]+)/.exec(page)?.[1];
  if (!version) {
    throw new UsageError("explorer/index.html does not name an app.js version; nothing to check against");
  }
  // The proxy looks its chain up in the presets, so the check asks about one the
  // checkout actually ships rather than inventing a name the host would refuse.
  let presets;
  try {
    presets = JSON.parse(await readFile(join(SOURCE_DIR, "presets.json"), "utf8"));
  } catch (error) {
    throw new UsageError(`explorer/presets.json is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const chain = Array.isArray(presets?.chains) ? presets.chains[0]?.name : undefined;
  if (typeof chain !== "string" || chain === "") {
    throw new UsageError("explorer/presets.json names no chain to ask the proxy about");
  }
  // The page names only a version, so the host can serve an unchanged page beside
  // scripts from an earlier upload and every other check still passes. These are
  // compared with what the host sends, CR ignored for the same reason as the page.
  const [appSource, stateSource] = await Promise.all([
    readFile(join(SOURCE_DIR, "app.js"), "utf8"),
    readFile(join(SOURCE_DIR, "lookup-state.js"), "utf8"),
  ]);

  console.log(`checking ${base.href}`);
  const failed = [];
  const report = (ok, name, detail) => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
    if (!ok) failed.push(name);
  };
  const attempt = async (url, send = get) => {
    try {
      return await send(url);
    } catch (error) {
      throw new Error(`could not fetch ${url.href}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const folder = await attempt(new URL("explorer/", base));
  report(folder.status === 200, "/explorer/ answers 200", `HTTP ${folder.status}`);
  const served = withoutCr(folder.body);
  const expected = withoutCr(page);
  report(served === expected, "/explorer/ is explorer/index.html", sizeDetail(served, expected));
  report(
    folder.body.includes(`app.js?v=${version}`),
    `the page loads app.js?v=${version}`,
  );

  const asset = await attempt(new URL("explorer/app.js", base));
  const cacheControl = asset.headers.get("cache-control") ?? "";
  report(
    /no-cache/i.test(cacheControl) && /must-revalidate/i.test(cacheControl),
    "app.js is revalidated, not cached for a year",
    `cache-control: ${cacheControl || "(none)"}`,
  );

  // A script left behind by an earlier upload breaks lookups in ways the page
  // cannot report, and until now only showed up as a mismatch on index.html.
  const servedAsset = withoutCr(asset.body);
  const checkoutAsset = withoutCr(appSource);
  report(
    servedAsset === checkoutAsset,
    "/explorer/app.js is explorer/app.js",
    sizeDetail(servedAsset, checkoutAsset),
  );

  const helpers = await attempt(new URL("explorer/lookup-state.js", base));
  const servedHelpers = withoutCr(helpers.body);
  const checkoutHelpers = withoutCr(stateSource);
  report(
    servedHelpers === checkoutHelpers,
    "/explorer/lookup-state.js is explorer/lookup-state.js",
    sizeDetail(servedHelpers, checkoutHelpers),
  );

  const missing = await attempt(new URL("explorer/nope/", base));
  report(missing.status === 404, "/explorer/nope/ answers 404", `HTTP ${missing.status}`);

  const root = await attempt(base);
  report(
    root.status === 200 && withoutCr(root.body) !== expected,
    "/ still answers with the dashboard",
    `HTTP ${root.status}, ${Buffer.byteLength(withoutCr(root.body))} B`,
  );

  // The page falls back to calling public endpoints itself when rpc.php does not
  // answer, which looks like a working explorer while every lookup has left this
  // host's proxy behind. A refusal is therefore a failed deploy, not a detail.
  const ask = (url) =>
    postJson(url, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, base.origin);
  const answer = await attempt(
    new URL(`explorer/rpc.php?chain=${encodeURIComponent(chain)}`, base),
    ask,
  );
  let relayed = null;
  try {
    relayed = JSON.parse(answer.body);
  } catch {
    // a body that is not JSON is reported below, with the status it came with
  }
  const chainId = typeof relayed?.result === "string" ? relayed.result : "";
  const answered = answer.status === 200 && /^0x[0-9a-f]+$/i.test(chainId);
  report(
    answered,
    "/explorer/rpc.php answers eth_chainId to this page's origin",
    answered
      ? `HTTP ${answer.status}, chain ${chain} reads ${chainId}`
      : `HTTP ${answer.status}${answer.body ? `, ${shortBody(answer.body)}` : ""}`,
  );

  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${CHECK_COUNT} checks failed: ${failed.join("; ")}`);
    return 1;
  }
  console.log(`\n${CHECK_COUNT} checks passed`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}`);
      console.error("run with --help for the options");
      process.exitCode = 2;
      return;
    }
    console.error(`check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
