#!/usr/bin/env node
/**
 * Builds explorer-x10-upload.zip from explorer/, and checks an archive on disk
 * against the files it should have been built from.
 *
 *   npm run explorer:zip         rebuild the archive, then read it back
 *   npm run explorer:zip:check   compare the archive on disk with explorer/
 *
 * The archive is gitignored: it exists to be dragged into a host's file
 * manager, so the folder is the source of truth and the zip is a copy of it.
 * A copy made by hand goes stale the moment a file changes, and nothing else
 * notices - the page works from the folder, and a stale zip uploads yesterday's
 * page. Rebuilding is the fix; the check is what the pre-commit hook runs when
 * a copy happens to exist, and what the build runs on what it wrote.
 *
 * Timestamps are fixed, so the same files produce the same bytes and a rebuild
 * that changes nothing shows no diff. The archive is written with deflate, and
 * read back here rather than through an external unzip, so the check needs
 * nothing installed.
 *
 * Exit codes: 0 built and verified, or nothing to check; 1 the archive
 * disagrees with explorer/; 2 the archive could not be read as a zip.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { EXPLORER_FILES, formatBytes } from "./explorer-files.mjs";

const SOURCE_DIR = join(import.meta.dirname, "..", "explorer");
const ARCHIVE = join(import.meta.dirname, "..", "explorer-x10-upload.zip");
const ARCHIVE_NAME = "explorer-x10-upload.zip";

const USAGE = `usage: node deploy/explorer-zip.mjs [--check]

  (no option)   rebuild ${ARCHIVE_NAME} from explorer/, then read it back
  --check       compare ${ARCHIVE_NAME} with explorer/ and change nothing;
                a machine without the archive passes, because it has no stale copy
  -h, --help    this text

Rebuilds ${EXPLORER_FILES.length} files: ${EXPLORER_FILES.join(", ")}`;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

// The earliest DOS timestamp: 1980-01-01 00:00. A fixed date is what makes the
// archive reproducible instead of different on every build.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/** Thrown when the file is not a zip this reader understands. */
class ArchiveError extends Error {}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Reads the deployable files, in list order. */
async function readSources() {
  const sources = new Map();
  for (const name of EXPLORER_FILES) {
    try {
      sources.set(name, await readFile(join(SOURCE_DIR, name)));
    } catch {
      throw new Error(`explorer/${name} is missing, so the archive would be incomplete`);
    }
  }
  return sources;
}

/** Writes a deflated archive whose local and central headers agree. */
function pack(sources) {
  const parts = [];
  const directory = [];
  let offset = 0;

  for (const [name, data] of sources) {
    const fileName = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data);
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0, 6); // flags: sizes are known, so no data descriptor
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    parts.push(local, fileName, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // rw-r--r--
    central.writeUInt32LE(offset, 42);
    directory.push(central, fileName);

    offset += local.length + fileName.length + packed.length;
  }

  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(sources.size, 8);
  end.writeUInt16LE(sources.size, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no comment

  return Buffer.concat([...parts, centralDirectory, end]);
}

/** Reads an archive back, so the check reads the file rather than its inputs. */
function unpack(archive) {
  let end = -1;
  const floor = Math.max(0, archive.length - 22 - 0xffff);
  for (let at = archive.length - 22; at >= floor; at -= 1) {
    if (archive.readUInt32LE(at) === END_SIGNATURE) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ArchiveError("no end-of-central-directory record");

  const count = archive.readUInt16LE(end + 10);
  const start = archive.readUInt32LE(end + 16);
  const entries = [];
  let at = start;

  for (let index = 0; index < count; index += 1) {
    if (at + 46 > archive.length || archive.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new ArchiveError("the central directory is damaged");
    }
    const method = archive.readUInt16LE(at + 10);
    const checksum = archive.readUInt32LE(at + 16);
    const packedSize = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const localOffset = archive.readUInt32LE(at + 42);
    const name = archive.toString("utf8", at + 46, at + 46 + nameLength);

    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new ArchiveError(`${name} has no local header`);
    }
    const dataAt =
      localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const raw = archive.subarray(dataAt, dataAt + packedSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new ArchiveError(`${name} uses compression method ${method}, which this check cannot read`);

    if (crc32(data) !== checksum) throw new ArchiveError(`${name} is corrupt`);
    entries.push({ name, data });

    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** What the archive gets wrong, one line each. Empty means it matches. */
function compare(sources, entries) {
  const problems = [];
  const found = new Map(entries.map((entry) => [entry.name, entry]));
  for (const [name, data] of sources) {
    const entry = found.get(name);
    if (!entry) {
      problems.push(`${name} is missing from the archive`);
      continue;
    }
    found.delete(name);
    if (!entry.data.equals(data)) {
      problems.push(`${name} differs (${entry.data.length} bytes in the archive, ${data.length} in explorer/)`);
    }
  }
  for (const name of found.keys()) problems.push(`${name} is in the archive but not in explorer/`);
  return problems;
}

async function build(sources) {
  const archive = pack(sources);
  await writeFile(ARCHIVE, archive);
  const problems = compare(sources, unpack(await readFile(ARCHIVE)));
  if (problems.length > 0) {
    throw new Error(`the archive just written does not read back: ${problems.join("; ")}`);
  }
  console.log(`wrote ${ARCHIVE_NAME}: ${sources.size} files, ${formatBytes(archive.length)}`);
  for (const [name, data] of sources) {
    console.log(`  ${name.padEnd(16)} ${formatBytes(data.length).padStart(8)}`);
  }
  console.log("verified: every entry matches explorer/");
}

async function check(sources) {
  let archive;
  try {
    archive = await readFile(ARCHIVE);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`no ${ARCHIVE_NAME} here; nothing to check (npm run explorer:zip builds one)`);
      return;
    }
    throw error;
  }

  const problems = compare(sources, unpack(archive));
  if (problems.length === 0) {
    console.log(`${ARCHIVE_NAME} matches explorer/ (${sources.size} files)`);
    return;
  }
  console.error(`${ARCHIVE_NAME} disagrees with explorer/:`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("run npm run explorer:zip to rebuild it");
  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const unknown = args.find((argument) => argument !== "--check");
  if (unknown) {
    console.error(`error: unknown option '${unknown}'`);
    console.error("run with --help for the options");
    process.exitCode = 2;
    return;
  }

  const sources = await readSources();
  if (args.includes("--check")) await check(sources);
  else await build(sources);
}

main().catch((error) => {
  if (error instanceof ArchiveError) {
    console.error(`cannot read ${ARCHIVE_NAME}: ${error.message}`);
    console.error("npm run explorer:zip rewrites it");
    process.exitCode = 2;
    return;
  }
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
