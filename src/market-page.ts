/**
 * The minimal swap page served at `GET /` by `lwc market --serve`.
 *
 * It is one self-contained document: inline CSS, inline JavaScript, no external
 * assets, no build step. Every value it renders comes from the market API as
 * text via `textContent`, never as HTML.
 */
export const MARKET_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Swap</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --panel: #ffffff;
    --line: #dfe3e8;
    --text: #10151c;
    --muted: #5d6b7a;
    --accent: #0a7a55;
    --accent-text: #ffffff;
    --good: #0a7a55;
    --bad: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0e13;
      --panel: #121821;
      --line: #222d3a;
      --text: #e6edf3;
      --muted: #8b9bab;
      --accent: #2fbf8b;
      --accent-text: #05100c;
      --good: #37d399;
      --bad: #ff8b82;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 20px 56px;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main { width: 100%; max-width: 480px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: -0.01em; }
  h2 {
    margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.08em;
  }
  .sub { margin: 0 0 22px; color: var(--muted); font-size: 13px; min-height: 20px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px; }
  .card + .card { margin-top: 16px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 16px; }
  .tabs button {
    flex: 1; padding: 9px 12px; border-radius: 9px; border: 1px solid var(--line);
    background: transparent; color: var(--muted); font: inherit; font-weight: 600; cursor: pointer;
  }
  .tabs button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  input {
    width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line);
    background: var(--bg); color: var(--text);
    font: 600 18px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input::placeholder { color: var(--muted); opacity: 1; }
  .out {
    margin: 12px 0 0; font: 600 16px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }
  .note { margin: 8px 0 0; min-height: 20px; font-size: 13px; color: var(--muted); }
  .note[data-tone="good"] { color: var(--good); }
  .note[data-tone="bad"] { color: var(--bad); }
  button.primary {
    width: 100%; margin-top: 14px; padding: 12px 16px; border: 0; border-radius: 10px;
    background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 700; cursor: pointer;
  }
  button.primary:disabled {
    background: var(--line); color: var(--muted); cursor: not-allowed;
  }
  dl { margin: 0; font-size: 13px; }
  .row {
    display: flex; flex-wrap: wrap; align-items: baseline;
    justify-content: space-between; gap: 0 12px;
  }
  .row + .row { margin-top: 6px; }
  dt { color: var(--muted); }
  dd {
    margin: 0 0 0 auto; text-align: right;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }
  ol { margin: 0; padding: 0; list-style: none; font-size: 13px; }
  li { padding: 7px 0; border-top: 1px solid var(--line); display: flex; justify-content: space-between; gap: 12px; }
  li:first-child { border-top: 0; }
  li time { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  li span { font-variant-numeric: tabular-nums; }
  .empty { color: var(--muted); }
  .amount-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .amount-head label { margin-bottom: 6px; }
  button.linkish {
    padding: 0; border: 0; background: transparent; color: var(--accent);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  button.linkish:disabled { color: var(--muted); cursor: not-allowed; }
  #liquidity-note { color: var(--bad); }
  #liquidity-note[hidden] { display: none; }
  .cover {
    margin: 0 0 16px; padding: 10px 12px; border: 1px solid var(--bad);
    border-radius: 10px; color: var(--bad); font-size: 13px;
  }
  .cover[hidden] { display: none; }
</style>
</head>
<body>
<main>
  <h1>Swap</h1>
  <p class="sub" id="sub">loading the pool…</p>
  <p class="cover" id="cover-warning" role="status" aria-live="polite" hidden></p>

  <section class="card" id="unlock" hidden>
    <h2>Access key</h2>
    <label for="key">This market asks for a key before it will quote or swap.</label>
    <input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="access key" />
    <button class="primary" id="unlock-go" type="button">Unlock</button>
    <p class="note" id="unlock-note" role="status" aria-live="polite"></p>
  </section>

  <form class="card" id="form">
    <div class="tabs" role="group" aria-label="Side">
      <button type="button" id="buy" aria-pressed="true">Buy <span id="buy-sym">base</span></button>
      <button type="button" id="sell" aria-pressed="false">Sell <span id="sell-sym">base</span></button>
    </div>
    <div class="amount-head">
      <label for="amount">You pay (<span id="pay-sym">quote</span>)</label>
      <button type="button" class="linkish" id="max" disabled>Max</button>
    </div>
    <input id="amount" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0.0" />
    <p class="out" id="quote-out">You receive —</p>
    <p class="note" id="quote-note" role="status" aria-live="polite"></p>
    <p class="note" id="liquidity-note" role="status" aria-live="polite" hidden></p>
    <button class="primary" id="swap" type="submit" disabled>Swap</button>
  </form>

  <section class="card" aria-labelledby="pool-h">
    <h2 id="pool-h">Pool</h2>
    <dl>
      <div class="row"><dt>Price</dt><dd id="price">—</dd></div>
      <div class="row"><dt>Net flow</dt><dd id="net-flow">—</dd></div>
      <div class="row"><dt>Backing</dt><dd id="backing">—</dd></div>
      <div class="row"><dt>Liquidity</dt><dd id="liquidity">—</dd></div>
      <div class="row"><dt>Reserves</dt><dd id="reserves">—</dd></div>
      <div class="row"><dt>Volume</dt><dd id="volume">—</dd></div>
      <div class="row"><dt>Turnover</dt><dd id="turnover">—</dd></div>
      <div class="row"><dt>One trade up to</dt><dd id="depth">—</dd></div>
      <div class="row"><dt>After this trade</dt><dd id="depth-after">—</dd></div>
    </dl>
  </section>

  <section class="card" aria-labelledby="fills-h">
    <h2 id="fills-h">Fills</h2>
    <ol id="fills"><li class="empty" id="no-fills">Nothing yet.</li></ol>
  </section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var base = (new URLSearchParams(location.search).get("api") || "").replace(/\\/+$/, "");
  var state = null;
  var side = "buy";
  var quote = null;
  var timer = null;
  var seq = 0;
  var KEY_STORE = "lwc-market-key";
  var key = "";
  try {
    key = new URLSearchParams(location.search).get("key") || sessionStorage.getItem(KEY_STORE) || "";
  } catch (error) {
    key = "";
  }

  function authHeaders(extra) {
    var headers = extra || {};
    if (key) headers["x-market-key"] = key;
    return headers;
  }

  /** Keep a working key for this tab only, and take it out of the address bar. */
  function rememberKey(value) {
    key = value;
    try { sessionStorage.setItem(KEY_STORE, value); } catch (error) {}
    var url;
    try { url = new URL(location.href); } catch (error) { return; }
    if (url.searchParams.has("key")) {
      url.searchParams.delete("key");
      history.replaceState(null, "", url.toString());
    }
  }

  function askForKey(message) {
    $("unlock").hidden = false;
    $("unlock-note").textContent = message || "";
    $("key").focus();
  }

  function unlock() {
    var typed = $("key").value.trim();
    if (!typed) {
      $("unlock-note").textContent = "enter the key the api was started with";
      return;
    }
    rememberKey(typed);
    $("unlock").hidden = true;
    $("sub").textContent = "checking the key…";
    loadState().then(function (ok) { if (ok) setSide("buy"); });
  }

  function fmt(raw, decimals) {
    var negative = raw.charAt(0) === "-";
    var digits = negative ? raw.slice(1) : raw;
    while (digits.length <= decimals) digits = "0" + digits;
    var cut = digits.length - decimals;
    var whole = digits.slice(0, cut);
    var fraction = digits.slice(cut).replace(/0+$/, "");
    return (negative ? "-" : "") + whole + (fraction ? "." + fraction : "");
  }

  /** A flow with its direction made explicit, and no sign noise on zero. */
  function signed(raw, decimals) {
    var text = fmt(raw, decimals);
    if (Number(text) === 0) return text;
    return text.charAt(0) === "-" ? text : "+" + text;
  }

  function setNote(text, tone) {
    var note = $("quote-note");
    note.textContent = text;
    if (tone) note.setAttribute("data-tone", tone);
    else note.removeAttribute("data-tone");
  }

  function setLiquidity(text) {
    var note = $("liquidity-note");
    note.textContent = text || "";
    if (note.textContent) note.removeAttribute("hidden");
    else note.setAttribute("hidden", "");
  }

  function setDepthAfter(text) {
    $("depth-after").textContent = text || "—";
  }

  function setCover(text) {
    var warning = $("cover-warning");
    warning.textContent = text || "";
    if (warning.textContent) warning.removeAttribute("hidden");
    else warning.setAttribute("hidden", "");
  }

  /** A decimal string that stays one unit below the target, so it cannot be refused. */
  function decimalFrom(value, decimals) {
    if (!isFinite(value) || value <= 0) return "";
    var units = Math.floor(value * Math.pow(10, decimals));
    if (units > 1) units -= 1;
    if (units <= 0) return "";
    return fmt(String(units), decimals);
  }

  /**
   * The most this side can pay right now. A buy is limited by the base reserve,
   * so its quote cost is the reserve at the fixed price plus the fee; a sell is
   * limited by the quote reserve, which the API already reports as maxSellBase.
   */
  function maxInput(capacity) {
    capacity = capacity || (state && state.capacity);
    if (!capacity) return "";
    if (side === "sell") {
      var sell = fmt(capacity.maxSellBase, state.base.decimals);
      return Number(sell) > 0 ? sell : "";
    }

    var base = Number(fmt(capacity.maxBuyBase, state.base.decimals));
    var price = Number(state.price && state.price.value);
    var fee = Number(state.feeBps || 0) / 10000;
    if (base > 0 && isFinite(price) && price > 0 && fee < 1) {
      return decimalFrom((base * price) / (1 - fee), state.quote.decimals);
    }
    var fallback = fmt(capacity.payQuote, state.quote.decimals);
    return Number(fallback) > 0 ? fallback : "";
  }

  function updateMax() {
    var button = $("max");
    var value = maxInput();
    button.disabled = value === "";
    button.title = value
      ? "fill " + value + " " + (side === "buy" ? state.quote.symbol : state.base.symbol)
      : "the pool has no depth on this side";
  }

  function renderState() {
    if (!state) return;
    var q = state.quote;
    var b = state.base;
    $("sub").textContent = "Fixed price, no price impact. Every quote is answered.";
    $("price").textContent = state.price.value + " " + q.symbol + " per " + b.symbol;
    $("liquidity").textContent = fmt(state.liquidity.valueQuote, q.decimals) + " " + q.symbol;
    $("reserves").textContent =
      fmt(q.reserve, q.decimals) + " " + q.symbol + " + " + fmt(b.reserve, b.decimals) + " " + b.symbol;
    $("volume").textContent =
      fmt(state.volume.quote, q.decimals) + " " + q.symbol + " in " + state.volume.swaps + " swaps";
    $("turnover").textContent =
      Number(state.volume.turnover).toLocaleString(undefined, { maximumFractionDigits: 2 }) + "× liquidity";
    var net = state.netFlow;
    $("net-flow").textContent = net
      ? signed(net.base, b.decimals) + " " + b.symbol + " · " +
        signed(net.quote, q.decimals) + " " + q.symbol
      : "—";

    var capacity = state.capacity;
    $("depth").textContent = capacity
      ? fmt(capacity.maxBuyBase, b.decimals) + " " + b.symbol + " / " +
        fmt(capacity.payQuote, q.decimals) + " " + q.symbol
      : "—";
    $("backing").textContent = capacity
      ? fmt(q.reserve, q.decimals) + " " + q.symbol + " · covers " +
        fmt(capacity.maxSellBase, b.decimals) + " " + b.symbol + " of sells"
      : "—";

    // Base the pool has sold into circulation has to be bought back at this
    // price, and only the quote reserve can pay for it.
    var issued = net && net.base.charAt(0) === "-" ? -Number(fmt(net.base, b.decimals)) : 0;
    var cover = capacity ? Number(fmt(capacity.maxSellBase, b.decimals)) : 0;
    if (capacity && issued > cover) {
      setCover(
        "net flow: the pool sold " + fmt(net.base, b.decimals).slice(1) + " " + b.symbol +
          " but can buy back only " + fmt(capacity.maxSellBase, b.decimals) + " " + b.symbol +
          " at " + state.price.value + " " + q.symbol + " — larger sells are refused"
      );
    } else {
      setCover("");
    }
    $("buy-sym").textContent = b.symbol;
    $("sell-sym").textContent = b.symbol;
    $("pay-sym").textContent = side === "buy" ? q.symbol : b.symbol;
    updateMax();
  }

  function refreshQuote() {
    var amount = $("amount").value.trim();
    var mine = ++seq;
    quote = null;
    $("swap").disabled = true;

    if (!state || !/^\\d+(\\.\\d+)?$/.test(amount) || Number(amount) <= 0) {
      $("quote-out").textContent = "You receive —";
      setNote("", null);
      setLiquidity("");
      setDepthAfter("");
      return;
    }

    setNote("quoting…", null);
    fetch(base + "/quote?side=" + side + "&amount=" + encodeURIComponent(amount), {
      cache: "no-store",
      headers: authHeaders()
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, status: response.status, body: body };
        });
      })
      .then(function (result) {
        if (mine !== seq) return;
        if (result.status === 401) {
          askForKey("that key was not accepted");
          setNote("access key required", "bad");
          setLiquidity("");
          setDepthAfter("");
          return;
        }
        if (!result.ok) throw new Error(result.body.error || "quote failed");
        var filled = result.body;
        quote = filled;
        if (!filled.executable) {
          $("quote-out").textContent = "You receive —";
          setNote(filled.reason || "this trade cannot be settled right now", "bad");
          setLiquidity("");
          setDepthAfter("");
          return;
        }
        $("quote-out").textContent = "You receive " + filled.amountOutFormatted + " " + filled.outSymbol;
        setNote(
          "fee " + filled.feeFormatted + " " + filled.inSymbol + " · " + filled.price + " " +
            state.quote.symbol + " per " + state.base.symbol + " · no price impact",
          null
        );
        var depth = Number(maxInput());
        var used = depth > 0 ? Number(filled.amountInFormatted) / depth : 0;
        var unit = side === "buy" ? state.quote.symbol : state.base.symbol;
        var left = filled.capacityAfter ? maxInput(filled.capacityAfter) : "";
        setDepthAfter(left ? left + " " + unit : "nothing on this side");
        var tail = left ? " — " + left + " " + unit + " left after it" : " — nothing left after it";
        if (used >= 0.995) {
          setLiquidity("low liquidity: this fills the pool's whole depth on this side" + tail);
        } else if (used >= 0.5) {
          setLiquidity(
            "low liquidity: this trade uses " + Math.round(used * 100) + "% of the pool's depth" + tail
          );
        } else {
          setLiquidity("");
        }
        $("swap").disabled = false;
      })
      .catch(function (error) {
        if (mine !== seq) return;
        setNote(String(error.message || error), "bad");
      });
  }

  function addFill(fill) {
    var empty = $("no-fills");
    if (empty) empty.remove();

    var item = document.createElement("li");
    var text = document.createElement("span");
    text.textContent =
      fill.side + " " + fill.amountInFormatted + " " + fill.inSymbol +
      " → " + fill.amountOutFormatted + " " + fill.outSymbol;
    var when = document.createElement("time");
    when.textContent = new Date().toLocaleTimeString();
    item.appendChild(text);
    item.appendChild(when);

    var list = $("fills");
    list.insertBefore(item, list.firstChild);
    while (list.children.length > 20) list.removeChild(list.lastChild);
  }

  function loadState() {
    return fetch(base + "/market", { cache: "no-store", headers: authHeaders() })
      .then(function (response) {
        if (response.status === 401) {
          $("sub").textContent = "This market asks for an access key.";
          askForKey("");
          return null;
        }
        if (!response.ok) throw new Error("market answered " + response.status);
        return response.json();
      })
      .then(function (body) {
        if (body === null) return false;
        state = body;
        renderState();
        return true;
      })
      .catch(function (error) {
        $("sub").textContent =
          "Cannot reach the market API" + (base ? " at " + base : "") + ": " + (error.message || error);
        return false;
      });
  }

  function setSide(next) {
    side = next;
    $("buy").setAttribute("aria-pressed", String(next === "buy"));
    $("sell").setAttribute("aria-pressed", String(next === "sell"));
    $("pay-sym").textContent = state ? (next === "buy" ? state.quote.symbol : state.base.symbol) : "—";
    $("amount").value = "";
    refreshQuote();
    updateMax();
  }

  $("max").addEventListener("click", function () {
    var value = maxInput();
    if (!value) return;
    $("amount").value = value;
    refreshQuote();
  });

  $("buy").addEventListener("click", function () { setSide("buy"); });
  $("sell").addEventListener("click", function () { setSide("sell"); });

  $("amount").addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(refreshQuote, 200);
  });

  $("form").addEventListener("submit", function (event) {
    event.preventDefault();
    if (!quote) return;

    var sending = { side: side, amount: $("amount").value.trim() };
    $("swap").disabled = true;
    setNote("submitting…", null);

    fetch(base + "/swap", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(sending)
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, status: response.status, body: body };
        });
      })
      .then(function (result) {
        if (result.status === 401) {
          askForKey("that key was not accepted");
          setNote("access key required", "bad");
          return;
        }
        if (!result.ok) throw new Error(result.body.error || "swap failed");
        var filled = result.body;
        addFill(filled);
        if (filled.state) state = filled.state;
        setLiquidity("");
        renderState();
        $("amount").value = "";
        quote = null;
        setDepthAfter("");
        $("quote-out").textContent = "You receive —";
        setNote(
          "filled " + filled.amountInFormatted + " " + filled.inSymbol +
            " → " + filled.amountOutFormatted + " " + filled.outSymbol,
          "good"
        );
      })
      .catch(function (error) {
        setNote(String(error.message || error), "bad");
        $("swap").disabled = !quote;
      });
  });

  $("unlock-go").addEventListener("click", unlock);
  $("key").addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); unlock(); }
  });

  if (key) rememberKey(key);
  loadState().then(function (ok) { if (ok) setSide("buy"); });

  setInterval(function () {
    if (document.visibilityState === "visible") loadState();
  }, 5000);
})();
</script>
</body>
</html>
`;
