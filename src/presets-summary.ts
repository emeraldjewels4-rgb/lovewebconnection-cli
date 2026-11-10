import type { toPresetsJson } from "./presets.ts";

type PresetsJson = ReturnType<typeof toPresetsJson>;
type PresetEndpoint = PresetsJson["endpoints"][number];

export interface PresetsSummary {
  /** Markdown for the CI run summary. */
  markdown: string;
  /** One line per failover, escaped and ready for a ::warning:: annotation. */
  warnings: string[];
}

/** Table cells cannot hold pipes or newlines. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** GitHub decodes annotation data through these escapes. */
export function escapeAnnotation(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function failoverLine(endpoint: PresetEndpoint): string {
  return `${endpoint.preset}: primary ${endpoint.primaryHost} failed (${endpoint.primaryError ?? "unknown error"}); answered by ${endpoint.rpcHost}`;
}

/**
 * Summarize a `lwc presets --json` report for a CI run. Failovers are called out
 * by name rather than left in the `via` column, so a run that quietly fell back
 * to a backup is visible in the run history.
 */
export function summarizePresets(report: PresetsJson): PresetsSummary {
  const failovers = report.endpoints.filter(
    (endpoint) => endpoint.ok && endpoint.viaFallback,
  );
  const failures = report.endpoints.filter((endpoint) => !endpoint.ok);

  const headline =
    failovers.length === 0
      ? `**${report.healthy} of ${report.total} endpoints healthy** — every endpoint answered on its primary.`
      : `**${report.healthy} of ${report.total} endpoints healthy**, ${failovers.length} served by a backup.`;

  const rows = report.endpoints.map((endpoint) => {
    const status = endpoint.ok ? "healthy" : "failed";
    const latency =
      endpoint.ok && endpoint.latencyMs !== null ? `${endpoint.latencyMs} ms` : "—";
    const block = endpoint.blockNumber ?? "—";
    const via = endpoint.ok ? (endpoint.viaFallback ? "backup" : "primary") : "—";
    return `| \`${endpoint.preset}\` | ${endpoint.chainId} | ${endpoint.nativeSymbol} | ${status} | ${latency} | ${block} | ${via} | \`${cell(endpoint.rpcHost)}\` |`;
  });

  const lines = [
    "### Built-in preset health",
    "",
    headline,
    "",
    "| preset | chain | native | status | latency | block | via | endpoint |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ];

  if (failovers.length > 0) {
    lines.push("", "#### Failovers", "");
    for (const endpoint of failovers) {
      lines.push(
        `- \`${endpoint.preset}\` — primary \`${endpoint.primaryHost}\` failed: ${cell(endpoint.primaryError ?? "unknown error")}; answered by \`${endpoint.rpcHost}\``,
      );
    }
  }

  if (failures.length > 0) {
    lines.push("", "#### Failures", "");
    for (const endpoint of failures) {
      lines.push(
        `- \`${endpoint.preset}\` — ${cell(endpoint.error ?? "unknown error")}`,
      );
    }
  }

  return {
    markdown: lines.join("\n"),
    warnings: failovers.map((endpoint) => escapeAnnotation(failoverLine(endpoint))),
  };
}
