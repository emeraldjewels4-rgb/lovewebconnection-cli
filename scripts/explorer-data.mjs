import { writeFile } from "node:fs/promises";

import { CHAIN_PRESETS } from "../src/chain.ts";

/**
 * The explorer is static and cannot import the TypeScript table, so its preset
 * list is generated here instead of being copied by hand. Rerun after changing
 * CHAIN_PRESETS; the page and rpc.php both read explorer/presets.json.
 */
const chains = Object.entries(CHAIN_PRESETS).map(([name, preset]) => ({
  name,
  chainId: preset.chainId,
  symbol: preset.nativeSymbol,
  endpoints: [preset.rpcUrl, preset.fallbackRpcUrl ?? null].filter(
    (url) => typeof url === "string" && url.length > 0,
  ),
}));

const target = new URL("../explorer/presets.json", import.meta.url);
await writeFile(target, `${JSON.stringify({ chains }, null, 2)}\n`);
console.log(`wrote ${chains.length} chains to ${target.pathname}`);
