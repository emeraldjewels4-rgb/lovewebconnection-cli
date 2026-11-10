import assert from "node:assert/strict";
import { test } from "node:test";

import type { toPresetsJson } from "./presets.ts";
import { escapeAnnotation, summarizePresets } from "./presets-summary.ts";

type PresetsJson = ReturnType<typeof toPresetsJson>;
type PresetEndpoint = PresetsJson["endpoints"][number];

function endpoint(overrides: Partial<PresetEndpoint> = {}): PresetEndpoint {
  return {
    preset: "base",
    chainId: 8453,
    nativeSymbol: "ETH",
    rpcHost: "mainnet.base.org",
    primaryHost: "mainnet.base.org",
    viaFallback: false,
    primaryError: null,
    ok: true,
    latencyMs: 120,
    blockNumber: "55435654",
    error: null,
    ...overrides,
  };
}

test("a healthy run says every endpoint used its primary", () => {
  const summary = summarizePresets({
    total: 1,
    healthy: 1,
    failed: 0,
    endpoints: [endpoint()],
  });

  assert.match(summary.markdown, /^### Built-in preset health/);
  assert.match(summary.markdown, /\*\*1 of 1 endpoints healthy\*\* — every endpoint answered on its primary\./);
  assert.match(
    summary.markdown,
    /\| `base` \| 8453 \| ETH \| healthy \| 120 ms \| 55435654 \| primary \| `mainnet\.base\.org` \|/,
  );
  assert.ok(!summary.markdown.includes("#### Failovers"));
  assert.deepEqual(summary.warnings, []);
});

test("a failover is named in the summary and annotated", () => {
  const summary = summarizePresets({
    total: 2,
    healthy: 2,
    failed: 0,
    endpoints: [
      endpoint(),
      endpoint({
        preset: "ethereum",
        chainId: 1,
        rpcHost: "cloudflare-eth.com",
        primaryHost: "ethereum-rpc.publicnode.com",
        viaFallback: true,
        primaryError: "HTTP request failed.",
      }),
    ],
  });

  assert.match(summary.markdown, /\*\*2 of 2 endpoints healthy\*\*, 1 served by a backup\./);
  assert.match(
    summary.markdown,
    /\| `ethereum` \| 1 \| ETH \| healthy \| 120 ms \| 55435654 \| backup \| `cloudflare-eth\.com` \|/,
  );
  assert.match(summary.markdown, /#### Failovers/);
  assert.match(
    summary.markdown,
    /- `ethereum` — primary `ethereum-rpc\.publicnode\.com` failed: HTTP request failed\.; answered by `cloudflare-eth\.com`/,
  );

  assert.equal(summary.warnings.length, 1);
  assert.equal(
    summary.warnings[0],
    "ethereum: primary ethereum-rpc.publicnode.com failed (HTTP request failed.); answered by cloudflare-eth.com",
  );
});

test("a dead endpoint is a failure, not a failover", () => {
  const summary = summarizePresets({
    total: 2,
    healthy: 1,
    failed: 1,
    endpoints: [
      endpoint({
        ok: false,
        latencyMs: null,
        blockNumber: null,
        error: "both endpoints failed for base (8453): primary down; backup down",
      }),
      endpoint({ preset: "xlayer", chainId: 196, rpcHost: "xlayer.drpc.org", primaryHost: "xlayer.drpc.org" }),
    ],
  });

  assert.match(summary.markdown, /\*\*1 of 2 endpoints healthy\*\* — every endpoint answered on its primary\./);
  assert.match(summary.markdown, /\| `base` \| 8453 \| ETH \| failed \| — \| — \| — \| `mainnet\.base\.org` \|/);
  assert.match(summary.markdown, /#### Failures/);
  assert.ok(!summary.markdown.includes("#### Failovers"));
  assert.deepEqual(summary.warnings, [], "a failure is already reported by the exit code");
});

test("table cells escape pipes and newlines", () => {
  const summary = summarizePresets({
    total: 1,
    healthy: 0,
    failed: 1,
    endpoints: [
      endpoint({
        ok: false,
        latencyMs: null,
        blockNumber: null,
        error: "a | b\nnext line",
      }),
    ],
  });

  assert.match(summary.markdown, /a \\\| b next line/);
});

test("annotation data escapes percent and newlines", () => {
  assert.equal(escapeAnnotation("50% done"), "50%25 done");
  assert.equal(escapeAnnotation("line\nnext"), "line%0Anext");
  assert.equal(escapeAnnotation("carriage\rreturn"), "carriage%0Dreturn");
  assert.equal(escapeAnnotation("plain"), "plain");

  const summary = summarizePresets({
    total: 1,
    healthy: 1,
    failed: 0,
    endpoints: [
      endpoint({
        viaFallback: true,
        rpcHost: "base-rpc.publicnode.com",
        primaryError: "100% failed\nretry later",
      }),
    ],
  });

  assert.match(summary.warnings[0] ?? "", /100%25 failed%0Aretry later/);
  assert.ok(!(summary.warnings[0] ?? "").includes("\n"), "an annotation is one line");
});
