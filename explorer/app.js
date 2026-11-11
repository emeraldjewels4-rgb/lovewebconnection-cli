const $ = (id) => document.getElementById(id);

const state = {
  chains: [],
  selected: null,
  /** null = not tried yet, true = same-origin proxy answered, false = call RPCs directly. */
  proxy: null,
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^(0x[0-9a-fA-F]+|\d+)$/;

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

async function showBlock(chain, quantity) {
  const block = await rpc(chain, "eth_getBlockByNumber", [quantity, false]);
  if (!block.result) throw new Error(`no block ${quantity} on ${chain.name}`);
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

async function showAddress(chain, address) {
  const [balance, nonce, code] = await Promise.all([
    rpc(chain, "eth_getBalance", [address, "latest"]),
    rpc(chain, "eth_getTransactionCount", [address, "latest"]),
    rpc(chain, "eth_getCode", [address, "latest"]),
  ]);
  const bytes = typeof code.result === "string" ? Math.max(0, (code.result.length - 2) / 2) : 0;
  renderResult(`Address ${short(address, 10)}`, `${chain.name} · latest`, [
    ["Balance", `${formatUnits(bigint(balance.result))} ${chain.symbol}`],
    ["Nonce", bigint(nonce.result).toLocaleString("en-US")],
    ["Contract", bytes > 0 ? `yes · ${bytes.toLocaleString("en-US")} bytes of code` : "no · externally owned account"],
    ["Address", address, true],
  ]);
}

async function showTransaction(chain, hash) {
  const [transaction, receipt, head] = await Promise.all([
    rpc(chain, "eth_getTransactionByHash", [hash]),
    rpc(chain, "eth_getTransactionReceipt", [hash]),
    rpc(chain, "eth_blockNumber", []),
  ]);
  const tx = transaction.result;
  if (!tx) throw new Error(`no transaction ${short(hash, 10)} on ${chain.name}`);

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

async function submit(event) {
  event.preventDefault();
  const chain = state.chains.find((row) => row.name === $("chain").value);
  const query = $("query").value.trim();
  const status = $("status");
  status.className = "note";

  if (!chain) {
    status.textContent = "pick a chain first.";
    return;
  }
  if (query === "") {
    status.textContent = "enter a block number, address or transaction hash.";
    return;
  }

  $("go").disabled = true;
  status.textContent = `reading ${chain.name}…`;
  try {
    if (TX_HASH.test(query)) {
      await showTransaction(chain, query);
    } else if (ADDRESS.test(query)) {
      await showAddress(chain, query);
    } else if (QUANTITY.test(query)) {
      const quantity = query.startsWith("0x") ? `0x${bigint(query).toString(16)}` : `0x${BigInt(query).toString(16)}`;
      await showBlock(chain, quantity);
    } else {
      throw new Error("that is not a block number, 20-byte address or 32-byte transaction hash.");
    }
    status.textContent = state.proxy ? "answered through rpc.php" : "answered by the endpoint directly";
  } catch (error) {
    $("result").hidden = true;
    status.className = "note bad";
    status.textContent = error.message;
  } finally {
    $("go").disabled = false;
  }
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

  state.selected = state.chains[0].name;
  renderOptions();
  renderChains({});
  $("lookup").addEventListener("submit", submit);
  await probeAll();
}

boot();
