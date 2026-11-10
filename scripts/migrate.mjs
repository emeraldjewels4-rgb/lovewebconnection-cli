#!/usr/bin/env node
/**
 * Apply or roll back the SQL files in migrations/ with one command.
 *
 *   npm run migrate -- up          apply every pending *.up.sql, in order
 *   npm run migrate -- down        roll back the newest applied migration
 *   npm run migrate -- down --all  roll back everything, newest first
 *   npm run migrate -- status      list applied and pending migrations
 *   npm run migrate -- --list      show the discovered files, no database
 *
 * Needs `psql` on PATH (override with LWC_PSQL) and DATABASE_URL for anything
 * that touches the database. No npm dependency is involved.
 *
 * Each file is run exactly as written, outside an explicit transaction: the
 * Timescale statements these migrations contain (creating a continuous
 * aggregate, refreshing one) are happiest that way. A file that fails halfway
 * leaves the database partly changed and is deliberately not recorded, so fix
 * the SQL and run the command again.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const LEDGER = "schema_migrations";

/** Pair every `NNNN_slug.up.sql` with its `.down.sql`, ordered by number. */
export function discover(directory = MIGRATIONS_DIR) {
  const migrations = new Map();

  for (const file of readdirSync(directory).sort()) {
    const match = /^(\d+)_([A-Za-z0-9_]+)\.(up|down)\.sql$/.exec(file);
    if (match === null) continue;

    const [, id, slug, direction] = match;
    const key = `${id}_${slug}`;
    const entry = migrations.get(key) ?? { key, id: Number(id), slug, up: null, down: null };
    entry[direction] = join(directory, file);
    migrations.set(key, entry);
  }

  const ordered = [...migrations.values()].sort((a, b) => a.id - b.id);
  const seen = new Set();
  for (const migration of ordered) {
    if (seen.has(migration.id)) {
      throw new Error(`two migrations share the number ${migration.id}: ${migration.key}`);
    }
    seen.add(migration.id);
  }
  return ordered;
}

function usage() {
  console.log(`usage: npm run migrate -- <command>

  up            apply every pending migration, oldest first
  down          roll back the newest applied migration
  down --all    roll back every applied migration, newest first
  status        show which migrations are applied
  --list        show the files found in migrations/, without a database

Environment: DATABASE_URL (required for up, down and status), LWC_PSQL
(optional path to the psql binary).`);
}

function psql(args, capture = false) {
  const binary = process.env.LWC_PSQL ?? "psql";
  const result = spawnSync(binary, args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    encoding: "utf8",
  });

  if (result.error !== undefined) {
    throw new Error(`cannot run ${binary}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = capture ? (result.stderr ?? "").trim() : "";
    throw new Error(`${binary} exited with status ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return (result.stdout ?? "").trim();
}

function database() {
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (url === "") {
    throw new Error("DATABASE_URL is not set; point it at the database to migrate.");
  }
  return url;
}

function run(url, sql) {
  psql(["-v", "ON_ERROR_STOP=1", "-d", url, "-c", sql]);
}

function query(url, sql) {
  return psql(["-v", "ON_ERROR_STOP=1", "-d", url, "-tA", "-c", sql], true);
}

function ensureLedger(url) {
  run(
    url,
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`,
  );
}

function appliedNames(url) {
  const out = query(url, `SELECT name FROM ${LEDGER} ORDER BY name;`);
  return new Set(out === "" ? [] : out.split(/\r?\n/));
}

function literal(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function apply(url, migration) {
  if (migration.up === null) throw new Error(`${migration.key} has no .up.sql file.`);

  const started = Date.now();
  psql(["-v", "ON_ERROR_STOP=1", "-d", url, "-f", migration.up]);
  run(
    url,
    `INSERT INTO ${LEDGER} (name) VALUES (${literal(migration.key)}) ON CONFLICT (name) DO NOTHING;`,
  );
  console.log(`applied  ${migration.key} (${Date.now() - started} ms)`);
}

function revert(url, migration) {
  if (migration.down === null) {
    throw new Error(`${migration.key} has no .down.sql file; roll it back by hand.`);
  }

  const started = Date.now();
  psql(["-v", "ON_ERROR_STOP=1", "-d", url, "-f", migration.down]);
  run(url, `DELETE FROM ${LEDGER} WHERE name = ${literal(migration.key)};`);
  console.log(`reverted ${migration.key} (${Date.now() - started} ms)`);
}

export function main(argv) {
  const [command, ...rest] = argv;
  const all = rest.includes("--all");

  if (command === undefined || command === "--help" || command === "-h") {
    usage();
    return 0;
  }

  if (command === "--list") {
    const migrations = discover();
    if (migrations.length === 0) {
      console.log(`no migrations in ${MIGRATIONS_DIR}`);
      return 0;
    }
    for (const migration of migrations) {
      const up = migration.up === null ? "missing" : "yes";
      const down = migration.down === null ? "missing" : "yes";
      console.log(`${migration.key}  up:${up}  down:${down}`);
    }
    return 0;
  }

  if (command !== "up" && command !== "down" && command !== "status") {
    throw new Error(`unknown command "${command}"; run with --help for usage.`);
  }

  const migrations = discover();
  const url = database();
  ensureLedger(url);
  const applied = appliedNames(url);

  if (command === "status") {
    for (const migration of migrations) {
      console.log(`${applied.has(migration.key) ? "applied" : "pending"}  ${migration.key}`);
    }
    const unknown = [...applied].filter((name) => !migrations.some((m) => m.key === name));
    for (const name of unknown) console.log(`missing  ${name} (recorded, but no file)`);
    return 0;
  }

  if (command === "up") {
    const pending = migrations.filter((migration) => !applied.has(migration.key));
    if (pending.length === 0) {
      console.log("nothing to apply");
      return 0;
    }
    for (const migration of pending) apply(url, migration);
    return 0;
  }

  const done = migrations.filter((migration) => applied.has(migration.key));
  if (done.length === 0) {
    console.log("nothing to roll back");
    return 0;
  }

  for (const migration of all ? done.reverse() : done.slice(-1)) revert(url, migration);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`migrate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
