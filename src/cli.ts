#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  BalancesArgError,
  checkTokenAddressesReport,
  formatBalances,
  formatChunkProgress,
  parseBalanceArgs,
  readBalances,
  shortAddress,
  staleMetadataWarnings,
  toBalancesJson,
} from "./balances.ts";
import {
  ChainConfigError,
  ChainMismatchError,
  buildClient,
  connectionWarnings,
  formatHealth,
  parseChainConfig,
  probeWithFallback,
  publicEndpoint,
  toJsonPayload,
} from "./chain.ts";
import {
  assertContractChain,
  formatExampleCall,
  readExampleCall,
  toExampleCallJson,
} from "./contract.ts";
import {
  CallArgError,
  callViewFunction,
  coerceArgs,
  findFunction,
  formatCall,
  parseCallArgs,
  resolveAbi,
  toCallJson,
} from "./call.ts";
import {
  SignaturesArgError,
  callableSignatures,
  formatSignatures,
  parseSignaturesArgs,
  toSignaturesJson,
} from "./signatures.ts";
import {
  CompareArgError,
  compareEndpoints,
  formatCompare,
  parseCompareArgs,
  toCompareJson,
  toCompareLogRecord,
} from "./compare.ts";
import { MetadataCache, resolveCachePath } from "./metadata-cache.ts";
import {
  CacheArgError,
  formatMetadataCache,
  inspectMetadataCache,
  parseCacheArgs,
  toCacheJson,
} from "./cache.ts";
import { AlertQueue } from "./alert-queue.ts";
import { AlertStore, resolveAlertQueuePath } from "./alert-store.ts";
import { RotatingLog } from "./rotate.ts";
import { postWebhook } from "./webhook.ts";
import {
  SessionsArgError,
  formatSessions,
  parseSessionsArgs,
  readWatchLog,
  saveSessionsCsv,
  sessionsCsv,
  summarizeWatchLog,
  toSessionsJson,
} from "./sessions.ts";
import {
  HistoryArgError,
  extractBalanceHistory,
  formatHistory,
  historyCsv,
  historyWideCsv,
  parseHistoryArgs,
  readHistoryLog,
  saveHistoryCsv,
  toHistoryJson,
} from "./history.ts";
import {
  PlotArgError,
  buildPlotReport,
  formatPlot,
  parsePlotArgs,
  readHistoryCsv,
  toPlotJson,
} from "./plot.ts";
import {
  CompareHistoryArgError,
  compareHistoryCsv,
  formatCompareHistory,
  parseCompareHistoryArgs,
  readCompareLog,
  saveCompareHistoryCsv,
  summarizeCompareLog,
  toCompareHistoryJson,
} from "./compare-history.ts";
import {
  TokenFileArgError,
  parseTokenFileArgs,
  saveTokenList,
  tokenListItems,
} from "./tokenfile.ts";
import {
  ViewsArgError,
  formatViews,
  parseViewsArgs,
  runViewFunctions,
  toViewsJson,
} from "./views.ts";
import {
  ScanArgError,
  formatScan,
  parseScanArgs,
  scanBalances,
  scanCsv,
  toScanJson,
} from "./scan.ts";
import {
  WatchArgError,
  formatWatchEvent,
  formatWatchSummary,
  parseWatchArgs,
  toWatchEventJson,
  toWatchSummaryJson,
  watchChain,
} from "./watch.ts";
import {
  MarketArgError,
  MarketError,
  MarketPool,
  type LiquidityReceipt,
  fixedPrice,
  formatLiquidity,
  formatMarketAmount,
  formatMarketState,
  formatSwapQuote,
  loadPoolFile,
  parseMarketAmount,
  parseMarketArgs,
  parseShares,
  savePoolFile,
  toMarketJson,
  toSwapQuoteJson,
} from "./market.ts";
import { MarketServer } from "./market-server.ts";
import {
  PresetsArgError,
  formatPresets,
  parsePresetsArgs,
  probePresets,
  toPresetsJson,
} from "./presets.ts";
import {
  PresetsHistoryArgError,
  appendPresetHistory,
  comparePresetHistory,
  formatPresetHistory,
  formatPresetHistoryComparison,
  mergePresetHistory,
  parsePresetHistoryArgs,
  presetHistoryCsv,
  presetHistoryTimelineCsv,
  presetsBelowUptime,
  narrowestRetentionMs,
  readPresetHistoryFile,
  retentionWindowWarnings,
  savePresetHistory,
  savePresetHistoryCsv,
  summarizePresetHistory,
  toPresetHistoryJson,
} from "./presets-history.ts";

const argv = process.argv.slice(2);
const command = argv[0] ?? "";
const isBalances = command === "balances";
const isExample = command === "example";
const isWatch = command === "watch";
const isCall = command === "call";
const isScan = command === "scan";
const isCompare = command === "compare";
const isTokens = command === "tokens";
const isViews = command === "views";
const isSessions = command === "sessions";
const isHistory = command === "history";
const isCompareHistory = command === "compare-history";
const isPlot = command === "plot";
const isSignatures = command === "signatures";
const isCache = command === "cache";
const isMarket = command === "market";
const isPresets = command === "presets";
const isPresetHistory = command === "presets-history";
const isHealth = command === "" || command === "chain" || command.startsWith("-");

if (
  !isHealth &&
  !isBalances &&
  !isTokens &&
  !isViews &&
  !isExample &&
  !isWatch &&
  !isCall &&
  !isScan &&
  !isCompare &&
  !isSessions &&
  !isHistory &&
  !isCompareHistory &&
  !isSignatures &&
  !isCache &&
  !isMarket &&
  !isPresets &&
  !isPresetHistory &&
  !isPlot
) {
  console.error(`unknown command: ${command}`);
  console.error(
    "usage: lwc [chain|presets|presets-history|balances|tokens|views|signatures|example|scan|compare|compare-history|watch|call|sessions|history|plot|cache|market] [--chain <name|id>] [--json]",
  );
  process.exit(1);
}

/** The `--chain <name|id>` selector, or null when it was not passed. */
function chainFlagValue(args: string[]): string | null {
  const inline = args.find((arg) => arg.startsWith("--chain="));
  if (inline) return inline.slice("--chain=".length).trim() || null;
  const index = args.indexOf("--chain");
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith("-") ? value : null;
}

/** Remove the global --chain flag so per-command parsers never see it. */
function stripChainFlag(args: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--chain") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--chain=")) continue;
    kept.push(arg);
  }
  return kept;
}

const chainOverride = chainFlagValue(argv);
const flags = stripChainFlag(isHealth ? argv : argv.slice(1));
const asJson = flags.includes("--json");

// Probes the built-in presets themselves, so it needs no configuration.
if (isPresets) {
  try {
    const { timeoutMs, historyPath } = parsePresetsArgs(flags);
    const report = await probePresets({ timeoutMs });
    console.log(
      asJson ? JSON.stringify(toPresetsJson(report), null, 2) : formatPresets(report),
    );
    // Recorded after the report is printed: a read-only history file must not
    // hide the probe's result or change its exit code.
    if (historyPath !== null) {
      try {
        appendPresetHistory(historyPath, report);
      } catch (error) {
        console.error(
          `warning: could not record history at ${historyPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // Non-zero when an endpoint is unhealthy, so scripts and CI can gate on it.
    process.exit(report.failed === 0 ? 0 : 1);
  } catch (error) {
    if (error instanceof PresetsArgError) {
      console.error(`usage error: ${error.message}`);
      console.error("  example: lwc presets --timeout 5000");
    } else {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}

// Local-only: reads the runs recorded by `lwc presets --history`.
if (isPresetHistory) {
  let historyPath = "";
  try {
    const args = parsePresetHistoryArgs(flags);
    historyPath = args.path;
    const primary = readPresetHistoryFile(historyPath);
    const records = primary.records;
    // --merge folds other copies in before anything reads them, so a window,
    // a gate and an export all judge the same combined record.
    const extras = args.merge.map((path) => {
      try {
        return readPresetHistoryFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          throw new PresetsHistoryArgError(`no history at ${path} to merge.`);
        }
        throw error;
      }
    });
    const merged =
      extras.length === 0
        ? null
        : mergePresetHistory(
            [records, ...extras.map((file) => file.records)],
            { retainMs: args.retain },
          );
    const history = merged === null ? records : merged.records;
    // What the files say they trimmed to, before this invocation adds its own.
    const declaredRetain = narrowestRetentionMs([
      primary.retainMs,
      ...extras.map((file) => file.retainMs),
    ]);

    // Notes go to stderr so --json on stdout stays one parseable document.
    if (merged !== null) {
      const dropped =
        merged.duplicates === 0
          ? ""
          : `, ${merged.duplicates} duplicate${merged.duplicates === 1 ? "" : "s"} dropped`;
      const pruned =
        merged.pruned === 0
          ? ""
          : `, ${merged.pruned} older run${merged.pruned === 1 ? "" : "s"} pruned`;
      console.error(
        `merged ${history.length} run${history.length === 1 ? "" : "s"} from ${merged.counts.length} file${merged.counts.length === 1 ? "" : "s"}${dropped}${pruned}`,
      );
    }
    // A file records the retention it was written with, so a later read can
    // still explain a window it cannot cover; a --retain that just pruned is
    // the tighter of the two. Without either, missing runs are not our doing.
    const readRetain = narrowestRetentionMs([
      declaredRetain,
      merged !== null && merged.pruned > 0 ? args.retain : null,
    ]);
    for (const warning of retentionWindowWarnings(
      history.at(-1)?.at ?? null,
      readRetain,
      [
        { label: "--since", since: args.since },
        { label: "--compare", since: args.compare?.since ?? null },
      ],
    )) {
      console.error(`warning: ${warning}`);
    }
    if (args.out !== null) {
      savePresetHistory(args.out, history, { retainMs: args.retain ?? declaredRetain });
      console.error(`wrote ${history.length} runs → ${args.out}`);
    }

    const summary = summarizePresetHistory(
      history,
      { since: args.since, until: args.until, limit: args.limit },
      { retainMs: declaredRetain },
    );
    const comparison =
      args.compare === null
        ? null
        : comparePresetHistory(
            history,
            { since: args.since, until: args.until },
            args.compare,
          );

    if (args.timelinePath !== null) {
      const csv = presetHistoryTimelineCsv(history, {
        since: args.since,
        until: args.until,
        limit: args.limit,
      });
      if (args.timelinePath === "-") {
        console.log(csv);
      } else {
        savePresetHistoryCsv(args.timelinePath, csv);
        const rows = csv.split("\n").length - 1;
        console.log(`wrote ${rows} row${rows === 1 ? "" : "s"} → ${args.timelinePath}`);
      }
    } else if (args.csvPath !== null) {
      const csv = presetHistoryCsv(summary);
      if (args.csvPath === "-") {
        console.log(csv);
      } else {
        savePresetHistoryCsv(args.csvPath, csv);
        const rows = summary.presets.length;
        console.log(`wrote ${rows} row${rows === 1 ? "" : "s"} → ${args.csvPath}`);
      }
    } else {
      console.log(
        comparison === null
          ? asJson
            ? JSON.stringify(toPresetHistoryJson(summary), null, 2)
            : formatPresetHistory(summary)
          : asJson
            ? JSON.stringify(comparison, null, 2)
            : formatPresetHistoryComparison(comparison),
      );
    }
    // --fail-under is a CI gate over the selected window, not a display option:
    // an empty window cannot be shown to clear it.
    if (args.failUnder !== null) {
      if (summary.runs === 0) {
        console.error(
          `error: no runs in the window to check against --fail-under ${args.failUnder}%.`,
        );
        process.exit(1);
      }
      const shortfalls = presetsBelowUptime(summary, args.failUnder);
      for (const row of shortfalls) {
        console.error(
          `error: ${row.preset} uptime ${row.uptimePct}% over ${row.runs} run${row.runs === 1 ? "" : "s"} is below --fail-under ${args.failUnder}%.`,
        );
      }
      process.exit(shortfalls.length === 0 ? 0 : 1);
    }
    process.exit(0);
  } catch (error) {
    if (error instanceof PresetsHistoryArgError) {
      console.error(`usage error: ${error.message}`);
      console.error("  example: lwc presets-history .lwc-history/presets.jsonl --json");
    } else if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      console.error(`usage error: no history at ${historyPath || "(no path)"}.`);
      console.error(
        "  record runs first: lwc presets --history .lwc-history/presets.jsonl",
      );
    } else {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}

// Local-only: listing an ABI's signatures needs no RPC configuration.
if (isSignatures) {
  try {
    const { abiPath } = parseSignaturesArgs(flags);
    const { abi, source } = resolveAbi(abiPath);
    const signatures = callableSignatures(abi);
    console.log(
      asJson
        ? JSON.stringify(toSignaturesJson(signatures, source), null, 2)
        : formatSignatures(signatures, source),
    );
  } catch (error) {
    if (error instanceof SignaturesArgError || error instanceof CallArgError) {
      console.error(`usage error: ${error.message}`);
      console.error("  example: lwc signatures ./examples/erc20.abi.json");
    } else {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

// Local-only: the market is a pool file, not chain state, so it needs no RPC.
if (isMarket) {
  try {
    const args = parseMarketArgs(flags);

    if (args.serve !== null) {
      const pool = loadPoolFile(args.poolPath);
      const server = new MarketServer(pool, args.poolPath, args.serve);
      const info = await server.listen();
      const state = pool.state();

      if (asJson) {
        console.log(
          JSON.stringify({ listening: info.url, ...toMarketJson(state, args.poolPath) }, null, 2),
        );
      } else {
        console.log("lwc — market api");
        console.log("");
        console.log(`  pool          ${args.poolPath}`);
        console.log(`  listening     ${info.url}`);
        console.log(
          `  price         ${state.price} ${state.quoteSymbol} per ${state.baseSymbol} (fixed)`,
        );
        console.log(
          `  liquidity     ${formatMarketAmount(state.liquidityValueQuote, state.quoteDecimals)} ${state.quoteSymbol}`,
        );
        if (args.serve.corsOrigins.length > 0) {
          console.log(`  cors          ${args.serve.corsOrigins.join(", ")}`);
        }
        const rateLimit = args.serve.rateLimitPerMinute ?? 120;
        console.log(
          `  rate limit    ${
            rateLimit === 0 ? "off" : `${rateLimit} requests/min per client`
          }`,
        );
        console.log(`  limits        ${args.serve.limitsPath ?? "in memory"}`);
        if (args.serve.accessKey !== null) {
          console.log("  access key    required (x-market-key header, ?key=, or bearer)");
        } else if (!["127.0.0.1", "localhost", "::1"].includes(args.serve.host)) {
          console.log(`  access        OPEN — anyone who reaches ${args.serve.host} can swap`);
        }
        console.log("");
        console.log("  GET  /           swap page (open in a browser)");
        console.log("  GET  /quote?side=buy&amount=1");
        console.log('  POST /swap  {"side":"buy","amount":"1"}');
        console.log("");
        console.log("  Ctrl+C stops the api.");
      }

      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => resolve());
        process.once("SIGTERM", () => resolve());
      });
      await server.close();
      if (!asJson) console.log("\nmarket api stopped.");
      process.exit(0);
    }

    if (args.init !== null) {
      const init = args.init;
      const price = fixedPrice(init.price, init.baseDecimals, init.quoteDecimals);
      const pool = MarketPool.create(
        {
          baseSymbol: init.baseSymbol,
          quoteSymbol: init.quoteSymbol,
          baseDecimals: init.baseDecimals,
          quoteDecimals: init.quoteDecimals,
          priceNum: price.num,
          priceDen: price.den,
          feeBps: init.feeBps,
        },
        parseMarketAmount(init.seed, init.quoteDecimals, "--seed"),
      );
      savePoolFile(args.poolPath, pool, { force: args.force });
      const state = pool.state();
      console.log(
        asJson
          ? JSON.stringify({ created: true, ...toMarketJson(state, args.poolPath) }, null, 2)
          : formatMarketState(state, args.poolPath),
      );
      process.exit(0);
    }

    const pool = loadPoolFile(args.poolPath);
    const before = pool.state();
    const operation = args.operation;

    if (operation.kind === "state") {
      console.log(
        asJson
          ? JSON.stringify(toMarketJson(before, args.poolPath), null, 2)
          : formatMarketState(before, args.poolPath),
      );
      process.exit(0);
    }

    if (operation.kind === "swap") {
      const isBuy = operation.side === "buy";
      const amount = parseMarketAmount(
        operation.amount,
        isBuy ? before.quoteDecimals : before.baseDecimals,
        isBuy ? "--buy" : "--sell",
      );

      if (args.dryRun) {
        const quote = pool.quote(operation.side, amount);
        console.log(
          asJson
            ? JSON.stringify(toSwapQuoteJson(quote, before), null, 2)
            : formatSwapQuote(quote, before),
        );
        process.exit(quote.executable ? 0 : 1);
      }

      const fill = pool.swap(operation.side, amount);
      savePoolFile(args.poolPath, pool, { force: true });
      const after = pool.state();
      if (asJson) {
        console.log(
          JSON.stringify(
            { ...toSwapQuoteJson(fill, after), state: toMarketJson(after, args.poolPath) },
            null,
            2,
          ),
        );
      } else {
        console.log(formatSwapQuote(fill, after, { applied: true }));
        console.log("");
        console.log(
          `  volume        ${formatMarketAmount(after.volumeQuote, after.quoteDecimals)} ${after.quoteSymbol} over ${after.swaps} swap${after.swaps === 1 ? "" : "s"}`,
        );
      }
      process.exit(0);
    }

    let receipt: LiquidityReceipt;
    if (operation.remove !== null) {
      const shares = operation.remove === "all" ? before.shares : parseShares(operation.remove);
      if (shares === 0n) throw new MarketArgError("the pool has no shares to remove.");
      receipt = pool.removeLiquidity(shares);
    } else {
      const quoteIn =
        operation.quote === null
          ? 0n
          : parseMarketAmount(operation.quote, before.quoteDecimals, "--add");
      const baseIn =
        operation.base === null
          ? 0n
          : parseMarketAmount(operation.base, before.baseDecimals, "--add-base");
      receipt = pool.addLiquidity({ quote: quoteIn, base: baseIn });
    }

    savePoolFile(args.poolPath, pool, { force: true });
    const after = pool.state();
    console.log(
      asJson
        ? JSON.stringify(
            {
              kind: receipt.kind,
              base: receipt.base.toString(),
              quote: receipt.quote.toString(),
              shares: receipt.shares.toString(),
              sharesAfter: receipt.sharesAfter.toString(),
              state: toMarketJson(after, args.poolPath),
            },
            null,
            2,
          )
        : `${formatLiquidity(receipt, after)}\n\n${formatMarketState(after, args.poolPath)}`,
    );
    process.exit(0);
  } catch (error) {
    if (error instanceof MarketArgError) {
      console.error(`usage error: ${error.message}`);
      console.error(
        "  example: lwc market --pool ./market.json --init --price 28.842 --base ZPC --quote AUD --seed 1",
      );
      console.error("  then:    lwc market --pool ./market.json --buy 10");
    } else if (error instanceof MarketError) {
      console.error(`market error: ${error.message}`);
    } else {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
}

// Local-only: reading a watch log needs no RPC configuration, so this runs
// before .env is loaded and before the chain config is validated.
if (isSessions) {
  try {
    const { path, since, sessionPrefixes, csvPath } = parseSessionsArgs(flags);
    const report = {
      path,
      ...summarizeWatchLog(readWatchLog(path), { since, sessionPrefixes }),
    };

    if (csvPath !== null && csvPath !== "-") {
      saveSessionsCsv(csvPath, sessionsCsv(report));
      const rows = report.sessions.length;
      console.log(`wrote ${rows} row${rows === 1 ? "" : "s"} → ${csvPath}`);
    } else if (csvPath === "-") {
      console.log(sessionsCsv(report).trimEnd());
    } else {
      console.log(
        asJson ? JSON.stringify(toSessionsJson(report), null, 2) : formatSessions(report),
      );
    }
  } catch (error) {
    if (error instanceof SessionsArgError) {
      console.error(`usage error: ${error.message}`);
      console.error("  example: lwc sessions ./watch.ndjson [--csv ./sessions.csv]");
    } else {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

// Local-only: balance history comes from a watch log, not the chain.
if (isHistory) {
  try {
    const { path, csvPath, session, wide, usd, usdOnly } = parseHistoryArgs(flags);
    const report = { path, ...extractBalanceHistory(readHistoryLog(path), { session }) };
    const csv = wide ? historyWideCsv(report, { usd, usdOnly }) : historyCsv(report);

    if (csvPath !== null && csvPath !== "-") {
      saveHistoryCsv(csvPath, csv);
    }

    if (csvPath === "-") {
      console.log(csv.trimEnd());
    } else if (asJson) {
      console.log(JSON.stringify(toHistoryJson(report), null, 2));
    } else if (csvPath !== null) {
      const written = Math.max(0, csv.trimEnd().split("\n").length - 1);
      console.log(`wrote ${written} row${written === 1 ? "" : "s"} → ${csvPath}`);
    } else {
      console.log(formatHistory(report));
    }
  } catch (error) {
    if (error instanceof HistoryArgError) {
      console.error(`usage error: ${error.message}`);
      console.error(
        "  example: lwc history ./watch.ndjson --csv ./balances.csv [--wide [--usd | --usd-only]]",
      );
    } else {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

// Local-only: charting a history CSV needs no RPC configuration.
if (isPlot) {
  try {
    const { path, width } = parsePlotArgs(flags);
    const report = buildPlotReport(readHistoryCsv(path), { path, width });
    console.log(asJson ? JSON.stringify(toPlotJson(report), null, 2) : formatPlot(report));
  } catch (error) {
    if (error instanceof PlotArgError) {
      console.error(`usage error: ${error.message}`);
      console.error("  example: lwc plot ./balances.csv --width 60");
    } else {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

// Local-only: a compare log summary needs no RPC configuration.
if (isCompareHistory) {
  try {
    const { path, csvPath } = parseCompareHistoryArgs(flags);
    const report = { path, ...summarizeCompareLog(readCompareLog(path)) };

    if (csvPath !== null && csvPath !== "-") {
      saveCompareHistoryCsv(csvPath, compareHistoryCsv(report));
      const rows = report.runs.reduce((sum, run) => sum + run.providers.length, 0);
      console.log(`wrote ${rows} row${rows === 1 ? "" : "s"} → ${csvPath}`);
    } else if (csvPath === "-") {
      console.log(compareHistoryCsv(report).trimEnd());
    } else {
      console.log(
        asJson
          ? JSON.stringify(toCompareHistoryJson(report), null, 2)
          : formatCompareHistory(report),
      );
    }
  } catch (error) {
    if (error instanceof CompareHistoryArgError) {
      console.error(`usage error: ${error.message}`);
      console.error(
        "  example: lwc compare-history ./compare.ndjson [--csv ./providers.csv]",
      );
    } else {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

/** One id per run, so several sessions in one log stay separable. */
function newSessionId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

/** Remove cache flags so the per-command parsers never see their values. */
function stripCacheFlags(args: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--no-cache" || arg === "--refresh-cache") continue;
    if (arg === "--cache-file") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--cache-file=")) continue;
    kept.push(arg);
  }
  return kept;
}

function cacheFlagPath(args: string[]): string | null {
  const inline = args.find((arg) => arg.startsWith("--cache-file="));
  if (inline) return inline.slice("--cache-file=".length) || null;
  const index = args.findIndex((arg) => arg === "--cache-file");
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith("-") ? value : null;
}

function hasBatchSizeFlag(args: string[]): boolean {
  return args.some((arg) => arg === "--batch-size" || arg.startsWith("--batch-size="));
}

function openMetadataCache(args: string[], chainId: number): MetadataCache | null {
  if (args.includes("--no-cache")) return null;
  return new MetadataCache({ chainId, path: resolveCachePath(cacheFlagPath(args)) });
}

function saveMetadataCache(cache: MetadataCache | null): void {
  const warning = cache?.save() ?? null;
  if (warning) console.error(`cache not saved: ${warning}`);
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) console.error(`warning: ${warning}`);
}

// Node's built-in .env loader; keep it optional so older runtimes still work.
const loadEnvFile = (
  process as unknown as { loadEnvFile?: (path?: string) => void }
).loadEnvFile;
if (typeof loadEnvFile === "function" && existsSync(".env")) {
  loadEnvFile(".env");
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short.length > 0) return short;
    return error.message;
  }
  return String(error);
}

try {
  const config = parseChainConfig(process.env, chainOverride);
  const client = buildClient(config);

  if (isCache) {
    if (flags.includes("--no-cache")) {
      throw new CacheArgError("--no-cache leaves no cache to inspect.");
    }
    const cachePath = resolveCachePath(cacheFlagPath(flags));
    const { clear } = parseCacheArgs(stripCacheFlags(flags));
    const cache = new MetadataCache({ chainId: config.chainId, path: cachePath });
    const report = inspectMetadataCache(cache, config, cachePath, { clear });
    console.log(
      asJson ? JSON.stringify(toCacheJson(report), null, 2) : formatMetadataCache(report),
    );
    printWarnings(report.warnings);
    saveMetadataCache(cache);
  } else if (isBalances) {
    const cache = openMetadataCache(flags, config.chainId);
    const {
      owner,
      tokens,
      labels,
      batchSize,
      maxSubCalls,
      failOnRetry,
      verbose,
      maxCacheAgeMs,
      staleAfterMs,
      warnings,
    } = parseBalanceArgs(stripCacheFlags(flags));
    printWarnings(warnings);
    const report = await readBalances(client, config, owner, tokens, {
      cache: cache ?? undefined,
      refreshCache: cache !== null && flags.includes("--refresh-cache"),
      labels,
      batchSize: hasBatchSizeFlag(flags) ? batchSize : undefined,
      maxSubCalls: maxSubCalls ?? undefined,
      maxCacheAgeMs: maxCacheAgeMs ?? undefined,
      onChunkProgress: verbose
        ? (chunk) => console.error(formatChunkProgress(chunk))
        : undefined,
    });
    printWarnings(staleMetadataWarnings(report.tokens, staleAfterMs));
    console.log(
      asJson ? JSON.stringify(toBalancesJson(report), null, 2) : formatBalances(report),
    );
    saveMetadataCache(cache);
    if (failOnRetry && report.recovery.failedChunks > 0) process.exitCode = 1;
  } else if (isTokens) {
    const { entries, outPath, force, merge, maxSubCalls, warnings } =
      parseTokenFileArgs(flags);
    const verification = await checkTokenAddressesReport(
      client,
      entries.map((entry) => entry.address),
      { maxSubCalls: maxSubCalls ?? undefined },
    );
    const checks = verification.checks;
    const json = saveTokenList(outPath, entries, { force: force || merge });
    printWarnings(warnings);
    printWarnings(
      checks
        .filter((check) => check.issue !== null)
        .map(
          (check) =>
            `token ${shortAddress(check.address)} is not a readable ERC-20: ${check.issue}`,
        ),
    );

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            path: outPath,
            tokens: tokenListItems(entries),
            chunkCount: verification.chunkCount,
            maxSubCalls: verification.maxSubCalls,
          },
          null,
          2,
        ),
      );
    } else if (outPath === "-") {
      console.log(json.trimEnd());
    } else {
      console.log(
        `wrote ${entries.length} token${entries.length === 1 ? "" : "s"} → ${outPath}`,
      );
    }
  } else if (isViews) {
    const { address, abiPath, spec, block, maxSubCalls } = parseViewsArgs(flags);
    const { abi, source } = resolveAbi(abiPath);
    const report = await runViewFunctions(
      client,
      address,
      abi,
      source,
      spec,
      block,
      maxSubCalls,
    );
    console.log(asJson ? JSON.stringify(toViewsJson(report), null, 2) : formatViews(report));
    if (report.failed > 0) process.exitCode = 1;
  } else if (isExample) {
    const startedAt = performance.now();
    const result = await readExampleCall(client);
    const latencyMs = Math.round(performance.now() - startedAt);
    assertContractChain(result, config);
    console.log(
      asJson
        ? JSON.stringify(toExampleCallJson(result, config, latencyMs), null, 2)
        : formatExampleCall(result, config, latencyMs),
    );
  } else if (isCall) {
    const { address, functionName, abiPath, args, block } = parseCallArgs(flags);
    const { abi } = resolveAbi(abiPath);
    const fn = findFunction(abi, functionName);
    const coerced = coerceArgs(fn, args);
    const outcome = await callViewFunction(client, address, abi, fn, coerced, block);
    const display = { contract: address, fn, ...outcome };
    console.log(asJson ? JSON.stringify(toCallJson(display), null, 2) : formatCall(display));
  } else if (isScan) {
    const parsed = parseScanArgs(stripCacheFlags(flags));
    const {
      owners,
      tokens,
      csvPath,
      labels,
      batchSize,
      maxSubCalls,
      failOnRetry,
      quiet,
      maxCacheAgeMs,
      staleAfterMs,
      warnings,
    } = parsed;
    printWarnings(warnings);
    if (asJson && csvPath) {
      throw new ScanArgError("use either --json or --csv, not both.");
    }
    const cache = openMetadataCache(flags, config.chainId);
    const report = await scanBalances(client, config, owners, tokens, {
      cache: cache ?? undefined,
      refreshCache: cache !== null && flags.includes("--refresh-cache"),
      labels,
      batchSize: hasBatchSizeFlag(flags) ? batchSize : undefined,
      maxSubCalls: maxSubCalls ?? undefined,
      maxCacheAgeMs: maxCacheAgeMs ?? undefined,
      onChunkProgress: quiet ? undefined : (chunk) => {
        const status =
          chunk.status === "batched"
            ? "ok"
            : chunk.status === "recovered"
              ? "retried, recovered"
              : chunk.status === "partial"
                ? "retried, partial"
                : "failed";
        const individual =
          chunk.individual.length > 0 ? `, ${chunk.individual.length} individual` : "";
        console.error(
          `  chunk ${shortAddress(chunk.owner)} ${chunk.index}/${chunk.total} (${chunk.tokens} token${chunk.tokens === 1 ? "" : "s"}) ${status}${individual}`,
        );
      },
    });
    printWarnings(staleMetadataWarnings(report.tokens, staleAfterMs));

    if (csvPath === null) {
      console.log(asJson ? JSON.stringify(toScanJson(report), null, 2) : formatScan(report));
    } else if (csvPath === "-") {
      console.log(scanCsv(report).trimEnd());
    } else {
      mkdirSync(dirname(csvPath), { recursive: true });
      writeFileSync(csvPath, scanCsv(report));
      console.log(
        `wrote ${report.rows.length} owners × ${report.tokens.length} tokens → ${csvPath}`,
      );
    }
    saveMetadataCache(cache);
    if (failOnRetry && report.recovery.failedChunks > 0) process.exitCode = 1;
  } else if (isCompare) {
    const args = parseCompareArgs(flags);
    const report = await compareEndpoints(config, args);
    console.log(asJson ? JSON.stringify(toCompareJson(report), null, 2) : formatCompare(report));
    if (args.logPath !== null) {
      try {
        mkdirSync(dirname(args.logPath), { recursive: true });
        const log = new RotatingLog({ path: args.logPath, maxBytes: args.logMaxBytes });
        log.append(JSON.stringify(toCompareLogRecord(report, newSessionId())));
      } catch (error) {
        console.error(`log not written: ${describeError(error)}`);
        process.exitCode = 1;
      }
    }
    if (report.endpoints.some((endpoint) => !endpoint.ok)) {
      process.exitCode = 1;
    }
  } else if (isWatch) {
    if (flags.includes("--stop")) {
      const logIndex = flags.findIndex((arg) => arg === "--log" || arg.startsWith("--log="));
      const logValue =
        logIndex === -1
          ? null
          : flags[logIndex] === "--log"
            ? (flags[logIndex + 1] ?? null)
            : (flags[logIndex] ?? "").slice("--log=".length);
      if (!logValue) {
        console.error("usage error: --stop requires --log <path> naming the running service.");
        process.exit(1);
      }
      writeFileSync(`${logValue}.stop`, "");
      console.log(`stop requested: ${logValue}.stop — the running watch exits with a summary.`);
      process.exit(0);
    }

    const options = parseWatchArgs(flags);

    if (options.detach) {
      const logPath = options.logPath as string;
      const outPath = `${logPath}.out`;
      mkdirSync(dirname(logPath), { recursive: true });
      const out = openSync(outPath, "a");
      const childArgs = process.argv.slice(2).filter((arg) => arg !== "--detach");
      const child = spawn(process.execPath, [process.argv[1] ?? "src/cli.ts", ...childArgs], {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
      closeSync(out);
      writeFileSync(`${logPath}.pid`, `${child.pid ?? ""}\n`);
      console.log(
        `lwc watch detached (pid ${child.pid}); events → ${logPath}, console → ${outPath}`,
      );
      console.log(`  stop with: lwc watch --log ${logPath} --stop`);
      process.exit(0);
    }

    const logPath = options.logPath;
    const alertQueuePath = resolveAlertQueuePath(options.alertQueuePath, logPath);
    const alertStore = new AlertStore(alertQueuePath);
    const session = newSessionId();
    let log: RotatingLog | null = null;
    if (logPath) {
      mkdirSync(dirname(logPath), { recursive: true });
      log = new RotatingLog({ path: logPath, maxBytes: options.logMaxBytes });
      log.append(
        JSON.stringify({
          session,
          event: "start",
          at: new Date().toISOString(),
          chain: { id: config.chainId, name: config.name },
          endpoint: publicEndpoint(config.rpcUrl),
          options: {
            intervalMs: options.intervalMs,
            stallAfterSeconds: options.stallAfterSeconds,
            maxSamples: options.maxSamples,
            gasSurgePercent: options.gasSurgePercent,
            windowSize: options.windowSize,
            reportEvery: options.reportEvery,
            portfolio:
              options.owner === null
                ? null
                : {
                    owner: options.owner,
                    tokens: options.tokens.length,
                    every: options.portfolioEvery,
                  },
          },
        }),
      );
    }
    const logLine = (record: object): void => {
      log?.append(JSON.stringify({ session, ...record }));
    };
    // Alerts are queued and retried in order, so a webhook outage delays
    // delivery instead of dropping the alert.
    const alertQueue = new AlertQueue({
      deliver: (alert) =>
        postWebhook(alert.url, alert.payload, { authHeader: options.alertAuthHeader }),
      store: alertStore,
      onPersistError: (error) => {
        console.error(`alert queue not written (${alertQueuePath}): ${describeError(error)}`);
      },
      onRetry: (alert, attempt, delayMs, message) => {
        console.error(
          `webhook retry ${attempt} in ${delayMs} ms (${alert.url}): ${message}`,
        );
        logLine({
          event: "webhook-retry",
          at: new Date().toISOString(),
          url: alert.url,
          attempt,
          delayMs,
          message,
        });
      },
    });
    let replayedAlerts = 0;
    try {
      replayedAlerts = alertQueue.restore();
    } catch (error) {
      console.error(`alert queue not replayed (${alertQueuePath}): ${describeError(error)}`);
    }
    if (replayedAlerts > 0) {
      console.error(
        `webhook queue: replaying ${replayedAlerts} undelivered alert(s) from ${alertQueuePath}`,
      );
      logLine({
        event: "webhook-replay",
        at: new Date().toISOString(),
        count: replayedAlerts,
        queue: alertQueuePath,
      });
    }

    const deliverAlert = async (
      url: string,
      payload: Record<string, unknown>,
    ): Promise<void> => {
      alertQueue.enqueue({ url, payload });
    };

    const controller = new AbortController();
    const onStop = () => controller.abort();
    process.on("SIGINT", onStop);
    process.on("SIGTERM", onStop);

    // Signals cannot be delivered to a detached process on Windows, so a stop
    // file gives the service a portable way to shut down cleanly with a summary.
    const stopPath = logPath ? `${logPath}.stop` : null;
    let stopWatcher: ReturnType<typeof setInterval> | null = null;
    if (stopPath) {
      if (existsSync(stopPath)) rmSync(stopPath, { force: true });
      stopWatcher = setInterval(() => {
        if (existsSync(stopPath)) {
          rmSync(stopPath, { force: true });
          controller.abort();
        }
      }, 500);
      stopWatcher.unref();
    }

    if (!asJson) {
      console.log(
        `lwc — watching ${config.name} (${config.chainId}) every ${options.intervalMs / 1000}s, stall threshold ${options.stallAfterSeconds}s, gas surge +${options.gasSurgePercent}%`,
      );
      if (logPath) console.log(`  logging to ${logPath}`);
      if (options.webhookUrl) {
        console.log(`  alerts → ${options.webhookUrl}`);
        console.log(
          `  alert queue → ${alertQueuePath}${replayedAlerts > 0 ? ` (${replayedAlerts} pending)` : ""}`,
        );
      }
      if (options.owner !== null && options.tokens.length > 0) {
        console.log(
          `  portfolio → ${options.owner}, ${options.tokens.length} tokens every ${options.portfolioEvery} poll(s)`,
        );
      }
      if (options.alertBalancePercent !== null) {
        console.log(`  balance alerts → moves above ${options.alertBalancePercent}% between samples`);
      }
      console.log("");
    }

    const summary = await watchChain(
      client,
      config,
      options,
      async (event) => {
        const json = toWatchEventJson(event);
        logLine(json);
        console.log(asJson ? JSON.stringify(json) : formatWatchEvent(event, config));

        if (
          (event.type === "alert" || event.type === "balance-alert") &&
          options.webhookUrl
        ) {
          await deliverAlert(options.webhookUrl, {
            ...json,
            session,
            chain: { id: config.chainId, name: config.name },
          });
        }
      },
      controller.signal,
      options.verbose
        ? { onChunkProgress: (chunk) => console.error(formatChunkProgress(chunk)) }
        : undefined,
    );

    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    if (stopWatcher) clearInterval(stopWatcher);

    const pendingAlerts = alertQueue.pending;
    alertQueue.stop();
    if (pendingAlerts > 0) {
      console.error(
        `webhook queue stopped with ${pendingAlerts} undelivered alert(s); kept in ${alertQueuePath} for the next run.`,
      );
      logLine({
        event: "webhook-pending",
        at: new Date().toISOString(),
        count: pendingAlerts,
        queue: alertQueuePath,
      });
    }

    const summaryJson = toWatchSummaryJson(summary);
    logLine(summaryJson);

    if (asJson) {
      console.log(JSON.stringify(summaryJson));
    } else {
      console.log("");
      console.log(formatWatchSummary(summary));
    }

    if (summary.chainDrift || summary.stalls > 0 || summary.gasSurges > 0) {
      process.exitCode = 1;
    }
  } else {
    // A preset's backup answers when the configured endpoint cannot, and the
    // report names whichever endpoint actually answered.
    const outcome = await probeWithFallback(buildClient, config);
    const answered = outcome.config;
    const warnings = connectionWarnings(answered);
    if (outcome.usedFallback) {
      warnings.push(
        `primary ${outcome.primaryEndpoint} failed (${outcome.primaryError}); answered by ${new URL(answered.rpcUrl).host}`,
      );
    }
    console.log(
      asJson
        ? JSON.stringify(
            toJsonPayload(outcome.health, answered, warnings, outcome),
            null,
            2,
          )
        : formatHealth(outcome.health, answered, warnings),
    );
  }
} catch (error) {
  if (error instanceof CacheArgError) {
    console.error(`usage error: ${error.message}`);
    console.error("  example: lwc cache --clear 0xTokenAddress");
  } else if (error instanceof BalancesArgError) {
    console.error(`usage error: ${error.message}`);
    console.error("  example: lwc balances 0xYourAddress --token 0xTokenAddress");
  } else if (error instanceof ViewsArgError) {
    console.error(`usage error: ${error.message}`);
    console.error("  example: lwc views 0xToken  (built-in ERC-20 ABI; --abi <file> overrides)");
  } else if (error instanceof TokenFileArgError) {
    console.error(`usage error: ${error.message}`);
    console.error("  example: lwc tokens 0xTokenA 0xTokenB --out ./examples/my.tokens.json");
  } else if (error instanceof CallArgError) {
    console.error(`usage error: ${error.message}`);
    console.error(
      "  example: lwc call 0xToken balanceOf --args '[\"0xYourAddress\"]'  (built-in ERC-20 ABI; --abi <file> overrides)",
    );
  } else if (error instanceof WatchArgError) {
    console.error(`usage error: ${error.message}`);
    console.error("  example: lwc watch --interval 3 --stall-after 30");
  } else if (error instanceof CompareArgError) {
    console.error(`usage error: ${error.message}`);
    console.error(
      "  example: lwc compare https://xlayer.drpc.org https://xlayerrpc.okx.com --samples 5",
    );
  } else if (error instanceof ScanArgError) {
    console.error(`usage error: ${error.message}`);
    console.error(
      "  example: lwc scan 0xAddrA 0xAddrB --tokens-file ./examples/xlayer.tokens.json --csv ./balances.csv",
    );
  } else if (error instanceof ChainConfigError) {
    console.error(`config error: ${error.message}`);
  } else if (error instanceof ChainMismatchError) {
    console.error(`chain mismatch: ${error.message}`);
  } else {
    console.error(`connection failed: ${describeError(error)}`);
    console.error(
      `  checked endpoint: ${process.env.LWC_RPC_URL ?? "(LWC_RPC_URL not set)"}`,
    );
    console.error("  verify the RPC is reachable and accepts JSON-RPC over POST.");
  }
  process.exit(1);
}
