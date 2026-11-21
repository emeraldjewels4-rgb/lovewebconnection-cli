import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

/**
 * Runs the CLI in an empty directory with every LWC_ variable removed, so a
 * developer's own .env or shell exports cannot supply the chain that the test
 * is trying to withhold.
 */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "lwc-cli-"));
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("LWC_")) env[key] = value;
    }
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { cwd, env });
    return { stdout, stderr };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("--help answers on a host with no chain configured", async () => {
  const { stdout } = await runCli(["--help"]);

  assert.match(stdout, /usage: lwc <command> \[options\]/);
  assert.match(stdout, /--chain <name\|id>/);
  assert.match(stdout, /balances +read native and ERC-20 balances/);
});

test("-h prints the same help", async () => {
  const short = await runCli(["-h"]);
  const long = await runCli(["--help"]);

  assert.equal(short.stdout, long.stdout);
});

test("help is a command, not an unknown one", async () => {
  const { stdout, stderr } = await runCli(["help"]);

  assert.match(stdout, /usage: lwc <command>/);
  assert.equal(stderr, "");
});
