const $ = (id) => document.getElementById(id);

const state = {
  chains: [],
  selected: null,
  /** null = not tried yet, true = same-origin proxy answered, false = call RPCs directly. */
  proxy: null,
};

/** Incremented per lookup so a slow earlier response cannot render over a newer one. */
let lookupSeq = 0;

function isCurrentLookup(seq) {
  return seq === lookupSeq;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^(0x[0-9a-fA-F]+|\d+)$/;

/** EIP-1967 storage slots: implementation, admin and beacon. */
const EIP1967 = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
};

/** ERC-20 selectors, read through eth_call. */
const ERC20 = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
};

const KIND_HINTS = {
  auto: ["Block number, address or transaction hash", "19000000, 0x… address, 0x… 64-byte hash"],
  block: ["Block number", "19000000 or 0x122a3c0"],
  address: ["Address", "0x… 20-byte address"],
  transaction: ["Transaction hash", "0x… 32-byte hash"],
  token: ["Token contract", "0x… ERC-20 contract address"],
  contract: ["Contract address", "0x… contract address"],
};

function bigint(value) {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function formatUnits(value, decimals = 18, maxFraction = 6) {
  const base = 10n ** BigInt(decimals);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / base;
  const fraction = (magnitude % base)
    .toString()
    .padStart(decimals, "0")
    .slice(0, maxFraction)
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

function short(value, keep = 8) {
  if (typeof value !== "string") return String(value);
  return value.length > keep * 2 + 2 ? `${value.slice(0, keep + 2)}…${value.slice(-keep)}` : value;
}

function decodeUint(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x") || hex.length < 66) return null;
  return bigint(hex.slice(0, 66));
}

/** An ABI string, including the bytes32 form older tokens use for name and symbol. */
function decodeAbiText(hex) {
  if (typeof hex !== "string" || hex === "0x") return null;
  const body = hex.slice(2);
  try {
    if (body.length === 64) {
      const bytes = new Uint8Array(body.match(/../g).map((pair) => parseInt(pair, 16)));
      const end = bytes.indexOf(0);
      return new TextDecoder().decode(bytes.subarray(0, end === -1 ? bytes.length : end)).trim() || null;
    }
    if (body.length >= 128) {
      // Dynamic string: offset word, length word, then the bytes.
      const offset = Number(bigint("0x" + body.slice(0, 64))) * 2;
      const length = Number(bigint("0x" + body.slice(offset, offset + 64)));
      const data = body.slice(offset + 64, offset + 64 + length * 2);
      if (data.length < length * 2) return null;
      const bytes = new Uint8Array(data.match(/../g).map((pair) => parseInt(pair, 16)));
      return new TextDecoder().decode(bytes).replace(/\0+$/, "").trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

/** The address held in a 32-byte storage slot, or null when the slot is empty. */
function slotAddress(hex) {
  if (typeof hex !== "string" || hex === "0x" || /^0x0+$/.test(hex)) return null;
  const address = "0x" + hex.slice(2).padStart(64, "0").slice(-40);
  return /^0x0{40}$/.test(address) ? null : address;
}

/** EIP-1167 runtime: 10-byte prefix, the target address, 15-byte suffix. */
function minimalProxyTarget(code) {
  if (typeof code !== "string") return null;
  const body = code.slice(2).toLowerCase();
  if (
    body.length !== 90 ||
    !body.startsWith("363d3d373d3d3d363d73") ||
    !body.endsWith("5af43d82803e903d91602b57fd5bf3")
  ) {
    return null;
  }
  return "0x" + body.slice(20, 60);
}

function syncKind() {
  const [label, placeholder] = KIND_HINTS[$("kind").value] || KIND_HINTS.auto;
  $("query-label").textContent = label;
  $("query").placeholder = placeholder;
}

/** Put the lookup in history so it can be shared, reloaded or revisited. */
function syncUrl(chain, kind, query) {
  const url = new URL(location.href);
  url.searchParams.set("chain", chain.name);
  url.searchParams.set("type", kind);
  url.searchParams.set("q", query);
  if (url.toString() === location.href) return;
  history.pushState(null, "", url.toString());
}

function readParams() {
  const params = new URLSearchParams(location.search);
  return {
    chain: params.get("chain"),
    type: params.get("type"),
    query: params.get("q") || params.get("query"),
  };
}

/** Apply a URL's lookup to the form and, when asked, run it without a new entry. */
function applyParams(params, run) {
  if (params.chain && state.chains.some((chain) => chain.name === params.chain)) {
    selectChain(params.chain);
  }
  if (params.type && KIND_HINTS[params.type]) {
    $("kind").value = params.type;
  } else {
    $("kind").value = "auto";
  }
  syncKind();
  $("query").value = params.query || "";

  if (!params.query) {
    $("result").hidden = true;
    $("status").textContent = "";
    return;
  }
  if (run) void performLookup({ push: false });
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function age(timestampSeconds) {
  const seconds = Math.max(0, Math.round(Date.now() / 1000) - Number(timestampSeconds));
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function text(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

async function rpc(chain, method, params = []) {
  if (state.proxy !== false) {
    try {
      const response = await fetch(`rpc.php?chain=${encodeURIComponent(chain.name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        cache: "no-store",
      });
      const type = response.headers.get("content-type") || "";
      if (type.includes("application/json")) {
        state.proxy = true;
        const body = await response.json();
        if (body.error) {
          throw new Error(typeof body.error === "string" ? body.error : body.error.message || "rpc error");
        }
        if (!("result" in body)) throw new Error("the proxy answered without a result");
        return { result: body.result, via: response.headers.get("x-lwc-via") || "proxy" };
      }
      state.proxy = false;
    } catch (error) {
      if (state.proxy === true) throw error;
      state.proxy = false;
    }
  }

  const problems = [];
  for (const [index, url] of chain.endpoints.entries()) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        cache: "no-store",
        signal: AbortSignal.timeout(9000),
      });
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || "rpc error");
      return { result: body.result, via: index === 0 ? "primary" : "fallback" };
    } catch (error) {
      problems.push(`${hostOf(url)}: ${error.message}`);
    }
  }
  throw new Error(problems.join("; ") || "no endpoint answered");
}

function renderProxyNote() {
  const note = $("proxy-note");
  if (state.proxy === false) {
    note.textContent =
      "rpc.php is not answering, so this page is calling the public endpoints directly. " +
      "A browser blocks that when an endpoint sends no CORS header; host this folder on the PHP site to use the proxy.";
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

async function probe(chain) {
  const started = performance.now();
  try {
    const chainId = await rpc(chain, "eth_chainId");
    if (bigint(chainId.result) !== BigInt(chain.chainId)) {
      throw new Error(`answered chain ${bigint(chainId.result)}`);
    }
    const block = await rpc(chain, "eth_blockNumber");
    return {
      ok: true,
      block: bigint(block.result),
      ms: Math.round(performance.now() - started),
      via: chainId.via === "fallback" || block.via === "fallback" ? "fallback" : "primary",
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function statusCell(result) {
  const cell = document.createElement("td");
  if (result === undefined) {
    cell.appendChild(text("span", "probing…", "note"));
    return cell;
  }
  const dot = text("span", undefined, `dot ${result.ok ? (result.via === "fallback" ? "warn" : "ok") : "bad"}`);
  cell.appendChild(dot);
  cell.appendChild(text("span", result.ok ? (result.via === "fallback" ? "failover" : "healthy") : "down"));
  if (result.ok && result.via === "fallback") {
    cell.appendChild(text("span", "backup", "badge"));
  }
  if (!result.ok) cell.title = result.error || "";
  return cell;
}

function selectChain(name) {
  state.selected = name;
  $("chain").value = name;
  for (const row of document.querySelectorAll("#chains tbody tr")) {
    row.setAttribute("aria-selected", String(row.dataset.chain === name));
  }
}

function renderChains(results = {}) {
  const body = document.querySelector("#chains tbody");
  body.replaceChildren();

  for (const chain of state.chains) {
    const row = document.createElement("tr");
    row.dataset.chain = chain.name;
    row.tabIndex = 0;
    row.setAttribute("aria-selected", String(chain.name === state.selected));
    row.addEventListener("click", () => selectChain(chain.name));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectChain(chain.name);
      }
    });

    const name = document.createElement("td");
    name.appendChild(text("strong", chain.name));
    name.appendChild(text("div", chain.symbol, "note"));

    const id = text("td", String(chain.chainId), "num");
    const endpoint = text("td", chain.endpoints.map(hostOf).join(" → "), "endpoint");
    endpoint.title = chain.endpoints.join("\n");

    const block = document.createElement("td");
    const result = results[chain.name];
    if (result && result.ok) block.textContent = result.block.toLocaleString("en-US");
    else block.textContent = "—";
    block.className = "num";

    const latency = text("td", result && result.ok ? `${result.ms} ms` : "—", "num");

    row.append(name, id, endpoint, block, latency, statusCell(result));
    body.appendChild(row);
  }

  const probed = Object.values(results);
  const healthy = probed.filter((result) => result.ok).length;
  const backups = probed.filter((result) => result.ok && result.via === "fallback").length;
  if (probed.length === 0) {
    $("summary").textContent = "probing every preset…";
  } else {
    const failed = probed.length - healthy;
    $("summary").textContent =
      `${healthy} of ${probed.length} healthy` +
      (backups ? ` · ${backups} on a backup` : "") +
      (failed ? ` · ${failed} down` : "") +
      ` · checked ${new Date().toLocaleTimeString()}`;
  }
}

function renderOptions() {
  const select = $("chain");
  select.replaceChildren();
  for (const chain of state.chains) {
    const option = text("option", `${chain.name} (${chain.chainId})`);
    option.value = chain.name;
    select.appendChild(option);
  }
  if (state.selected) select.value = state.selected;
}

function definition(rows) {
  const list = document.createElement("dl");
  for (const [label, value, mono] of rows) {
    list.appendChild(text("dt", label));
    const cell = document.createElement("dd");
    if (mono) cell.className = "mono";
    cell.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
    list.appendChild(cell);
  }
  return list;
}

function renderResult(title, tone, rows) {
  const box = $("result");
  box.replaceChildren();
  const head = document.createElement("p");
  head.className = "head";
  head.appendChild(text("strong", title));
  if (tone) head.appendChild(text("span", tone, tone === "bad" ? "no" : "note"));
  box.append(head, definition(rows));
  box.hidden = false;
}

async function showBlock(chain, quantity, seq) {
  const block = await rpc(chain, "eth_getBlockByNumber", [quantity, false]);
  if (!block.result) throw new Error(`no block ${quantity} on ${chain.name}`);
  if (!isCurrentLookup(seq)) return;
  const value = block.result;
  const transactions = Array.isArray(value.transactions) ? value.transactions : [];
  renderResult(
    `Block ${bigint(value.number).toLocaleString("en-US")}`,
    `${chain.name} · ${age(bigint(value.timestamp))}`,
    [
      ["Hash", value.hash, true],
      ["Parent", short(value.parentHash, 12), true],
      ["Timestamp", `${new Date(Number(bigint(value.timestamp)) * 1000).toISOString()} (${age(bigint(value.timestamp))})`],
      ["Transactions", transactions.length.toLocaleString("en-US")],
      ["Gas used", `${bigint(value.gasUsed).toLocaleString("en-US")} / ${bigint(value.gasLimit).toLocaleString("en-US")}`],
      ["Base fee", value.baseFeePerGas ? `${formatUnits(bigint(value.baseFeePerGas), 9, 4)} gwei` : "—"],
      ["Fee recipient", value.miner || "—", true],
      ["Size", value.size ? `${bigint(value.size).toLocaleString("en-US")} bytes` : "—"],
    ],
  );
}

async function showAddress(chain, address, seq) {
  const [balance, nonce, code] = await Promise.all([
    rpc(chain, "eth_getBalance", [address, "latest"]),
    rpc(chain, "eth_getTransactionCount", [address, "latest"]),
    rpc(chain, "eth_getCode", [address, "latest"]),
  ]);
  if (!isCurrentLookup(seq)) return;
  const bytes = typeof code.result === "string" ? Math.max(0, (code.result.length - 2) / 2) : 0;
  renderResult(`Address ${short(address, 10)}`, `${chain.name} · latest`, [
    ["Balance", `${formatUnits(bigint(balance.result))} ${chain.symbol}`],
    ["Nonce", bigint(nonce.result).toLocaleString("en-US")],
    ["Contract", bytes > 0 ? `yes · ${bytes.toLocaleString("en-US")} bytes of code` : "no · externally owned account"],
    ["Address", address, true],
  ]);
}

async function showTransaction(chain, hash, seq) {
  const [transaction, receipt, head] = await Promise.all([
    rpc(chain, "eth_getTransactionByHash", [hash]),
    rpc(chain, "eth_getTransactionReceipt", [hash]),
    rpc(chain, "eth_blockNumber", []),
  ]);
  const tx = transaction.result;
  if (!tx) throw new Error(`no transaction ${short(hash, 10)} on ${chain.name}`);
  if (!isCurrentLookup(seq)) return;

  const gasPrice = tx.gasPrice ? bigint(tx.gasPrice) : null;
  const receiptValue = receipt.result;
  let fee = null;
  if (receiptValue && receiptValue.gasUsed && (receiptValue.effectiveGasPrice || gasPrice)) {
    fee = bigint(receiptValue.gasUsed) * bigint(receiptValue.effectiveGasPrice || gasPrice);
  }
  const confirmations =
    tx.blockNumber && head.result ? bigint(head.result) - bigint(tx.blockNumber) + 1n : null;

  renderResult(
    `Transaction ${short(hash, 10)}`,
    receiptValue ? (bigint(receiptValue.status) === 1n ? "succeeded" : "reverted") : "pending",
    [
      ["From", tx.from, true],
      ["To", tx.to || "contract creation", true],
      ["Value", `${formatUnits(bigint(tx.value))} ${chain.symbol}`],
      ["Block", tx.blockNumber ? bigint(tx.blockNumber).toLocaleString("en-US") : "pending"],
      ["Confirmations", confirmations === null ? "—" : confirmations.toLocaleString("en-US")],
      ["Gas used", receiptValue && receiptValue.gasUsed ? bigint(receiptValue.gasUsed).toLocaleString("en-US") : "—"],
      ["Fee", fee === null ? "—" : `${formatUnits(fee)} ${chain.symbol}`],
      ["Nonce", bigint(tx.nonce).toLocaleString("en-US")],
      ["Hash", hash, true],
    ],
  );
}

async function showToken(chain, address, seq) {
  const call = (data) =>
    rpc(chain, "eth_call", [{ to: address, data }, "latest"])
      .then((answer) => answer.result)
      .catch(() => null);
  const [code, name, symbol, decimals, supply] = await Promise.all([
    rpc(chain, "eth_getCode", [address, "latest"]).then((answer) => answer.result).catch(() => "0x"),
    call(ERC20.name),
    call(ERC20.symbol),
    call(ERC20.decimals),
    call(ERC20.totalSupply),
  ]);
  if (!isCurrentLookup(seq)) return;

  const bytes = typeof code === "string" ? Math.max(0, (code.length - 2) / 2) : 0;
  if (bytes === 0) throw new Error(`no contract at ${short(address, 8)} on ${chain.name}`);

  const nameText = decodeAbiText(name);
  const symbolText = decodeAbiText(symbol);
  const decimalsValue = decodeUint(decimals);
  const supplyValue = decodeUint(supply);
  if (nameText === null && symbolText === null && supplyValue === null) {
    throw new Error("that contract answers none of name, symbol or totalSupply; it is not an ERC-20 token");
  }

  const resolvedDecimals =
    decimalsValue === null ? 18 : Math.min(36, Math.max(0, Number(decimalsValue)));
  const title = symbolText ? `${symbolText}${nameText ? ` · ${nameText}` : ""}` : nameText || "Token";
  renderResult(title, `${chain.name} · ERC-20`, [
    ["Name", nameText],
    ["Symbol", symbolText],
    ["Decimals", decimalsValue === null ? "18 (method missing)" : String(resolvedDecimals)],
    ["Total supply", supplyValue === null ? "—" : `${formatUnits(supplyValue, resolvedDecimals)} ${symbolText || ""}`.trim()],
    ["Contract", `${bytes.toLocaleString("en-US")} bytes of code`],
    ["Address", address, true],
  ]);
}

async function showContract(chain, address, seq) {
  const code = await rpc(chain, "eth_getCode", [address, "latest"]);
  if (!isCurrentLookup(seq)) return;
  const bytes = typeof code.result === "string" ? Math.max(0, (code.result.length - 2) / 2) : 0;
  if (bytes === 0) throw new Error(`no contract at ${short(address, 8)} on ${chain.name}`);

  const read = (slot) =>
    rpc(chain, "eth_getStorageAt", [address, slot, "latest"])
      .then((answer) => answer.result)
      .catch(() => null);
  const [implementation, admin, beacon] = await Promise.all([
    read(EIP1967.implementation),
    read(EIP1967.admin),
    read(EIP1967.beacon),
  ]);
  if (!isCurrentLookup(seq)) return;

  const impl = slotAddress(implementation);
  const beaconAddress = slotAddress(beacon);
  const adminAddress = slotAddress(admin);
  const minimal = minimalProxyTarget(code.result);
  const rows = [
    ["Code", `${bytes.toLocaleString("en-US")} bytes`],
    ["Kind", impl ? "proxy (EIP-1967)" : minimal ? "minimal proxy (EIP-1167)" : "contract"],
  ];
  if (impl) rows.push(["Implementation", impl, true]);
  if (beaconAddress) rows.push(["Beacon", beaconAddress, true]);
  if (adminAddress) rows.push(["Proxy admin", adminAddress, true]);
  if (minimal) rows.push(["Implementation", minimal, true]);
  rows.push(["Address", address, true]);
  renderResult(`Contract ${short(address, 8)}`, chain.name, rows);
}

async function performLookup({ push = true } = {}) {
  const mine = ++lookupSeq;
  const chain = state.chains.find((row) => row.name === $("chain").value);
  const query = $("query").value.trim();
  const status = $("status");
  status.className = "note";

  if (!chain) {
    status.textContent = "pick a chain first.";
    return;
  }
  if (query === "") {
    status.textContent = "enter a value to look up.";
    return;
  }

  let kind = $("kind").value;
  if (kind === "auto") {
    if (TX_HASH.test(query)) kind = "transaction";
    else if (ADDRESS.test(query)) kind = "address";
    else if (QUANTITY.test(query)) kind = "block";
    else kind = "";
  }

  if (kind === "") {
    status.className = "note bad";
    status.textContent = "that is not a block number, 20-byte address or 32-byte transaction hash.";
    return;
  }
  if (kind === "transaction" && !TX_HASH.test(query)) {
    status.className = "note bad";
    status.textContent = "a transaction hash is 32 bytes of hex.";
    return;
  }
  if ((kind === "address" || kind === "token" || kind === "contract") && !ADDRESS.test(query)) {
    status.className = "note bad";
    status.textContent = "an address is 20 bytes of hex.";
    return;
  }
  if (kind === "block" && !QUANTITY.test(query)) {
    status.className = "note bad";
    status.textContent = "a block is a decimal number or a 0x quantity.";
    return;
  }

  if (push) syncUrl(chain, kind, query);
  $("go").disabled = true;
  status.textContent = `reading ${chain.name}…`;
  try {
    if (kind === "transaction") {
      await showTransaction(chain, query, mine);
    } else if (kind === "address") {
      await showAddress(chain, query, mine);
    } else if (kind === "token") {
      await showToken(chain, query, mine);
    } else if (kind === "contract") {
      await showContract(chain, query, mine);
    } else {
      const quantity = query.startsWith("0x") ? `0x${bigint(query).toString(16)}` : `0x${BigInt(query).toString(16)}`;
      await showBlock(chain, quantity, mine);
    }
    if (!isCurrentLookup(mine)) return;
    status.textContent = state.proxy ? "answered through rpc.php" : "answered by the endpoint directly";
  } catch (error) {
    if (!isCurrentLookup(mine)) return;
    $("result").hidden = true;
    status.className = "note bad";
    status.textContent = error.message;
  } finally {
    if (isCurrentLookup(mine)) $("go").disabled = false;
  }
}

async function submit(event) {
  event.preventDefault();
  await performLookup();
}

async function probeAll() {
  const results = {};
  renderChains(results);
  await Promise.all(
    state.chains.map(async (chain) => {
      results[chain.name] = await probe(chain);
      renderChains(results);
      renderProxyNote();
    }),
  );
}

async function boot() {
  try {
    const response = await fetch("presets.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`presets.json answered ${response.status}`);
    const data = await response.json();
    state.chains = Array.isArray(data.chains) ? data.chains : [];
    if (state.chains.length === 0) throw new Error("presets.json lists no chains");
  } catch (error) {
    $("summary").textContent = `cannot load presets.json: ${error.message}`;
    return;
  }

  const initial = readParams();
  state.selected =
    initial.chain && state.chains.some((chain) => chain.name === initial.chain)
      ? initial.chain
      : state.chains[0].name;
  renderOptions();
  renderChains({});

  $("kind").addEventListener("change", syncKind);
  if (initial.type && KIND_HINTS[initial.type]) $("kind").value = initial.type;
  syncKind();
  $("lookup").addEventListener("submit", submit);
  window.addEventListener("popstate", () => applyParams(readParams(), true));
  await probeAll();

  if (initial.query) {
    $("query").value = initial.query;
    await performLookup({ push: false });
  }
}

boot();
