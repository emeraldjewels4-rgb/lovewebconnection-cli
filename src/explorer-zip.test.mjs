import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EXPLORER_FILES } from "../deploy/explorer-files.mjs";

// deploy/explorer-zip.mjs writes one archive beside the checkout, so a test that ran it in place would
// overwrite the copy the pre-commit hook checks. Each test therefore gets a throwaway pair of
// deploy/explorer files and an explorer/ folder; the script derives both paths from its own directory,
// so the copy writes its archive in the temp tree and the repo is never touched.
//
// The reader in that script is the thing under test, so the checks below feed it archives it did not
// just build: a name renamed inside the central directory (still a valid zip, so exit 1 - "disagrees"),
// and a file cut in half (not a zip at all, so exit 2 - "cannot read"). Those are the two statuses the
// pre-commit hook distinguishes, and neither needs a socket, a zip binary or the network.
const REPO = join(import.meta.dirname, "..");
const SCRIPT = "explorer-zip.mjs";
const ARCHIVE = "explorer-x10-upload.zip";

const LOCAL_SIGNATURE = 0x04034b50;

/** Copies deploy/{explorer-zip,explorer-files}.mjs and explorer/ into a fresh temp directory. */
async function project() {
  const dir = await mkdtemp(join(tmpdir(), "lwc-zip-"));
  await mkdir(join(dir, "deploy"));
  await cp(join(REPO, "deploy", SCRIPT), join(dir, "deploy", SCRIPT));
  await cp(join(REPO, "deploy", "explorer-files.mjs"), join(dir, "deploy", "explorer-files.mjs"));
  await cp(join(REPO, "explorer"), join(dir, "explorer"), { recursive: true });
  return dir;
}

function run(dir, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dir, "deploy", SCRIPT), ...args], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function withProject(body) {
  const dir = await project();
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Builds once and returns the archive the script wrote. */
async function buildArchive(dir) {
  const result = await run(dir);
  assert.equal(result.status, 0, result.stderr);
  return readFile(join(dir, ARCHIVE));
}

test("builds an archive, reads it back, and the rebuild is byte-identical", async () => {
  await withProject(async (dir) => {
    const first = await run(dir);

    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, new RegExp(`wrote ${ARCHIVE}: ${EXPLORER_FILES.length} files`));
    assert.match(first.stdout, /verified: every entry matches explorer\//);
    for (const name of EXPLORER_FILES) assert.ok(first.stdout.includes(name), `${name} missing from the build report`);

    const archive = await readFile(join(dir, ARCHIVE));
    assert.ok(archive.length > 0, "the archive is empty");
    assert.equal(archive.readUInt32LE(0), LOCAL_SIGNATURE, "the archive does not start with a local header");

    // A fixed DOS timestamp, so a second build of unchanged files repeats the same bytes.
    const rebuilt = await buildArchive(dir);
    assert.deepEqual(rebuilt, archive, "rebuilding unchanged files produced different bytes");

    const checked = await run(dir, "--check");
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, new RegExp(`${ARCHIVE} matches explorer/ \\(${EXPLORER_FILES.length} files\\)`));
    assert.equal(checked.stderr, "");
  });
});

test("--check passes on a machine that never built the archive", async () => {
  await withProject(async (dir) => {
    const result = await run(dir, "--check");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing to check/);
  });
});

test("--check refuses an archive that lags explorer/", async () => {
  await withProject(async (dir) => {
    await buildArchive(dir);
    await appendFile(join(dir, "explorer", "index.html"), "\n<!-- edited after the archive was built -->\n");

    const result = await run(dir, "--check");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /index\.html differs/);
    assert.match(result.stderr, /run npm run explorer:zip to rebuild it/);
  });
});

test("--check refuses a mutated archive with exit 1", async () => {
  await withProject(async (dir) => {
    const archive = Buffer.from(await buildArchive(dir));
    // Rename an entry inside the central directory only: the archive still parses, so this is the
    // "disagrees with explorer/" case rather than the unreadable one. Same length keeps every offset.
    const at = archive.lastIndexOf("index.html");
    assert.ok(at > archive.length / 2, "expected the central directory copy, not the local header");
    archive.write("indexXhtml", at);
    await writeFile(join(dir, ARCHIVE), archive);

    const result = await run(dir, "--check");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /index\.html is missing from the archive/);
    assert.match(result.stderr, /indexXhtml is in the archive but not in explorer\//);
  });
});

test("--check refuses a truncated archive with exit 2", async () => {
  await withProject(async (dir) => {
    const archive = await buildArchive(dir);
    await writeFile(join(dir, ARCHIVE), archive.subarray(0, Math.floor(archive.length / 2)));

    const result = await run(dir, "--check");

    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`cannot read ${ARCHIVE}: no end-of-central-directory record`));
    assert.match(result.stderr, /npm run explorer:zip rewrites it/);
  });
});
