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

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs the CLI in an empty directory with every LWC_ variable removed, so a
 * developer's own .env or shell exports cannot supply the chain that the test
 * is trying to withhold.
 */
async function invokeCli(args: string[]): Promise<CliResult> {
  const cwd = await mkdtemp(join(tmpdir(), "lwc-cli-"));
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("LWC_")) env[key] = value;
    }
    try {
      const { stdout, stderr } = await run(process.execPath, [cli, ...args], { cwd, env });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        code: failure.code ?? 1,
      };
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Same as invokeCli, but a non-zero exit fails the test with what was printed. */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await invokeCli(args);
  assert.equal(
    result.code,
    0,
    `lwc ${args.join(" ")} exited ${result.code}: ${result.stderr}`,
  );
  return { stdout: result.stdout, stderr: result.stderr };
}

/** The command list straight from `lwc --help`, so the test cannot drift from it. */
async function commandsFromHelp(): Promise<string[]> {
  const { stdout } = await runCli(["--help"]);
  const block = stdout.split("\ncommands:\n")[1]?.split("\n\n")[0] ?? "";
  const names = block
    .split("\n")
    .map((line) => /^ {2}([a-z][a-z-]*) +\S/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);

  assert.ok(names.length >= 18, `parsed only ${names.length} commands from --help`);
  assert.ok(names.includes("market"), "the last command is missing from --help");
  return names;
}

test("--help answers on a host with no chain configured", async () => {
  const { stdout } = await runCli(["--help"]);

  assert.match(stdout, /usage: lwc <command> \[options\]/);
  assert.match(stdout, /--chain <name\|id>/);
  assert.match(stdout, /balances +read native and ERC-20 balances/);
  assert.match(stdout, /lwc <command> --help/);
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

test("every command answers a trailing --help with its own usage", async () => {
  for (const command of await commandsFromHelp()) {
    const { stdout, stderr } = await runCli([command, "--help"]);

    assert.match(stdout, new RegExp(`^lwc ${command} — `), `${command} heading`);
    assert.match(stdout, new RegExp(`usage: lwc ${command}\\b`), `${command} usage`);
    assert.match(stdout, /global options:/, `${command} global options`);
    assert.match(stdout, /README: /, `${command} README pointer`);
    assert.equal(stderr, "", `${command} wrote to stderr`);
  }
});

test("a command's help lists its own flags and its README section", async () => {
  const { stdout } = await runCli(["balances", "--help"]);

  assert.match(stdout, /usage: lwc balances <owner> \[options\]/);
  assert.match(stdout, /--tokens-file <path> +JSON token list/);
  assert.match(stdout, /--fail-on-retry +exit 1 when a chunk needed recovery/);
  assert.match(stdout, /README: Balances — README\.md#balances/);
});

test("a command's help does not ask for the chain config", async () => {
  const { stdout, stderr } = await runCli(["market", "--help"]);

  assert.match(stdout, /usage: lwc market --pool <path>/);
  assert.match(stdout, /README: Fixed-price market — README\.md#fixed-price-market/);
  assert.doesNotMatch(stderr, /config error|LWC_CHAIN_ID/);
});

test("help <command> prints the same page as <command> --help", async () => {
  const named = await runCli(["help", "scan"]);
  const flagged = await runCli(["scan", "--help"]);

  assert.equal(named.stdout, flagged.stdout);
});

test("a trailing --help does not excuse an unknown command", async () => {
  const result = await invokeCli(["nope", "--help"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown command: nope/);
});

test("the usage line and the help body name the same commands", async () => {
  const names = await commandsFromHelp();
  const result = await invokeCli(["nope"]);

  assert.equal(result.code, 1);
  const listed = /usage: lwc \[([a-z|-]+)\]/.exec(result.stderr)?.[1] ?? "";
  assert.deepEqual(listed.split("|"), names);
});
