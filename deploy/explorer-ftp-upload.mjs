#!/usr/bin/env node
/**
 * Uploads the explorer's seven files to a cPanel account over FTP.
 *
 *   node deploy/explorer-ftp-upload.mjs --host ftp.example.com --user account --dry-run
 *   node deploy/explorer-ftp-upload.mjs --host ftp.example.com --user account
 *
 * The host and the username come from the arguments. The password is asked for
 * after they check out, with the echo off, and handed to curl on stdin as a
 * config file ("-K -"): it is never an argument, an environment variable or a
 * file, so it cannot reach the repo, a log or the shell history. --dry-run
 * checks the arguments and the local files, prints the plan, and exits without
 * opening a socket or asking for a password.
 *
 * curl does the transfer rather than a client written here. It is already a
 * prerequisite of the other deploy/ scripts, and it brings the parts of FTP
 * that are not worth reimplementing: a passive reply from a server behind NAT
 * (--ftp-skip-pasv-ip), folders created on demand (--ftp-create-dirs),
 * timeouts, and TLS if the host ever requires it.
 *
 * Exit codes: 0 uploaded (or a clean dry run), 1 the upload failed, 2 the
 * arguments were refused.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

// The zip builder reads the same list, so the two cannot ship different sets.
import { EXPLORER_FILES as FILES } from "./explorer-files.mjs";

const SOURCE_DIR = join(import.meta.dirname, "..", "explorer");

const USAGE = `usage: node deploy/explorer-ftp-upload.mjs --host HOST --user USER [options]

  --host HOST          FTP host, e.g. ftp.example.com (required)
  --user USER          FTP username (required)
  --port N             FTP control port (default 21)
  --remote-dir PATH    folder to upload into, relative to the FTP login
                       (default public_html/explorer; missing folders are created)
  --dry-run            check the arguments and the local files, print the plan,
                       and exit without connecting or asking for a password
  -h, --help           this text

Uploads ${FILES.join(", ")}
from explorer/ in this checkout, with curl. The password is read from the
terminal with echo off and is never an argument, an environment variable or a
file.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { port: 21, remoteDir: "public_html/explorer", dryRun: false, help: false };

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
      case "--port":
        options.port = value();
        break;
      case "--remote-dir":
        options.remoteDir = value();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new UsageError(`unknown option '${argument}'`);
    }
  }

  if (options.help) return options;

  if (!options.host) throw new UsageError("--host is required");
  if (!options.user) throw new UsageError("--user is required");

  if (typeof options.port === "string") {
    if (!/^\d+$/.test(options.port)) throw new UsageError(`--port must be a number, not '${options.port}'`);
    options.port = Number(options.port);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new UsageError("--port must be between 1 and 65535");
  }

  for (const [flag, text] of [
    ["--host", options.host],
    ["--user", options.user],
    ["--remote-dir", options.remoteDir],
  ]) {
    if (/[\r\n\0]/.test(text)) throw new UsageError(`${flag} cannot contain a line break`);
  }
  // The host is pasted into ftp://HOST:PORT/, so anything that a URL reads as
  // user info, a port, a path, a query, a fragment or an escape would silently
  // retarget the upload. An allowlist is easier to keep right than a list of
  // the characters that happen to break it today.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(options.host)) {
    const stray = [...new Set(options.host.replace(/[A-Za-z0-9.-]/g, ""))].join(" ");
    throw new UsageError(
      `--host must be a bare hostname such as ftp.example.com, not '${options.host}'` +
        (stray ? ` (remove: ${stray})` : "") +
        "; use --port for the port, and leave the username to --user",
    );
  }

  options.remoteDir = options.remoteDir.replace(/^\/+|\/+$/g, "");
  const segments = options.remoteDir.split("/");
  if (
    !options.remoteDir ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    // It ends up in a URL, so keep it to characters no encoding has to fix.
    segments.some((segment) => !/^[\w.-]+$/.test(segment))
  ) {
    throw new UsageError("--remote-dir must be a folder path such as public_html/explorer");
  }

  return options;
}

async function planUploads() {
  const files = await Promise.all(
    FILES.map(async (name) => {
      const local = join(SOURCE_DIR, name);
      try {
        const info = await stat(local);
        if (!info.isFile()) return { name, local, problem: "is not a regular file" };
        return { name, local, size: info.size };
      } catch {
        return { name, local, problem: "is missing" };
      }
    }),
  );

  const broken = files.filter((file) => file.problem);
  if (broken.length > 0) {
    throw new Error(
      `refusing to upload with an incomplete explorer/ folder: ${broken
        .map((file) => `${file.name} ${file.problem}`)
        .join(", ")}`,
    );
  }
  return files;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function printPlan(options, files, total) {
  console.log(`would upload ${files.length} files from ${SOURCE_DIR}`);
  console.log(`  to ftp://${options.host}:${options.port}/${options.remoteDir}`);
  for (const file of files) {
    console.log(
      `  ${file.name.padEnd(16)} ${formatBytes(file.size).padStart(8)}  ->  ${options.remoteDir}/${file.name}`,
    );
  }
  console.log(`  ${"".padEnd(16)} ${formatBytes(total).padStart(8)}  total`);
  console.log("dry run: arguments and local files check out; nothing connected, no password asked for");
}

/** Reads the password without echoing it. Never returns it to a caller that prints. */
async function readPassword(prompt) {
  if (!process.stdin.isTTY) {
    // Piped input, so a wrapper can supply the value without putting it in argv.
    // stdin that ends before a line arrives emits "close" and never "line", so
    // waiting on "line" alone would leave no handles and exit 0 having uploaded
    // nothing: the reader has to lose that race and say why.
    const reader = createInterface({ input: process.stdin, terminal: false });
    const line = await Promise.race([
      once(reader, "line").then(([value]) => value),
      once(reader, "close").then(() => undefined),
    ]);
    reader.close();
    if (typeof line !== "string") {
      throw new Error(
        "no password on stdin (it ended before a line); nothing was uploaded",
      );
    }
    return line;
  }

  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let value = "";
  let restore = () => {};

  const typed = new Promise((resolve) => {
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          restore();
          process.exit(130);
        }
        if (character === "\r" || character === "\n") {
          restore();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    restore = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };

    process.stdin.on("data", onData);
  });

  return typed;
}

/**
 * curl reads this from stdin. curl's config syntax treats a backslash and a
 * double quote inside a quoted value specially, so both are escaped; nothing
 * else in a password needs to be.
 */
function curlConfig(options, password) {
  const quote = (value) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `user = "${quote(options.user)}:${quote(password)}"\n`;
}

function uploadTarget(options, name) {
  return `ftp://${options.host}:${options.port}/${options.remoteDir}/${name}`;
}

/** curl's own message, without the "curl: (N)" prefix, or the exit status. */
function describeFailure(stderr, status) {
  const line =
    stderr
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry && !entry.startsWith("%")) ?? "";
  return line.replace(/^curl: \(\d+\)\s*/, "") || `curl exited with status ${status}`;
}

async function uploadFile(options, password, file) {
  const child = spawn(
    "curl",
    [
      "--silent",
      "--show-error",
      "--ftp-skip-pasv-ip",
      "--ftp-create-dirs",
      "--connect-timeout",
      "20",
      "--max-time",
      "300",
      "--config",
      "-",
      "--upload-file",
      file.local,
      uploadTarget(options, file.name),
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );

  let stderr = "";
  let spawnError = null;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdin.on("error", () => {
    // curl exited before reading the config; the status below says why.
  });
  child.stdin.end(curlConfig(options, password));

  // "close" rather than "exit" so the stderr above is complete; a failed spawn
  // emits "error" and may never reach a status of its own.
  const status = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
    child.on("error", () => resolve(-1));
  });
  if (spawnError) {
    throw new Error(
      spawnError.code === "ENOENT"
        ? `${file.name}: curl is not installed; install it or upload this file in the host's file manager`
        : `${file.name}: could not run curl: ${spawnError.message}`,
    );
  }
  if (status !== 0) throw new Error(`${file.name}: ${describeFailure(stderr, status)}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const files = await planUploads();
  const total = files.reduce((sum, file) => sum + file.size, 0);

  if (options.dryRun) {
    printPlan(options, files, total);
    return;
  }

  const password = await readPassword(`password for ${options.user}: `);
  if (!password) throw new Error("no password entered");

  console.log(`uploading to ftp://${options.host}:${options.port}/${options.remoteDir}`);
  for (const file of files) {
    await uploadFile(options, password, file);
    console.log(`  ${file.name.padEnd(16)} ${formatBytes(file.size).padStart(8)}  uploaded`);
  }
  console.log(`done: ${files.length} files (${formatBytes(total)}) now in ${options.remoteDir}`);
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`error: ${error.message}`);
    console.error("run with --help for the options");
    process.exitCode = 2;
    return;
  }
  console.error(`upload failed: ${error.message}`);
  process.exitCode = 1;
});
