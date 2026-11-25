import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHook(args: string[]): Promise<Outcome> {
  return run(process.execPath, ["scripts/pre-commit-presets.mjs", ...args], {
    env: { ...process.env, LWC_FAIL_UNDER: "95" },
  }).then(
    // Exit 0 resolves, exit 1/2 rejects; both carry the streams.
    (value) => ({ code: 0, stdout: value.stdout, stderr: value.stderr }),
    (error: unknown) => {
      const failure = error as Partial<Outcome>;
      return {
        code: failure.code ?? 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    },
  );
}

/**
 * The skip path is the one the hook is designed to be quiet about, and it used
 * to write nothing at all to stdout — which breaks a `| jq` consumer precisely
 * there. The document mirrors the check's `gate`, so `.gate.passed` always reads.
 */
test("a missing history still writes one skip document with --json", async () => {
  const outcome = await runHook([
    "--json",
    "--history",
    "no-such-history.jsonl",
  ]);

  assert.equal(outcome.code, 0);
  assert.match(outcome.stderr, /skipping the preset gate/);

  const document = JSON.parse(outcome.stdout) as {
    path: string;
    skipped: boolean;
    reason: string;
    gate: { threshold: number; passed: boolean; shortfalls: unknown[] };
  };
  assert.equal(document.path, "no-such-history.jsonl");
  assert.equal(document.skipped, true);
  assert.equal(document.reason, "no preset history yet");
  assert.equal(document.gate.threshold, 95);
  assert.equal(document.gate.passed, true);
  assert.deepEqual(document.gate.shortfalls, []);
});

test("--strict-missing writes a failed document, not an empty stream", async () => {
  const outcome = await runHook([
    "--json",
    "--strict-missing",
    "--history",
    "no-such-history.jsonl",
  ]);

  assert.equal(outcome.code, 1);

  const document = JSON.parse(outcome.stdout) as {
    skipped: boolean;
    gate: { passed: boolean };
  };
  assert.equal(document.skipped, false);
  assert.equal(document.gate.passed, false);
  assert.match(outcome.stderr, /--strict-missing was requested/);
});
