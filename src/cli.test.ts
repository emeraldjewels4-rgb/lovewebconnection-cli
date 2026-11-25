import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

/**
 * Where each command's own flags are parsed. `chain` and `example` are absent because neither has
 * flags of its own. This table is the binding the two tests below rely on, so a new command with
 * flags has to be added here before it can pass.
 */
const COMMAND_MODULES: Record<string, string> = {
  presets: "presets.ts",
  "presets-history": "presets-history.ts",
  balances: "balances.ts",
  tokens: "tokenfile.ts",
  views: "views.ts",
  signatures: "signatures.ts",
  call: "call.ts",
  scan: "scan.ts",
  compare: "compare.ts",
  "compare-history": "compare-history.ts",
  watch: "watch.ts",
  sessions: "sessions.ts",
  history: "history.ts",
  plot: "plot.ts",
  cache: "cache.ts",
  market: "market.ts",
};

/** Answered by the CLI for every command, so they are never a command's own flag. */
const GLOBAL_FLAGS = new Set([
  "--chain",
  "--json",
  "--cache-file",
  "--refresh-cache",
  "--no-cache",
  "--help",
]);

/** The flags in a command's `options:` block; the global block below it is skipped. */
function helpFlags(stdout: string): string[] {
  const flags: string[] = [];
  let inOwnBlock = false;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "options:") {
      inOwnBlock = true;
      continue;
    }
    if (line.trim() === "global options:") {
      inOwnBlock = false;
      continue;
    }
    const flag = inOwnBlock ? /^ {2}(--[a-z][a-z0-9-]*)/.exec(line)?.[1] : undefined;
    if (flag) flags.push(flag);
  }
  return flags;
}

/**
 * The flags a parser source decides on, so a flag merely named in a comment does not count. The
 * forms are the ones these parsers use: equality against a flag, a `startsWith` for its `=value`
 * form, `includes` for a flag answered in the CLI (`watch --stop`), a `case`, and the `= "--flag"`
 * default of a variable.
 */
function parsedFlags(source: string): Set<string> {
  const flags = new Set<string>();
  for (const match of source.matchAll(/(?:===|startsWith\(|includes\(|case |=)\s*["'`](--[a-z][a-z0-9-]*)/g)) {
    const flag = match[1];
    if (flag) flags.add(flag);
  }
  return flags;
}

async function sourceOf(module: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`./${module}`, import.meta.url)), "utf8");
}

// The help table in cli.ts repeats every flag description by hand, so it can describe a flag a
// parser no longer takes (or never took), and it can fall behind a flag a parser gained. Both
// directions are checked here against the parser sources themselves, because the parsers disagree
// about unknown flags - balances and market reject one, plot and signatures ignore it - so probing
// from the outside cannot tell "accepted" from "ignored".
const cliSource = fileURLToPath(new URL("./cli.ts", import.meta.url));

test("each command's help flags and its parser agree, both ways", async () => {
  const cli = await readFile(cliSource, "utf8");
  const problems: string[] = [];

  for (const [command, module] of Object.entries(COMMAND_MODULES)) {
    const { stdout } = await runCli([command, "--help"]);
    const moduleSource = await sourceOf(module);
    // `signatures` has no flags of its own, so an empty block is not a problem by itself.
    const documented = helpFlags(stdout);

    // cli.ts counts for the first direction because a few flags are answered there, `watch --stop`
    // among them; it is left out of the second because it names other commands' flags too.
    const accepted = parsedFlags(`${moduleSource}\n${cli}`);
    for (const flag of documented) {
      if (GLOBAL_FLAGS.has(flag)) continue;
      if (!accepted.has(flag)) problems.push(`${command}: help lists ${flag}, but ${module} does not parse it`);
    }

    const listed = new Set(documented);
    for (const flag of parsedFlags(moduleSource)) {
      if (GLOBAL_FLAGS.has(flag)) continue;
      if (!listed.has(flag)) problems.push(`${module} parses ${flag}, but lwc ${command} --help does not list it`);
    }
  }

  assert.deepEqual(problems, [], `help and the parsers disagree:\n  ${problems.join("\n  ")}`);
});

test("every command that has its own flags has a parser module in the check", async () => {
  const names = await commandsFromHelp();
  assert.deepEqual(
    names.filter((name) => !(name in COMMAND_MODULES) && name !== "chain" && name !== "example"),
    [],
    "these commands are missing from COMMAND_MODULES, so their flags go unchecked",
  );
});
