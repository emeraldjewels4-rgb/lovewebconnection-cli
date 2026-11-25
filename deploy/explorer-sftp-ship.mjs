#!/usr/bin/env node
/**
 * Uploads the explorer's page files over SFTP, then checks the deploy.
 *
 *   node deploy/explorer-sftp-ship.mjs --host s22.example.com --user account --key ~/.ssh/id_ed25519 --dry-run
 *   node deploy/explorer-sftp-ship.mjs --host s22.example.com --user account --key ~/.ssh/id_ed25519
 *
 * The explorer is uploaded by hand through the host's file manager, and a hand
 * upload can ship a page the checkout no longer has: an `index.html` left from an
 * earlier deploy answers 200 and keeps serving `app.js` revalidated, so every
 * header check passes while the page itself is wrong. The checker in this folder
 * catches that, but only when someone remembers to run it. This script does both
 * steps in the one order that cannot drift: ship the files, then run
 * `deploy/explorer-check.mjs` against the host, and exit non-zero if any check
 * fails.
 *
 * Four files, because they are the ones a page change touches: `index.html`,
 * `app.js`, `style.css` and `rpc.php`. `lookup-state.js`, `presets.json` and
 * `.htaccess` are not sent; use the file manager or
 * `deploy/explorer-ftp-upload.mjs` when one of those changes.
 *
 * SFTP is used rather than curl for the same reason curl is used in the FTPS
 * script: the client is already on the machine, and its batch mode takes the
 * whole transfer on stdin, so there is no password prompt, no per-file flag and
 * no plan that can drift from what is sent. The key is a path, never a secret in
 * an argument or a file. Host keys are trusted on first contact
 * (`StrictHostKeyChecking=accept-new`), as in the repository's other scripts.
 *
 * A failed check is not automatically a failed upload. A host whose rewrite
 * answers `/explorer/` with the site's dashboard serves every header and every
 * 404 correctly and still fails the page checks, and re-sending the right file
 * cannot change that. So after a red check this script looks at the host once
 * more — `/explorer/index.html` against the checkout's page — and says, for each
 * failing check, whether the URL or the file is what is wrong. That comparison
 * is the point: the folder URL and the file URL are answered by different parts
 * of the host's configuration, so one can hold the checkout's bytes while the
 * other does not.
 *
 * Everything local is checked before anything remote: a bad argument or a
 * missing file stops the script before a socket is opened, so a failure cannot
 * leave half a deploy behind.
 *
 * Exit codes: 0 uploaded and every check passed, 1 the upload or a check failed,
 * 2 the arguments were refused.
 */
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SOURCE_DIR = join(import.meta.dirname, "..", "explorer");
const CHECKER = join(import.meta.dirname, "explorer-check.mjs");

// The files a page change touches, in the order the README lists them.
const FILES = ["index.html", "app.js", "style.css", "rpc.php"];

const USAGE = `usage: node deploy/explorer-sftp-ship.mjs --host HOST --user USER --key FILE [options]

  --host HOST         server to connect to (required)
  --user USER         SFTP account (required)
  --key FILE          private key, with ~ for the home directory (required)
  --port N            SFTP port (default 22)
  --remote-dir PATH   folder to upload into (default public_html/explorer)
  --base URL          site root the check runs against (default https://fiatgod.x10.mx)
  --dry-run           print the files, the SFTP batch and the check command, then stop
  -h, --help          this text

Uploads ${FILES.join(", ")}
from explorer/ over SFTP, then runs deploy/explorer-check.mjs --base URL and
exits with its status, so a deploy that leaves a stale page fails here instead
of on a reader's screen. When a check fails it also says which failure is the
URL rather than the file: /explorer/ answered by another page is a routing
problem no upload can fix.`;

class UsageError extends Error {}

/** `~` and `~/...` as the shell would read them; every other path is left alone. */
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function parseArgs(argv) {
  const options = {
    port: 22,
    remoteDir: "public_html/explorer",
    base: "https://fiatgod.x10.mx",
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new UsageError(`${argument} needs a value`);
      }
      index += 1;
      return next;
    };

    switch (argument) {
      case "--host":
        options.host = value();
        break;
      case "--user":
        options.user = value();
        break;
      case "--key":
        options.key = value();
        break;
      case "--port":
        options.port = value();
        break;
      case "--remote-dir":
        options.remoteDir = value();
        break;
      case "--base":
        options.base = value();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new UsageError(`unknown argument ${argument}`);
    }
  }

  return options;
}

/** The batch sftp reads on stdin: one put per file, then a listing to show what landed. */
function batchFor(remoteDir) {
  const lines = FILES.map((name) => `put ${join(SOURCE_DIR, name)} ${remoteDir}/${name}`);
  lines.push(`ls -l ${remoteDir}`);
  return `${lines.join("\n")}\n`;
}

/** Runs a child to completion. Returns its exit status; 127 when it cannot start. */
function run(command, args, stdin) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: stdin === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    });
    child.on("error", () => resolve({ status: 127 }));
    child.on("close", (status) => resolve({ status: status ?? 1 }));
    if (stdin !== undefined && child.stdin) {
      // A closed pipe is the child exiting early, which its status already reports.
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
  });
}

/** A host may store CRLF; the page is compared line by line, as the checker does. */
function withoutCr(text) {
  return text.replace(/\r\n?/g, "\n");
}

/** One GET with the cache argued around, or null when the host does not answer. */
async function fetchPage(url) {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: withoutCr(await response.text()) };
  } catch {
    return null;
  }
}

/**
 * Runs the checker, passing its output straight through as it arrives so the
 * deploy still prints its results live, and keeping a copy to read afterwards.
 */
function runChecker(base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHECKER, "--base", base], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const relay = (chunk, stream) => {
      output += chunk;
      stream.write(chunk);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => relay(chunk, process.stdout));
    child.stderr.setEncoding("utf8").on("data", (chunk) => relay(chunk, process.stderr));
    child.on("error", () => resolve({ status: 127, output }));
    child.on("close", (status) => resolve({ status: status ?? 1, output }));
  });
}

// The checks that ask about the folder URL, not about a file's bytes: a host
// answering /explorer/ with another page keeps these red however many copies of
// the right page are uploaded. Name for name, as the checker prints them.
const FOLDER_URL_CHECKS = new Set([
  "/explorer/ answers 200",
  "/explorer/ is explorer/index.html",
  "/explorer/nope/ answers 404",
]);

function asksAboutFolderUrl(name) {
  // The app.js check is the page's own tag, so it reads the folder URL's body too.
  return FOLDER_URL_CHECKS.has(name) || name.startsWith("the page loads app.js");
}

/**
 * Which part of the host answers a failing check. `shipped` is the live answer
 * to "does /explorer/index.html hold the checkout's page?" — true, false, or null
 * when the host could not be asked.
 */
function causeOf(name, shipped) {
  if (asksAboutFolderUrl(name)) {
    if (shipped === true) return "routing";
    if (shipped === false) return "upload";
    return "unclear";
  }
  if (name === "/ still answers with the dashboard") return "site-rewrite";
  if (name === "app.js is revalidated, not cached for a year") return "folder-config";
  if (name.startsWith("/explorer/rpc.php")) return "proxy";
  return "unclear";
}

const CAUSE_WIDTH = 13;

function causeNote(cause, evidence) {
  const fileUrl = evidence.fileUrl.href;
  switch (cause) {
    case "routing":
      return (
        `routing: ${fileUrl} serves the checkout's page, so the upload landed. The ` +
        "folder URL is answered by something else — a rewrite rule, or a cache — " +
        "ahead of the page, and re-uploading cannot clear this. The folder path " +
        "needs its own rule, ahead of the document root's directory-exists rule."
      );
    case "upload":
      return (
        `upload: ${fileUrl} does not serve the checkout's page, so it is the file, ` +
        "not the URL, that is wrong here. Re-run the upload and check the listing " +
        "above for a partial transfer."
      );
    case "site-rewrite":
      return (
        "site-rewrite: / is answered by the document root's rules, which this " +
        "script does not send. A failed root is a site configuration change, not " +
        "an explorer upload."
      );
    case "folder-config":
      return (
        "folder-config: explorer/.htaccess sets these headers, and it is not one of " +
        "the four files this script sends. Upload it by hand or with " +
        "deploy/explorer-ftp-upload.mjs; the page files are irrelevant to it."
      );
    case "proxy":
      return (
        "proxy: rpc.php was sent, but this is the file itself or its same-origin " +
        "and rate-limit guards. The status and body above say which; neither is a " +
        "matter of the page files being stale."
      );
    default:
      return (
        "unclear: the check did not name a cause this script can place, and " +
        (evidence.shipped === null
          ? `${fileUrl} could not be read to compare against the checkout.`
          : "read its output above for the status and body it saw.")
      );
  }
}

/**
 * The checker names its failures on one line. Splits them back out so a deploy
 * that leaves the URL broken does not read as an upload that did not land.
 */
async function explainCheckFailure(base, output, status) {
  console.error(`\nuploaded, but the deploy check failed (exit ${status})`);

  const named = /^\s*\d+ of \d+ checks failed: (.+)$/m.exec(output);
  if (named === null) {
    console.error("\nthe check named no failing checks; its output above is all there is.");
    return;
  }
  const failures = named[1].split("; ").map((name) => name.trim()).filter(Boolean);

  // One look at the host decides the folder-URL failures: does the file the page
  // is served from hold the checkout's bytes? A stale upload and a shadowed URL
  // differ in exactly this, and not in anything the check itself reports.
  const page = await readFile(join(SOURCE_DIR, "index.html"), "utf8").then(withoutCr, () => null);
  const fileUrl = new URL("explorer/index.html", base);
  const served = await fetchPage(fileUrl);
  const shipped = page === null || served === null ? null : served.status === 200 && served.body === page;

  const causes = failures.map((name) => ({ name, cause: causeOf(name, shipped) }));
  console.error("");
  for (const { name, cause } of causes) console.error(`  ${cause.padEnd(CAUSE_WIDTH)}  ${name}`);

  const seen = new Set();
  for (const { cause } of causes) {
    if (seen.has(cause)) continue;
    seen.add(cause);
    console.error(`\n  ${causeNote(cause, { fileUrl, shipped })}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const missing = ["host", "user", "key"].filter((name) => !options[name]);
  if (missing.length > 0) throw new UsageError(`missing ${missing.join(", ")}`);
  if (!/^\d+$/.test(options.port)) throw new UsageError(`--port takes a number, not ${options.port}`);

  let base;
  try {
    base = new URL(options.base);
  } catch {
    throw new UsageError(`--base is not a URL: ${options.base}`);
  }
  if (!["http:", "https:"].includes(base.protocol)) {
    throw new UsageError("--base must be http or https");
  }

  const keyPath = expandHome(options.key);
  const keyState = await stat(keyPath).catch(() => null);
  if (keyState?.isFile() !== true) throw new UsageError(`key is not a file: ${keyPath}`);

  const files = [];
  for (const name of FILES) {
    const path = join(SOURCE_DIR, name);
    const state = await stat(path).catch(() => null);
    if (state?.isFile() !== true) throw new UsageError(`missing local file: ${path}`);
    files.push({ name, bytes: state.size });
  }

  const remoteDir = options.remoteDir.replace(/\/+$/, "");
  const batch = batchFor(remoteDir);

  console.log(`uploading ${files.length} files to ${options.user}@${options.host}:${remoteDir}`);
  for (const file of files) console.log(`  ${file.name}  ${file.bytes} B`);

  if (options.dryRun) {
    console.log("\n--dry-run: nothing was uploaded and the check was not run");
    console.log(`  sftp -i ${keyPath} -P ${options.port} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -b - ${options.user}@${options.host}`);
    for (const line of batch.trimEnd().split("\n")) console.log(`    ${line}`);
    console.log(`  node ${CHECKER} --base ${base.href}`);
    return 0;
  }

  const uploaded = await run(
    "sftp",
    [
      "-i", keyPath,
      "-P", String(options.port),
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-b", "-",
      `${options.user}@${options.host}`,
    ],
    batch,
  );
  if (uploaded.status !== 0) {
    console.error(`\nupload failed (sftp exit ${uploaded.status}); the check was not run`);
    return 1;
  }

  console.log(`\nchecking ${base.href}`);
  const checked = await runChecker(base.href);
  if (checked.status !== 0) {
    await explainCheckFailure(base, checked.output, checked.status);
    return 1;
  }

  console.log("\nuploaded and every check passed");
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`explorer-sftp-ship: ${error.message}`);
    console.error("\nnode deploy/explorer-sftp-ship.mjs --help");
    process.exitCode = 2;
  } else {
    console.error(`explorer-sftp-ship: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
