# lwc — lovewebconnection

<!-- Status badges. Fiatgod is the GitHub account this project belongs to and
     lovewebconnection is its package name. No repository exists under this slug
     yet, so the images resolve only once it is created; if it is created under
     another name, change the slug in both lines. -->
[![Tests](https://github.com/Fiatgod/lovewebconnection/actions/workflows/tests.yml/badge.svg)](https://github.com/Fiatgod/lovewebconnection/actions/workflows/tests.yml)
[![Migrations](https://github.com/Fiatgod/lovewebconnection/actions/workflows/migrations.yml/badge.svg)](https://github.com/Fiatgod/lovewebconnection/actions/workflows/migrations.yml)
[![Preset health](https://github.com/Fiatgod/lovewebconnection/actions/workflows/presets.yml/badge.svg)](https://github.com/Fiatgod/lovewebconnection/actions/workflows/presets.yml)

A read-only EVM chain connection kit. Point it at any EVM-compatible JSON-RPC
endpoint, prove the connection is live, and build on the same client.

It holds **no private keys, signs nothing, and sends no transactions**. It reads
chain state and refuses to talk to an endpoint that reports the wrong chain id.

## Install

```bash
npm install -g lovewebconnection   # installs the `lwc` command
npx lovewebconnection chain        # or run it without installing
```

The npm package is `lovewebconnection` and the command it installs is `lwc`;
the name `lwc` on npm belongs to Lightning Web Components. The package ships
compiled JavaScript in `dist/`, built from the TypeScript sources with
`npm run build`.

## Requirements

- Node.js 24+ (the source runs directly via Node's built-in TypeScript support)
- npm

## Setup

```bash
npm install
cp .env.example .env    # then edit .env
```

`.env` is gitignored. Nothing secret belongs in the repo. The template starts on
the `xlayer` preset, so a fresh copy works without editing anything.

`npm install` also installs the pre-commit hook: its `prepare` script points
`core.hooksPath` at `.githooks`, so every commit runs `npm run typecheck` and
`npm test` first. Expect it to add 15–25 seconds to a commit.

Skip it when you need to:

```bash
git commit --no-verify      # once
npm test                    # ...then run the checks yourself
git config --unset core.hooksPath   # until the next npm install
```

## Connect

```bash
npm run chain          # human-readable health report
npm run chain:json     # same data as JSON
lwc chain --chain base # one preset, without touching .env
```

Example output:

```
lwc — chain connection

  status        connected
  chain         base (8453)
  rpc           mainnet.base.org
  client        Geth/v1.14.11-stable/linux-amd64/go1.21.13
  block         21654321 (3s old)
  gas           0.005 gwei
  latency       118 ms
```

`npm run chain:json` emits `chain`, `rpc`, `health`, and `warnings` with bigints
as decimal strings, so the output is safe for `jq` and logs. The auth header is
never printed, and `chain.preset` names the built-in chain in use (or `null`).
`rpc.host` is the endpoint that answered, while `rpc.usedFallback`,
`rpc.primaryHost`, and `rpc.primaryError` record a failover to the backup.

## Chains

Six chains are built in, so checking them needs no configuration:

| Preset | Chain id | Native | Default RPC | Backup RPC |
| --- | --- | --- | --- | --- |
| `xlayer` | 196 | OKB | `https://xlayer.drpc.org` | `https://rpc.xlayer.tech` |
| `base` | 8453 | ETH | `https://mainnet.base.org` | `https://base-rpc.publicnode.com` |
| `ethereum` | 1 | ETH | `https://ethereum-rpc.publicnode.com` | `https://cloudflare-eth.com` |
| `arbitrum` | 42161 | ETH | `https://arb1.arbitrum.io/rpc` | `https://arbitrum-one-rpc.publicnode.com` |
| `optimism` | 10 | ETH | `https://mainnet.optimism.io` | `https://optimism-rpc.publicnode.com` |
| `polygon` | 137 | POL | `https://polygon-bor-rpc.publicnode.com` | `https://polygon.drpc.org` |

Every preset has a backup endpoint from a different operator. When the default
endpoint is unreachable, times out, or answers with the wrong chain id, `lwc
chain` and `lwc presets` retry against the backup and report which one answered
instead of failing outright. A configured `LWC_RPC_AUTH` disables the failover:
a credential is only ever sent to the operator it was issued for.

A custom chain, or a private endpoint configured in `.env`, names its own backup
with `LWC_FALLBACK_RPC_URL`. For a preset it replaces the preset's backup, and it
follows the same rule as `LWC_RPC_URL`: it describes the chain configured in
`.env`, so `--chain` switching to another network does not inherit it.

```bash
lwc chain --chain xlayer
lwc chain --chain base
lwc chain --chain ethereum    # any preset works the same way
lwc chain --chain 196        # a preset can also be named by its chain id
LWC_CHAIN=xlayer npm run chain
```

`lwc presets` probes all six endpoints in parallel and reports latency and head
for each one, so a dead endpoint is visible without trying them one at a time.
It exits non-zero if any preset is unhealthy, which makes it usable as a
connectivity check in CI:

```bash
lwc presets
lwc presets --json            # machine-readable; exits 1 on any failure
lwc presets --timeout 5000    # per-endpoint budget in ms (250-120000)
lwc presets --history .lwc-history/presets.jsonl   # append this run
lwc presets-history .lwc-history/presets.jsonl     # trend across runs
lwc presets-history .lwc-history/presets.jsonl --since 7d    # this week only
lwc presets-history .lwc-history/presets.jsonl --limit 20    # the newest 20
lwc presets-history .lwc-history/presets.jsonl --since 7d --until 1d
lwc presets-history .lwc-history/presets.jsonl --since 7d --csv ./presets.csv
lwc presets-history .lwc-history/presets.jsonl --since 7d --timeline ./timeline.csv
lwc presets-history .lwc-history/presets.jsonl --since 7d --fail-under 99
```

`--history` appends one JSON line per run, and `presets-history` reads them back
into per-preset uptime, failovers, p50/max latency, and the last failure, so a
provider that fails one run in ten is visible instead of averaged away by a
single healthy probe.

`--since` takes an ISO timestamp or a span measured back from now (`30m`, `24h`,
`7d`), and `--limit` keeps the newest N runs after that cutoff, so a recent
incident reads on its own instead of against the whole file. A narrowed view
says `runs 2 of 30` and prints the window it applied; `--json` carries
`totalRuns`, `since`, `until` and `limit` so a report can state its own scope.

`--until` closes the other end with the same syntax, which is what judges a
finished incident: `--since 7d --until 1d` is the week before yesterday, so the
runs since the fix do not dilute the ones that failed. A window that ends before
it starts is rejected rather than silently matching nothing.

`--csv <path>` (or `-` for stdout) exports one row per preset for the selected
window — runs, healthy, failed, failovers, uptime, p50 and max latency, and the
last run and failure — so the window can be charted or pasted into a
spreadsheet. The filters apply before the export, and `--fail-under` still gates
on the same window when a CSV is written.

`--timeline <path>` (or `-`) exports the same window at per-run granularity —
one row per preset per run, oldest first, with `ok`, `via`, latency, block,
host and both error fields — so uptime and latency can be plotted as a time
series instead of collapsed into a window summary. `--csv` and `--timeline` are
separate exports and cannot be combined.

`--fail-under <pct>` turns the view into a gate: it exits 1 when any preset's
uptime inside the window is below the percentage, naming each offender on stderr
while the table still goes to stdout. Because it judges the window, pair it with
`--since`/`--limit` to hold a recent period to a standard rather than all of
history — a provider that failed two of the last twenty runs is caught even when
the newest run was healthy. An empty window fails the gate, since there is no
run to clear it.

The scheduled **Preset health** workflow publishes this table to the run summary,
annotates every failover, and restores its history file from the Actions cache so
the trend builds up across runs. It also enforces the gate: every run judges the
last week of history against `--fail-under` (95% by default, settable when
starting the workflow by hand), writes a PASS/FAIL section naming any preset
below it, and fails the job — so a provider that has been flaky all week turns
the schedule red even when that morning's probe happened to answer. An empty or
unreadable window fails too, rather than passing unchecked. Cache entries expire
after a week of no use, which shortens the trend window but never the check
itself.

`--chain` is global, so one shell can work across networks without editing
`.env`:

```bash
lwc balances 0xYourAddress --chain base --token 0xToken
lwc watch --chain xlayer --interval 5
```

`LWC_CHAIN` selects the default preset and `--chain` overrides it per command,
including in a project whose `.env` is pinned to another chain: an explicit
preset uses its own endpoint and does not inherit a `LWC_CHAIN_ID` or
`LWC_RPC_URL` configured for a different network. When the two agree, the env
values still win over the preset's defaults — `LWC_RPC_URL` swaps in your
endpoint (add `LWC_RPC_AUTH` if it needs a bearer token), and `LWC_CHAIN_NAME`
and `LWC_NATIVE_SYMBOL` relabel output. Any other network is a custom chain: set
`LWC_CHAIN_ID` and `LWC_RPC_URL`, or pass the id to `--chain` and keep only
`LWC_RPC_URL`. The chain-id check applies either way, and `LWC_CHAIN` paired
with a conflicting `LWC_CHAIN_ID` is rejected instead of silently preferring
one.

## Balances

Read the native balance and any ERC-20s you name:

```bash
npm run balances -- 0xYourAddress
npm run balances -- 0xYourAddress --token 0xTokenA --token 0xTokenB
npm run balances -- 0xYourAddress --token "0xTokenA:Tether USD" --json
npm run balances -- 0xYourAddress --tokens 0xTokenA,0xTokenB --json
npm run balances -- 0xYourAddress --tokens-file ./examples/xlayer.tokens.json
```

```
lwc — balances

  owner         0x000000000000000000000000000000000000dEaD
  chain         xlayer (196)
  block         75416262

  native        1.2345 OKB
  token         2.5 USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
  token         7 FAKE (0x…1234) — symbol is bytes32 (FAKE), not a string

  flagged       1 of 2 addresses does not look like a working ERC-20
```

Symbols and decimals are read from the token contract itself (`symbol`,
`decimals`), never assumed. A genuine ERC-20 must also return `totalSupply`, so
the owner's balance is checked against it: `balanceOf exceeds totalSupply` is
flagged, as are `totalSupply reverted` and `totalSupply is not a uint256`. An
address that answers but is **not a real ERC-20** is flagged in place with the
reason, while whatever did decode is still shown: `no contract code (every call
returned no data)` for an EOA or empty contract, `reverted on decimals, symbol,
balanceOf and totalSupply (not an ERC-20)` for a contract that rejects all four
methods, `symbol is bytes32 (…)` for pre-standard tokens that return a `bytes32`
instead of a `string`, plus `decimals is not a uint8`, `implausible decimals (…)`,
`symbol is empty`, `balanceOf is not a uint256`, and `totalSupply is not a
uint256`.
A bad metadata field never hides a balance that did decode: the row degrades to
`<n> raw` when decimals are unknown and `unreadable` when `balanceOf` fails.
`--json` carries the same `issue` string per token, `null` for clean ones.

Reads are batched through Multicall3 `aggregate3` in **parallel chunks of 12
tokens**: the native balance and each token's `decimals`, `symbol`, `balanceOf`,
and `totalSupply` ride together, so thirty tokens cost three simultaneous round
trips instead of 120. When every token's metadata is cached in `balances`, `scan`, or a watch
portfolio, chunks grow to 24 tokens because only `balanceOf` and `totalSupply`
remain, keeping the same sub-call budget. An explicit `--batch-size` always
wins. A chunk that reverts — a gas-burning contract, or no Multicall3 at all —
only re-reads its own tokens individually while the other chunks keep their
results, and the failure is reported once as `batch 2/3: …`. Precompile
addresses (0x…01–0x…0a) are answered locally and shown as unreadable: they have
no code, can never be ERC-20s, and 0x…05 (modexp) would read a 4-byte selector
as an enormous operand length and revert its chunk by exhausting the gas.

`--batch-size <n>` sets how many tokens share one Multicall3 request (range
1–100). It defaults to 12, or 24 for a fully cached `balances`/`scan` list; an
explicit value overrides that. Lower it when the RPC enforces a stricter
`eth_call` gas cap.

`--max-subcalls <n>` caps the `aggregate3` sub-calls in one request instead
(range 1–1000), so the request stays the same size whether metadata is cached
or not: a cached token costs two sub-calls, an uncached one four, and the first
request also carries the native balance. Use one of `--batch-size` or
`--max-subcalls`, not both. A single token still gets its own request.
A recovered chunk is not a warning, but the failure and its retries stay
visible: the report adds a `recovery` line whenever a first request failed,
for example `1 failed chunk, 2 retry requests, 1 recovered`. `--json` carries
the same numbers as `recovery.failedChunks`, `retryRequests`, and
`recoveredChunks`.

In `watch`, every portfolio sample that needed that work also emits a
`chunk-recovery` event before the sample's `portfolio` event, in both the
`--json` stream and the NDJSON log: `chunk`, `chunks`, `tokens`, `status`
(`recovered`, `partial`, or `failed`), the chunk's `error`, and the `individual`
addresses that were re-read on their own. Chunks that batched cleanly emit
nothing, so the log stays quiet on a healthy RPC.

If a chunk still fails, it is retried once as two smaller sub-batches before its
remaining tokens are re-read individually, so a recovered chunk carries no
warning and only a genuinely failed one costs its own tokens. `scan` and `watch`
accept the same flag.

`--fail-on-retry` turns any of that recovery work into a non-zero exit (status
1), which makes flaky RPC batching visible to CI even when every balance was
ultimately read: it triggers when a chunk's first Multicall3 request failed,
whether the retry recovered it or its tokens fell back to individual reads.
Output is unchanged — the table or `--json` still prints — so the exit code is
the only signal. `balances` and `scan` both accept it:

```bash
npm run balances -- 0xOwner --tokens-file ./examples/xlayer.tokens.json --fail-on-retry
npm run scan -- 0xOwner --tokens-file ./examples/xlayer.tokens.json --fail-on-retry
```

`--verbose` prints one line per Multicall3 chunk to stderr as it settles,
including the retry outcome and how many tokens fell back to individual reads:

```
  chunk 0x0000…dEaD 1/3 (12 tokens) ok
  chunk 0x0000…dEaD 2/3 (12 tokens) retried, recovered
  chunk 0x0000…dEaD 3/3 (4 tokens) failed, 4 individual
```

It is off by default, and `--json`/`--csv` stdout stays clean. `--verbose` and
`--fail-on-retry` can be combined: the progress explains why a run exits 1.

Tokens are optional because JSON-RPC cannot enumerate an address's holdings; you
list the contracts you care about. Addresses are checksummed, duplicates
collapsed, and `--json` returns the same data with bigints as decimal strings,
plus the `batchSize` selected for the read and the resulting `chunkCount`.

### Metadata cache

`decimals` and `symbol` are cached per chain in `.lwc-cache/token-metadata.json`
and reused: a repeat check sends two sub-calls per known token (`balanceOf`,
`totalSupply`) instead of four, `scan` reuses the same entries for every owner
instead of re-reading metadata per owner, and fully cached `balances`/`scan`
lists pack 24 tokens per chunk instead of 12. Supply is deliberately never
cached because minting and burning change it. Only clean metadata is stored — a
token whose symbol or decimals did not decode is left out of the cache so it is
re-examined next time instead of remembered as broken. Each entry records a
`cachedAt` epoch timestamp; `MetadataCache.ageMs()` reports how old it is.
Version-1 entries remain readable and report no age until refreshed.

`balances` and `scan` mark each token whose metadata came from the cache with
its age, for example `[cached 3d]`, and `--json` includes `cacheAgeMs` per token
(null for freshly read metadata or a legacy entry without a timestamp), so a
stale symbol or decimals value is visible before it is refreshed. `--no-cache`
and `--refresh-cache` therefore show no age for the affected tokens.

`--max-cache-age <duration>` refreshes entries automatically once they are older
than the given age: `30m`, `12h`, `7d`, or `2w` (the `s`, `m`, `h`, `d`, and `w`
suffixes are required, so a bare number is never guessed). Stale entries are
dropped before the read, count as cache misses, and are fetched again; undated
version-1 entries are refreshed too because their age cannot be checked. The
flag takes a space or `=`, and works for both commands:

```bash
npm run balances -- 0xYourAddress --token 0xTokenA --max-cache-age 7d
npm run scan -- 0xAddrA 0xAddrB --tokens-file ./examples/xlayer.tokens.json --max-cache-age=12h
```

`--stale-after <duration>` is the warning-only counterpart: it never refreshes
or drops an entry, but each cached token older than the threshold prints a
warning to stderr while still showing its `[cached …]` age in the table:

```
warning: USDT (0x1E4a…D41d) metadata is 3d old, stale after 1d
```

It takes the same durations as `--max-cache-age` and works in `balances` and
`scan`. Combine the two to refresh very old entries while still warning about
merely old ones:

```bash
npm run balances -- 0xYourAddress --token 0xTokenA --stale-after 7d --max-cache-age 30d
```

```bash
npm run balances -- 0xYourAddress --token 0xTokenA --no-cache      # skip the cache
npm run balances -- 0xYourAddress --token 0xTokenA --refresh-cache # re-read metadata
npm run balances -- 0xYourAddress --token 0xTokenA --cache-file ./tmp/tokens.json
LWC_CACHE_FILE=./tmp/tokens.json npm run scan 0xAddrA 0xAddrB
```

`--refresh-cache` drops the requested tokens' cached entries before reading, so
a rebranded token's new symbol is fetched and stored. `--no-cache` disables the
cache entirely, `--cache-file <path>` (or `LWC_CACHE_FILE`) relocates it, and
the default file is git-ignored. JSON output from `balances` and `scan` includes
`cache: { "hits": n, "misses": n }`; hits are unique ERC-20 tokens served from
the cache, misses were read again, and precompiles are excluded. `--no-cache`
reports zero for both. The cache is keyed by chain id, so pointing
`LWC_RPC_URL` at another network never mixes metadata. A missing or damaged
cache file is ignored, and if the file cannot be written the read still succeeds
— the warning goes to stderr.

### Inspecting and clearing cached metadata

`cache` lists the metadata entries for the configured chain, oldest first, with
their age:

```bash
npm run cache
npm run cache -- --json
npm run cache -- --cache-file ./tmp/tokens.json
```

```
lwc — cache

  file          .lwc-cache/token-metadata.json
  chain         xlayer (196)
  entries       2

  token         0x1E4a…D41d  USDT (6 decimals)  cached 3d
  token         0xe538…9b2b  WOKB (18 decimals)  cached 1h
```

`--clear <address>` removes selected entries and writes the cache; repeat it or
pass a comma-separated list. Addresses that are not cached are reported as
warnings, and the remaining entries are printed afterwards:

```bash
npm run cache -- --clear 0xTokenA
npm run cache -- --clear 0xTokenA,0xTokenB --json
```

`--json` returns `entries` and `removed` arrays with `address`, `symbol`,
`decimals`, `cachedAt` (epoch milliseconds, or `null` for a legacy entry), and
`ageMs` (`null` when the age is unknown), plus `warnings`. `--no-cache` is
rejected because there is no cache to inspect. `--clear` only affects the file
and never re-reads anything on chain.

### Saving a token list

`tokens` writes the list format `--tokens-file` reads, from addresses you pass on
the command line:

```bash
npm run tokens -- 0xTokenA 0xTokenB --out ./examples/my.tokens.json
npm run tokens -- --tokens 0xTokenA,0xTokenB --out -     # print instead of write
npm run tokens -- "0xTokenA=Tether USD" 0xTokenB --out ./examples/my.tokens.json
```

```
wrote 2 tokens → ./examples/my.tokens.json
```

Addresses are checksummed, duplicates collapse, and order is preserved. An inline
label — `0xAddress=Label`, or `0xAddress:Label`, with the same 64-character limit
as elsewhere — is kept in the written file, so the list reads back with its
labels:

```json
[
  { "address": "0x1E4a5963aBFD975d8c9021ce480b42188849D41d", "label": "Tether USD" },
  "0xe538905cf8410324e03A5A23C1c177a474D59b2b"
]
```

An unlabeled address stays a plain string. When a repeated address carries a
different label, the last one wins and a warning goes to stderr.

Each address is read on chain before the list is written — `decimals`, `symbol`
and `totalSupply` through Multicall3 — and anything that does not answer like an
ERC-20 is reported without stopping the write:

```
warning: token 0x0000…dEaD is not a readable ERC-20: no contract code (every call returned no data)
```

Warnings go to stderr, so `--out -` and `--json` stay clean. An existing file is
never replaced unless you pass `--force`, the parent directory is created if
needed, and `--out -` prints the JSON array (which `--json` turns into
`{ ok, path, tokens, chunkCount, maxSubCalls }`, with `tokens` in the same
string-or-object shape as the file). `chunkCount` is the number of Multicall3
verification requests sent, and `maxSubCalls` is the cap used, or `null` when
the default token batch size applied.

`--max-subcalls <n>` caps each verification request at a fixed number of
sub-calls (three per token) rather than a token count, so strict RPCs get
smaller calls; a single token always gets a request of its own. It accepts 1–1000
and applies only to the on-chain check, never to the written list:

```bash
npm run tokens -- --tokens 0xTokenA,0xTokenB --out - --max-subcalls 30
```

Pass `--merge` to add to a list that already exists instead of replacing it:

```bash
npm run tokens -- "0xNewToken=New Token" --out ./examples/my.tokens.json --merge
```

The file's own entries keep their order and labels, and addresses already there
are not repeated — only genuinely new ones are appended, then the merged list is
written back. A label passed for an address already in the file replaces the old
one and warns on stderr when the two differ; an unlabeled duplicate keeps the
existing label. `--merge` creates the file when it is missing and does not need
`--force`, but it needs a real path, so `--out -` is rejected.

`--tokens-file <path>` reads that list from disk so routine checks do not repeat
addresses: a JSON array of addresses, or an object with a `tokens` array. Each
entry may also be an object with a `label`, which is shown next to the symbol so
two similarly named tokens stay distinguishable:

```json
[
  { "address": "0x1E4a5963aBFD975d8c9021ce480b42188849D41d", "label": "Tether USD" },
  { "address": "0xe538905cf8410324e03A5A23C1c177a474D59b2b", "label": "Wrapped OKB" },
  "0x000000000000000000000000000000000000dEaD"
]
```

Ad-hoc `--token` flags accept an inline label too: `0xAddress:Label` (or
`0xAddress=Label`), for example `--token "0xTokenA:Tether USD"`. The same
64-character limit applies, and `--tokens` accepts the syntax as well. Labels
are cosmetic: they appear in the table (`0.028275 USDT [Tether USD] (0x1E4a…)`)
and in `--json` as a `label` field, but never change what is read on chain and
are not cached. Inline `--token`/`--tokens` labels override a conflicting label
from `--tokens-file`; when the two differ, a warning naming both is printed to
stderr. Conflicting repeated labels from the same source keep the last one and
warn. JSON stdout stays clean. `scan` uses the label in its column headers and
JSON tokens. The flag can be repeated and combines with `--token`/`--tokens`,
still deduped by address. `examples/xlayer.tokens.json` starts you off with USDT
and WOKB. An unreadable file, invalid JSON, or a bad entry fails with a usage
error naming the file and the entry number, before any network call.

## Comparing RPC endpoints

`compare` probes two endpoints in the same rounds, in parallel, and reports which
one answers faster and which one has the fresher head:

```bash
npm run compare -- drpc=https://xlayer.drpc.org okx=https://xlayerrpc.okx.com --samples 5 --interval 1
```

```
lwc — compare

  chain         xlayer (196)
  samples       5 every 1s
  new blocks    5

  endpoint                      p50     p95        head   lag   behind  wins  delay    age   err
  drpc                         142ms   310ms    75419519     1      5/5     3   0ms     0s     0
  okx                          168ms   402ms    75419520     0      0/5     2   34ms     0s     0

  fastest       drpc (p50 142 ms)
  freshest      okx (head 75419520)
```

`p50`/`p95` are the round-trip times for `eth_blockNumber`, measured per endpoint
with the cache disabled so every round hits the network. `lag` is how many blocks
behind the freshest endpoint it finished; `behind` is how many rounds it was
behind at all, which separates a consistently stale endpoint from one that merely
lost the race once. `age` is the age of the head block in seconds.

`wins` counts the heads this endpoint reported before any other endpoint, and
`delay` is the median time after the first report of the same head, so an endpoint
that answers quickly but is late to serve a new block shows up here instead of
looking good on latency alone. `new blocks` is the number of distinct heads that
appeared after the baseline round; when two endpoints serve the same head in one
round, `delay` still orders them by their response times. `--json` adds the
`observed` and `misses` counts for each endpoint's `delivery`.

`--samples` (default 5) and `--interval` (default 1s) control the rounds.

Prefix an endpoint with `label=` to name it in the table, warnings, and JSON,
and give providers separate keys with one `--endpoint-auth "label=Bearer …"`
per endpoint:

```bash
npm run compare -- drpc=https://xlayer.drpc.org okx=https://xlayerrpc.okx.com \
  --endpoint-auth "drpc=Bearer $DRPC_KEY" --endpoint-auth "okx=Bearer $OKX_KEY"
```

An endpoint without its own header inherits `LWC_RPC_AUTH`, and
`--endpoint-auth` also accepts a full URL as the key. Labels must be unique and
use letters, digits, dot, dash, or underscore.

A labeled endpoint also picks up its key automatically from
`LWC_RPC_AUTH_<LABEL>`: the label is uppercased and any dot, dash, or underscore
becomes an underscore, so `drpc=` reads `LWC_RPC_AUTH_DRPC` and `my-node=` reads
`LWC_RPC_AUTH_MY_NODE`. Keep one key per provider in `.env` and the command
stays short:

```bash
# .env
# LWC_RPC_AUTH_DRPC=Bearer …
# LWC_RPC_AUTH_OKX=Bearer …
npm run compare -- drpc=https://xlayer.drpc.org okx=https://xlayerrpc.okx.com
```

Values are trimmed and must be a single line; an unset or empty variable leaves
the endpoint on `LWC_RPC_AUTH`. An explicit `--endpoint-auth` always wins, and
an unlabeled endpoint has no name to look up, so it only uses `LWC_RPC_AUTH` or
`--endpoint-auth`.

Write `env:NAME` as the value to read the header from environment variable
`NAME` at parse time, so the key never enters argv, shell history, or process
listings:

```bash
npm run compare -- drpc=https://xlayer.drpc.org okx=https://xlayerrpc.okx.com \
  --endpoint-auth drpc=env:DRPC_KEY --endpoint-auth okx=env:OKX_KEY
```

`NAME` must be a valid environment variable name and must be set and non-empty
when `compare` starts; a missing value fails with an error naming the variable
before any request is made, and the resolved header is still rejected if it
contains a newline. Inline values such as `drpc=Bearer …` remain supported but
are visible in process listings.

`--json` reports the same numbers with bigints as strings, and the exit code is
`1` only if an endpoint failed a round or reported the wrong chain id — being a
block behind is reported, not treated as a failure. Both RPCs are pinned to
`LWC_CHAIN_ID`, so pointing one at another network shows up as
`answered chain 1, expected 196` instead of a bogus latency comparison.

### Logging comparisons

`--log <path>` appends one JSON line per run, so repeated comparisons show which
provider wins over time:

```bash
npm run compare -- drpc=https://xlayer.drpc.org okx=https://xlayerrpc.okx.com \
  --log ./compare.ndjson
```

```json
{"session":"m3k2-9f1a2c","event":"compare","at":"2026-11-09T12:00:00.000Z","chain":{"id":196,"name":"xlayer"},"samples":5,"intervalMs":1000,"newBlocks":5,"fastest":"https://xlayer.drpc.org","freshest":"https://xlayerrpc.okx.com","endpoints":[{"url":"https://xlayer.drpc.org","label":"drpc","ok":true,"p50":142,"p95":310,"head":"75419519","headLag":1,"roundsBehind":1,"headAgeSeconds":0,"delivery":{"wins":3,"observed":5,"misses":0,"p50Ms":0,"p95Ms":24},"errors":0,"chainMismatch":false,"error":null}]}
```

Every line carries a `session` id, the `fastest` and `freshest` URLs, and each
endpoint's p50/p95, head, lag, delivery (`wins`/`observed`/`misses` and p50/p95
delay), and error count, so
`jq -r '[.session, .fastest] | @tsv' compare.ndjson` lists the winner over time.
Endpoint URLs are recorded as origin and path with query strings, fragments, and
userinfo removed, and URLs inside error messages are sanitized the same way, so
an API key in an endpoint URL never reaches the log; `--endpoint-auth` values and
auth headers are never written at all. `--log-max-size` (same sizes as `watch`)
rotates the file to `<log>.1` past the limit and requires `--log`.

`compare-history <compare.ndjson>` summarizes the log across runs without
contacting an endpoint, so it needs no `LWC_RPC_URL` or auth setup:

```bash
npm run compare-history -- ./compare.ndjson
```

```
lwc — compare history

  log          ./compare.ndjson
  runs         3 (2026-11-09T12:00:00.000Z → 2026-11-09T12:10:00.000Z)
  new blocks   15
  chain        xlayer (196)

  provider       runs  wins  win%   delay   last  last seen
  drpc              3    11   73%     4ms    0ms  11-09 12:10
  okx               3     4   27%    31ms   34ms  11-09 12:10
```

`wins` totals the heads each provider delivered first, `win%` is those wins as a
share of the new blocks in the runs where it appeared, and `delay` is the median
across runs of each run's own median head delay; `last` is the newest of those
medians. Malformed lines are counted, not fatal, and other event types in a
mixed log are ignored. `--json` adds the per-run series under `history` so one
file can be charted over time.

`--csv <path>` writes one row per run and provider for spreadsheet analysis,
repeating the run's session, chain, and sample counts on each row so the file
pivots by provider, run, or time without parsing nested JSON:

```bash
npm run compare-history -- ./compare.ndjson --csv ./providers.csv
```

```
session,at,chain,chain_id,samples,new_blocks,provider,provider_url,wins,observed,misses,delay_ms,errors,ok
s-mw8la2ze,2026-11-09T12:00:00.000Z,xlayer,196,5,4,drpc,https://xlayer.drpc.org,3,4,0,0,0,true
s-mw8la2ze,2026-11-09T12:00:00.000Z,xlayer,196,5,4,okx,https://xlayerrpc.okx.com,1,4,0,40,0,true
```

`provider` is the label, or the sanitized URL when the run had none;
`delay_ms` is empty when that provider saw no new heads in the run. `--csv -`
prints the CSV instead of writing it, the parent directory is created as needed,
and `--json` still returns the nested report when no CSV is requested.

## Checking many addresses

`scan` reads the same token set for a list of owners, and can write the result as
CSV:

```bash
npm run scan -- 0xAddrA 0xAddrB --tokens-file ./examples/xlayer.tokens.json
npm run scan -- --owners-file ./owners.json --tokens-file ./examples/xlayer.tokens.json --csv ./balances.csv
```

```
lwc — scan

  chain         xlayer (196)
  block         75418547
  owners        2
  tokens        2

  owner         0x000000000000000000000000000000000000dEaD
    native      61.997998034799592649 OKB
    USDT (0x1E4a…D41d)  0.028275
    WOKB (0xe538…9b2b)  280.072887730740496648
```

Owners come from positional addresses, `--owner`, or `--owners-file` (a JSON
array, or an object with an `owners` or `addresses` array); tokens from
`--token`, `--tokens`, `--tokens-file`, with the same checksumming and dedupe as
`balances`. Each owner still costs one Multicall3 call, four owners at a time, so
a hundred addresses are a hundred calls rather than thousands. The `block` line
is the head recorded at the start of the scan.

`--csv <path>` writes a header of `owner`, `native (<symbol>)`, then one column
per token labelled `<symbol> (<0x…>)`, a `labels` column mapping labelled tokens
to their names, and a final `flag` column listing every flagged token and its
issue (empty when none; multiple flags are separated by ` | `), with one row per
owner. Amounts are decimal, not raw wei; a token that could not be read leaves
an empty cell rather than a wrong number. Fields containing a comma, quote, or
newline are quoted and internal quotes doubled, so the file opens cleanly in a
spreadsheet. `--csv -` prints the CSV instead of writing a file, and `--csv`
cannot be combined with `--json`.

Each Multicall3 chunk also reports its outcome on stderr as it completes, keeping
`--json` and `--csv` stdout clean:

```
  chunk 0x0000…dEaD 1/3 (12 tokens) ok
  chunk 0x0000…dEaD 2/3 (12 tokens) retried, partial, 6 individual
```

`--quiet` suppresses those per-chunk lines while keeping everything else: the
final table (including warnings and the fallback list), `--csv`, and `--json`
are unchanged.

`--fail-on-retry` exits with status 1 when any chunk needed recovery — its first
Multicall3 request failed, whether or not the retry or individual fallback
recovered the tokens. It composes with `--quiet`, `--csv`, and `--json`, which
all keep their normal output, so a CI job can gate on the exit code while still
archiving the report.

If a chunk still cannot be batched, the final report lists exactly which tokens
were read individually, with the owner and chunk they came from:

```
  fallbacks     1 token read individually
    0x0000…dEaD  chunk 2/3  0x1E4a5963aBFD975d8c9021ce480b42188849D41d USDT
```

`--json` exposes the same detail as `chunks` (status, retry outcome, per-chunk
individual addresses) and `fallbacks` (owner, chunk, token, symbol, label), plus
the selected `batchSize` and total `chunkCount` across owners. The
`recovery` line and JSON object count first-attempt failures, retry requests,
and fully recovered chunks across all owners, so a chunk rescued by its retry
is still visible in the summary and per-owner chunk status.

### Charting balance history

`history` turns the `portfolio` events in a watch log into a CSV time series,
one row per asset per sample, ready for a spreadsheet or chart:

```bash
npm run watch -- --interval 30 --owner 0xYourAddress \
  --tokens-file ./examples/xlayer.tokens.json --log ./watch.ndjson
npm run history -- ./watch.ndjson --csv ./balances.csv
```

```
session,at,block,asset,address,symbol,label,decimals,balance,delta,usd,usd_total
mw8la2ze-bc6f92,2026-11-09T12:31:05.000Z,75418547,native,,OKB,,18,1.25,,124.21,126.71
mw8la2ze-bc6f92,2026-11-09T12:31:05.000Z,75418547,token,0x1E4a…D41d,USDT,Tether USD,6,2.5,1.5,2.50,126.71
```

`at` is ISO 8601 in UTC, `balance` and `delta` are decimal amounts scaled by the
token's `decimals` (raw base units when it could not be read), and `delta` is
empty for the first sample of a session. Long format keeps the columns stable as
the token set changes: pivot on `at` with `symbol` as the series if your chart
tool wants one column per asset. `usd` is the asset's value at the sample's
prices and `usd_total` repeats the sample total; both are empty unless the log
came from `watch --usd`.

`--csv -` prints the CSV instead of writing it, `--session <id>` keeps one run
from a log that holds several, and without `--csv` the rows are printed as a
table. Logs are read locally — no RPC call — and a portfolio sample that failed
is counted in the header rather than written as blank rows. `--json` emits the
same rows with bigints as decimal strings.

`--wide` pivots the same log the other way: one row per portfolio sample and one
column per asset, for tools that expect a single time series per column.

```bash
npm run history -- ./watch.ndjson --csv ./balances-wide.csv --wide
npm run history -- ./watch.ndjson --csv ./balances-wide-usd.csv --wide --usd
npm run history -- ./watch.ndjson --csv ./balances-wide-usd-only.csv --wide --usd-only
```

```
session,at,block,OKB,USDT,WOKB,usd_total
mw8la2ze-bc6f92,2026-11-09T12:31:05.000Z,75418547,1.25,2.5,280.07,126.71
mw8la2ze-bc6f92,2026-11-09T12:31:35.000Z,75418548,1.2,2.5,281.57,123.93
```

Columns follow the order the assets first appear, named by symbol; two assets
sharing a ticker gain a short address (or `native`) suffix so each keeps its own
series. An asset absent from a sample leaves its cell empty rather than
repeating an old value, `session`, `at`, and `block` stay as the first three
columns so a multi-session log remains distinguishable, and amounts are decimal
like the long format. `usd_total` is the sample's portfolio total, empty unless
the log came from `watch --usd`. Add `--usd` to append a `SYMBOL (USD)` column
for every asset after the balance columns; an unpriced asset leaves its USD cell
empty. `--usd-only` keeps just those USD columns and drops the raw balances, so
every asset column is a dollar series, with `usd_total` last:

```
session,at,block,OKB (USD),USDT (USD),WOKB (USD),usd_total
mw8la2ze-bc6f92,2026-11-09T12:31:05.000Z,75418547,113.83,2.50,10.38,126.71
```

`--wide` requires `--csv` (`--csv -` prints the pivot), `--usd` and `--usd-only`
require `--wide`, and `--json` continues to emit the long-format rows.

### Rendering the USD total in the terminal

`plot` reads either history CSV — the long table or the `--wide` pivot — and
draws the portfolio's USD total as a sparkline, so a quick look needs no
spreadsheet or chart tool:

```bash
npm run history -- ./watch.ndjson --csv ./balances.csv
npm run plot -- ./balances.csv
```

```
lwc — portfolio USD total

  csv          ./balances.csv
  samples      3
  window       2026-11-09T12:00:01.000Z → 2026-11-09T12:01:01.000Z
  total        $101.50 → $93.00  (-$8.50, -8.37%)
  range        $93.00 – $101.50

   $101.50 ┤█▅▄
    $93.00 ┤
           └─ 12:00:01 → 12:01:01 UTC
```

Each portfolio sample becomes one point even though the long CSV repeats
`usd_total` on every asset row, so a three-asset sample is not charted three
times. When `usd_total` is empty — a partly priced sample — the row-level `usd`
values are summed instead, and a sample with no priced holdings at all is
counted as `unpriced` rather than drawn as zero. `--width <n>` sets the
sparkline width (10–200, default 48); a longer series is averaged into that many
buckets, and a flat series draws level. `--json` returns the series (`session`,
`at`, `usdTotal`), first/last/min/max, change, and the chart string.

The CSV can be either format written by `history --csv`: the long table, or the
`--wide` pivot, whose `usd_total` column is charted directly — including the
`--usd-only` pivot, where every asset column is already a dollar value. A file
with no `usd_total` column at all is rejected, and `watch` must have run with
`--usd` for samples to be priced.

## Typed contract calls

`readTyped` checks the function name and arguments against the ABI at compile
time and derives the return type from the function's outputs, so neither the
function name nor the result needs a cast:

Typical use, with the client from `buildClient`:

```ts
import { erc20Abi } from "viem";
import { readTyped } from "./src/index.ts";

const balance = await readTyped(
  client,
  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", abi: erc20Abi },
  "balanceOf",
  "0xYourAddress",
);
// balance is bigint — inferred from the ABI, no cast needed
```

`createReader(client, { address, abi })` binds the contract once and returns a
callable for repeated reads:

```ts
const usdc = createReader(client, { address: USDC, abi: erc20Abi });
const symbol = await usdc("symbol"); // string
const decimals = await usdc("decimals"); // number
```

### Running every view function

`views` lists every `view`/`pure` function in an ABI file and calls the ones it
can against a contract:

```bash
npm run views -- 0xToken
npm run views -- 0xToken --args '["0xYourAddress"]'
npm run views -- 0xToken --args '{"allowance":["0xOwner","0xSpender"]}'
npm run views -- 0xToken --abi ./examples/erc20.abi.json
npm run views -- 0xToken --block 75416693
```

```
lwc — view calls

  contract      0x1E4a5963aBFD975d8c9021ce480b42188849D41d
  abi           built-in ERC-20
  functions     6 view/pure: 4 called, 0 failed, 2 skipped
  block         75421067

  name()                               Tether USD
  symbol()                             USDT
  decimals()                           6
  totalSupply()                        123456789000000
  balanceOf(address)                   skipped: needs 1 argument(s)
  allowance(address, address)          skipped: needs 2 argument(s)
```

`--abi` is optional: without it the built-in ERC-20 ABI is used, which covers
`name`, `symbol`, `decimals`, `totalSupply`, `balanceOf`, and `allowance`.
Pass `--abi` for any other contract.

Zero-argument functions run immediately. A function that needs arguments is
listed as skipped unless `--args` supplies them: a JSON array is applied to
every function whose arity matches (zero-argument functions still run), while an
object keyed by function name targets exactly that function — use a full
signature such as `balanceOf(address)` or `set((bool,bytes))` to pick one
overload, and whitespace in a
key is ignored. A revert or a bad
argument type fails only that row, `--json` carries the same rows with bigints as
strings, and the exit code is `1` if any call failed. Non-`view` functions in the
ABI are listed nowhere and never called.

Every callable function is packed into a single Multicall3 `aggregate3` request
pinned to the block in the header, so a wide ABI costs one round trip instead of
one per getter. `allowFailure` keeps a reverting getter in its own `error:` row —
a standard `revert("…")` reason is decoded — while its neighbours still return
values. If the aggregate itself cannot be used (no Multicall3 on the chain, or
an RPC that rejects it), the same calls are retried individually, so the output
is identical, just slower.

`--max-subcalls <n>` caps each `aggregate3` request at `n` sub-calls (1–1000),
splitting a wide ABI across several requests pinned to the same block. Each
request keeps `allowFailure`, and only a group whose batch fails falls back to
individual reads. The header reports the request count when the flag is used,
and `--json` adds `chunkCount` and `maxSubCalls`:

```bash
npm run views -- 0xToken --max-subcalls 10
```

`--block` pins the run to a block number (or `latest`, the default), so repeating
the command against the same block returns the same values: the header reports
that block, every read is made at it, and the head is never looked up.

### Listing callable signatures

`signatures` prints every callable (`view`/`pure`) signature in an ABI, sorted
and ready to copy into `views --args` or a `call` function argument:

```bash
npm run signatures -- ./examples/erc20.abi.json
npm run signatures            # built-in ERC-20 ABI
npm run signatures -- --json
```

```
lwc — callable signatures

  abi           examples/erc20.abi.json
  signatures    6 view/pure

  allowance(address, address)
  balanceOf(address)
  decimals()
  name()
  symbol()
  totalSupply()
```

Tuple components are expanded, so overloads that differ only inside a tuple
produce distinct lines, exactly as they must be written in `--args`.

### Example call

```bash
npm run example
npm run example -- --json
```

Reads three view functions from the canonical Multicall3 deployment
(`0xcA11bde05977b3631167028862bE2a173976CA11`), which exists on most EVM chains:

```
lwc — example contract call

  contract      Multicall3 (0xcA11bde05977b3631167028862bE2a173976CA11)
  chain         xlayer (196)
  latency       412 ms

  getChainId()                196  matches LWC_CHAIN_ID
  getBlockNumber()            75416480
  getCurrentBlockTimestamp()  1794185600 (4s old)
```

The example is self-verifying: `getChainId()` must equal `LWC_CHAIN_ID`, so the
contract's answer cross-checks the RPC's. If Multicall3 is not deployed on your
chain, the command says so explicitly instead of returning a decode error.

## Watch mode

```bash
npm run watch
npm run watch -- --interval 3 --stall-after 30
npm run watch -- --samples 5          # stop after 5 polls
npm run watch -- --json               # newline-delimited JSON events
npm run watch -- --owner 0xYourAddress --tokens-file ./examples/xlayer.tokens.json
```

Polls block height, gas price, and chain id, then reports what changed:

```
lwc — watching xlayer (196) every 3s, stall threshold 30s, gas surge +50%

12:00:00  block 75416693 (+0)  0.021 gwei  794 ms
12:00:03  block 75416695 (+2)  0.021 gwei  187 ms
12:00:06  block 75416695 (unchanged 3s)  0.021 gwei  165 ms
12:00:39  STALL: block 75416695 has not advanced for 33s
12:00:42  RECOVERED: 75416695 → 75416698 after 36s
12:00:45  CHAIN DRIFT: expected 196 (xlayer), RPC answered 1
12:00:48  GAS SURGE: 0.063 gwei, +200% over 0.021 gwei baseline
12:01:10  GAS NORMAL: 0.022 gwei (baseline 0.021 gwei)
```

Events: `advance` (new block), `hold` (unchanged, below threshold), `stall`
(unchanged past the threshold, reported once per episode), `recovered`,
`gas-surge`, `gas-normal`, `error`, and `chain-drift`, which fires when the RPC
answers a chain id other than `LWC_CHAIN_ID` and only repeats if the wrong id
changes. With a portfolio configured, a `portfolio` event follows each sampled
poll with the current balances and their change since the previous one.

Gas surges compare the current `eth_gasPrice` against the **median of the last
10 readings**, so a single blip or slow drift does not trigger them. A surge is
reported once per episode; `gas-normal` needs the price to fall back below half
the threshold, which stops a price hovering at the line from flapping.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--interval <s>` | `3` | Seconds between polls, 1–300 |
| `--stall-after <s>` | `30` | Staleness that counts as a stall, at least `--interval` |
| `--gas-surge <pct>` | `50` | Percent above the rolling gas baseline that flags a surge, 1–10000 |
| `--samples <n>` | `0` | Stop after n successful polls; `0` runs until Ctrl+C |
| `--window <n>` | `20` | Rolling window for latency and block-time statistics, 5–1000 |
| `--report-every <n>` | `0` | Emit a rolling METRICS line every n samples; `0` disables it |
| `--log-max-size <size>` | `0` | Rotate the `--log` file to `<log>.1` past this size (`512kb`, `10mb`); `0` disables it |
| `--owner <0x…>` | – | Owner whose saved portfolio is read; needs `--tokens-file` |
| `--tokens-file <path>` | – | Token list for the portfolio, labels included |
| `--portfolio-every <n>` | `1` | Sample the portfolio every n polls |
| `--batch-size <n>` | auto | Tokens per Multicall3 request for portfolio reads, 1–100; auto is 12 uncached and 24 once metadata is cached |
| `--max-subcalls <n>` | – | Fixed sub-call cap per portfolio request, 1–1000; cannot be combined with `--batch-size` |
| `--usd` | off | Value the portfolio in USD with DefiLlama prices (60 s cache); needs `--owner` and `--tokens-file` |
| `--alert-queue <path>` | derived | File holding undelivered webhook alerts; defaults to `<log>.alerts.json` or `.lwc-cache/webhook-queue.json` |

### Watching a portfolio

`--owner` plus `--tokens-file` adds a balance reading to the poll, so a saved
portfolio can be tracked without running `balances` by hand:

```
lwc — watching xlayer (196) every 3s, stall threshold 30s, gas surge +50%
  portfolio → 0x000000000000000000000000000000000000dEaD, 3 tokens every 1 poll(s)

12:00:00  block 75416693 (+0)  0.021 gwei  794 ms
12:00:00  PORTFOLIO  block 75416693
  native 61.997998034799592649 OKB
  USDT [Tether USD] 0.028275
  WOKB 280.072887730740496648
12:00:03  block 75416695 (+2)  0.021 gwei  187 ms
12:00:03  PORTFOLIO  block 75416695
  native 61.997998034799592649 OKB (no change)
  USDT [Tether USD] 0.028275 (no change)
  WOKB 281.572887730740496648 (+1.5)
```

The summary keeps the first and last reading of each holding, so a long run ends
with the net change rather than only the final snapshot:

```
  portfolio     2 samples
                 OKB 61.997998034799592649 (no change)
                 USDT 0.028275 (no change)
                 WOKB 281.572887730740496648 (+1.5)
```

`--usd` values the same sample in dollars. Prices come from DefiLlama's free
coins API — one batched request per minute, chain slug `xlayer`, native OKB by
its CoinGecko id — and each row gains an approximate value while the header
shows the total:

```
12:00:00  PORTFOLIO  block 75416693  total $6,161.91
  native 61.997998034799592649 OKB (no change)  ≈ $6,161.88
  USDT 0.028275 (no change)  ≈ $0.03
```

An asset the feed cannot price is left without `≈`, and an unpriced asset never
counts as zero in the total. A failed price request is reported on a `prices`
line without stopping the balance read. The 60-second cache keeps a 3-second
poll at one price request a minute; `--usd` needs `--owner` and `--tokens-file`.

Labels come from the token list file. Metadata is cached in memory for the run,
so after the first sample each poll only re-reads `balanceOf`, and a fully cached
portfolio packs 24 tokens per Multicall3 request instead of 12 (unless
`--batch-size` is set). JSON portfolio events carry that sample's `batchSize`
and `chunkCount` (both `null` when the read failed). A failed portfolio read is
reported inside the `portfolio` event and does not interrupt chain watching.

`--verbose` prints the same per-chunk portfolio lines to stderr for every
sample — chunk position, token count, `retried, recovered` / `retried, partial`
/ `failed`, and the individual fallback count — so retries are visible while
the watch runs. The event stream, `--json`, and the log file are unchanged.

### Rolling reliability report

The summary is a windowed report on RPC reliability, not just a snapshot:

```
  samples       24
  duration      72s
  block         75417639 → 75417711 (+72)
  gas           0.021 gwei (peak 0.025 gwei)
  latency       p50 344 ms, p95 718 ms, max 1097 ms (20 samples)
                session p50 330 ms, p95 900 ms, max 2401 ms (24 samples)
  block time    median 0.9s, min 0.6s, max 2.1s (20 intervals)
                session median 0.9s, min 0.4s, max 9.8s (22 intervals)
  failures      0 of 20 polls (0%)
                session 1 of 24 polls (4.2%)
  gas surges    0
  stalls        0
  chain drift   none
  errors        0
```

Latency is measured per poll, block time is measured between consecutive head
advances, and both use `--window` (default 20) so the numbers describe the
recent state of the endpoint rather than the whole session. `--report-every 10`
prints the same statistics mid-run:

```
12:11:17  METRICS: latency p50 344 ms, p95 718 ms, max 1097 ms | block time median 0.9s | errors 0/20 | session latency p50 330 ms, p95 900 ms, max 2401 ms | session block time median 0.9s | session errors 0/24
```

A high p95 with a low p50 points at intermittent RPC stalls; a block time
drifting above the chain's nominal interval points at head lag at the gateway.
The rolling numbers use `--window`; each `session` line pools every poll since
the run started, so a long service shows recent health and whole-run reliability
side by side. `--json` carries the same totals as `cumulative` on each `metrics`
line and as `session` in the summary, matching the `cumulative` block in alert
payloads.

Stops on Ctrl+C and prints the summary above (samples, duration, block movement,
gas level and peak, latency, block time, failures, gas surges, stalls, drift,
errors). Transient RPC errors are
counted and retried; five consecutive failures end the run. The exit code is `1`
if any stall, gas surge, or chain drift occurred, otherwise `0`, so it works as a
CI or cron check. `--json` emits one JSON object per line, with bigints as
decimal strings and the summary as the final line.

### Alerting on thresholds

`--alert-latency <ms>` and `--alert-block-time <s>` watch the rolling p95 latency
and median block time; `--alert-webhook <url>` POSTs JSON when one of them — or
the balance threshold below — crosses its limit.

```bash
npm run watch -- --interval 5 --window 20 --report-every 6 \
  --alert-latency 1500 --alert-block-time 5 \
  --alert-webhook https://example.com/hooks/rpc --log ./watch.ndjson --detach
```

Set `LWC_WEBHOOK_AUTH` (in `.env` or the environment) to send that value as the
`Authorization` header on every alert POST, for a receiver behind an auth proxy.
`--alert-webhook-auth "Bearer <token>"` still works as an explicit override and
wins over the variable, but keeping the value in `.env` keeps it out of shell
history and process listings. The value is never written to the watch log.

The webhook is edge-triggered, not a loop: one POST when the metric rises above
the threshold and one when it drops back under, so a sustained breach does not
spam the endpoint. The body is the logged event plus context:

```json
{
  "session": "mw8la2ze-bc6f92",
  "at": "2026-11-09T01:35:17.575Z",
  "event": "alert",
  "metric": "latency",
  "direction": "breach",
  "value": 1820,
  "threshold": 1500,
  "chain": { "id": 196, "name": "xlayer" },
  "metrics": {
    "samples": 120,
    "windowSize": 20,
    "latency": {
      "count": 20,
      "p50": 344,
      "p95": 1820,
      "min": 120,
      "max": 2401,
      "mean": 512
    },
    "blockTime": {
      "count": 19,
      "medianSeconds": 0.9,
      "minSeconds": 0.6,
      "maxSeconds": 2.1,
      "meanSeconds": 1.02
    },
    "windowFailures": 0,
    "windowPolls": 20,
    "errorRate": 0
  },
  "cumulative": {
    "samples": 340,
    "failures": 2,
    "polls": 342,
    "errorRate": 0.0058,
    "latency": {
      "count": 340,
      "p50": 302,
      "p95": 640,
      "min": 88,
      "max": 4820,
      "mean": 355
    },
    "blockTime": {
      "count": 338,
      "medianSeconds": 0.9,
      "minSeconds": 0.4,
      "maxSeconds": 9.8,
      "meanSeconds": 1.1
    }
  }
}
```

`metric` is `latency` (p95, in ms) or `block-time` (median, in seconds), and
`direction` is `breach` or `clear`, and `metrics` is the full rolling snapshot
that triggered the alert — latency p50/p95/min/max/mean, block time, failure
counts, and error rate — so the receiver can triage without calling back.
`cumulative` carries the same latency and block-time shape over every poll in
the run so far, plus total `samples`, `failures`, `polls`, and `errorRate`, so a
receiver can tell a one-off spike from a sustained problem. Both objects are
written to the watch log on the `alert` line. Delivery has a 3 s
timeout and is queued, so
polling never waits on the receiver. Failed POSTs are retried in enqueue order
with exponential backoff (0.5 s doubling to a 30 s cap) until accepted; each
retry is logged as `webhook-retry`.

The pending queue is written to disk, so an alert survives a crash or a stop:
`--alert-queue <path>` sets the file, and without it the queue lives at
`<log>.alerts.json` when `--log` is set or `.lwc-cache/webhook-queue.json`
otherwise. The file is rewritten atomically after every change and an alert is
removed only once the receiver accepts it. On the next `watch`, pending alerts
are replayed in order and a `webhook-replay` line records the count; if a run
stops with alerts still queued it writes `webhook-pending` with the count and
leaves them on disk. Delivery is at-least-once: a crash between a successful
POST and the queue rewrite can resend one alert. The `alert` event itself is
always in the log. Thresholds without a webhook still print and log
`ALERT` lines. The exit code is unchanged — a threshold crossing is a
monitoring signal, not a failed run.

### Alerting on balance moves

`--alert-balance <percent>` applies the same webhook to the portfolio: after each
portfolio sample, every token and the native balance is compared with its
previous reading, and a move larger than the percentage raises a `balance-alert`
event. It needs `--owner` and `--tokens-file`.

```bash
npm run watch -- --interval 30 --owner 0xYourAddress \
  --tokens-file ./examples/xlayer.tokens.json \
  --alert-balance 25 --alert-webhook https://example.com/hooks/wallet --log ./watch.ndjson
```

```
12:31:05  BALANCE ALERT: USDT [Tether USD] -60% (2.5 → 1) exceeds 25%
```

Unlike the latency and block-time thresholds this fires on the sample where the
move happened — there is no `clear` event, because a past change is not an
ongoing state. The first sample has nothing to compare and never alerts, a move
exactly at the threshold is ignored, unreadable balances are skipped, and a
balance that was zero alerts on any non-zero reading with `(from zero)` in place
of a percentage. Balance alerts count towards the summary's `alerts` total, are
written to the watch log as `balance-alert` lines, and are POSTed to
`--alert-webhook` like the other alerts.

### Running it as a service

`--log <path>` appends every event to a file as one JSON object per line: a
`start` line with the chain and options, each `advance`/`hold`/`stall`/`metrics`
event, and a final `summary` line. The file is opened in append mode and never
truncated, so successive runs accumulate and can be read back with any JSON-lines
tool. Every line carries a `session` id, so several runs in one file stay
separable: group `metrics` and `summary` lines by `session` to compare p50/p95
latency, block time, and stalls between them. Each `start` line also records the
sanitised RPC endpoint — origin and path, with query strings and key-like path
segments removed — so reliability can be attributed to a provider without
writing an API key into the log.

Pass `--log-max-size` to bound a long-lived file. Before a line would push the
active file past the limit, it is renamed to `<log>.1` — replacing any older
backup — and a fresh file starts, so the log stays under the limit plus one line
and a JSON record is never split. A session that spans a rotation has its events
divided between `<log>.1` and `<log>`, so run `sessions` on each file when
comparing. `--log-max-size` requires `--log`.

```bash
npm run watch -- --interval 5 --window 20 --report-every 6 --log ./watch.ndjson
```

`--detach` starts that run in the background and returns immediately. Console
output goes to `<log>.out` and the child's pid to `<log>.pid`:

```bash
npm run watch -- --interval 5 --window 20 --report-every 6 --log ./watch.ndjson --detach
# lwc watch detached (pid 48213); events → ./watch.ndjson, console → ./watch.ndjson.out
```

Stop it with `--stop`, naming the same log file. That writes `<log>.stop`, which
the running service checks twice a second; it removes the marker, finishes the
current sample, and writes the rolling summary to the log and `<log>.out`:

```bash
npm run watch -- --log ./watch.ndjson --stop
```

`--stop` exists because signals are not portable here: `SIGINT`/`SIGTERM` are
handled and produce the same clean summary on Linux and macOS, but a detached
process on Windows cannot receive them, so `kill` terminates it without a
summary. Either way the exit code is `1` if any stall, gas surge, or chain drift
occurred. Because `--window` bounds the statistics, a service that runs for days
keeps reporting recent latency instead of an average dragged down by old
samples. `--detach` requires `--log`.

### Comparing sessions

`sessions` reads a `--log` file, groups the lines by `session` id, and prints one
row per run, so p50, p95, stalls, and errors can be compared side by side. The
`rpc` column names the endpoint each run used, so a bad p95 can be pinned on the
provider that served it:

```bash
npm run sessions -- ./watch.ndjson
npm run sessions -- ./watch.ndjson --json
```

A long log can be narrowed before the comparison:

```bash
npm run sessions -- ./watch.ndjson --since 24h
npm run sessions -- ./watch.ndjson --since 2026-11-09T12:00:00Z
npm run sessions -- ./watch.ndjson --session m1abc2
npm run sessions -- ./watch.ndjson --session m1abc2 --session m1def4 --since 7d
```

`--since` takes an ISO timestamp or a span measured back from now (`30m`, `24h`,
`7d`) and keeps sessions that started at or after it; a session with no timestamp
is dropped once a cutoff is set. `--session` is repeatable and matches session-id
prefixes — an exact id is a prefix of itself — so a prefix can keep a run and its
retries together. Filtered-out lines are not counted as malformed.

`--csv <path>` writes one row per session, with the same fields as the table,
for spreadsheet analysis; filters apply before the export:

```bash
npm run sessions -- ./watch.ndjson --csv ./sessions.csv
```

```
session,started_at,ended_at,state,chain,chain_id,endpoint,duration_ms,samples,latency_p50_ms,latency_p95_ms,latency_max_ms,block_time_median_s,block_time_min_s,block_time_max_s,stalls,gas_surges,alerts,errors,chain_drift,first_block,last_block,advanced_by
m1abc2-x9y8z,2026-11-09T12:00:00.000Z,2026-11-09T12:00:42.000Z,complete,xlayer,196,https://xlayer.drpc.org,42000,4,200,400,400,3,3,6,1,1,0,1,false,100,102,2
```

Missing latency or block-time measurements leave those cells empty, and
`--csv -` prints the CSV instead of writing it. The parent directory is created
as needed, and `--json` is used only when no CSV is requested.

Latency percentiles are recomputed from every `advance`/`hold` line in the
session rather than from the watch run's rolling `--window`, so runs started with
different windows stay comparable. A session with no `summary` line — killed
before it could finish, or still running — is kept and marked `partial`, with
block time falling back to the gaps between the logged advances. Malformed lines
are counted in the header instead of aborting the report.

Sessions are also pooled by RPC host, so providers can be compared directly:

```
  by endpoint

endpoint          sessions  polls    p50    p95  stalls  stall rate
xlayer.drpc.org          2      8    200    400       1       12.5%
```

Percentiles are taken over every poll served by that host, not averaged from
the per-session numbers, so a provider that handled more traffic weighs
accordingly. `stall rate` is stalls divided by polls for that endpoint, and the
`--json` report carries the same rows in an `endpoints` array. Because the table
and the grouping use the host, API keys in an endpoint path stay out of it.

`sessions` is local: it reads the file only and needs no RPC configuration.

## Calling any view function

```bash
npm run call -- 0xToken balanceOf --args '["0xYourAddress"]'
npm run call -- 0xToken "balanceOf(address)" --args '["0xYourAddress"]'
npm run call -- 0xToken balanceOf --abi ./examples/erc20.abi.json --args '["0xYourAddress"]'
npm run call -- 0xToken decimals --abi ./examples/erc20.abi.json
npm run call -- 0xToken allowance --abi ./examples/erc20.abi.json --arg 0xOwner --arg 0xSpender
npm run call -- 0xToken balanceOf --abi ./examples/erc20.abi.json --args '["0x…"]' --block 75417295 --json
```

```
lwc — contract call

  contract      0x1E4a5963aBFD975d8c9021ce480b42188849D41d
  function      balanceOf(address)
  block         75417295

  result        28275
```

`--abi` is optional: without it the built-in ERC-20 ABI is used, so a plain
token read needs no file. Pass `--abi` for anything that is not ERC-20.

The ABI drives everything, so arguments are coerced to the declared types
instead of guessed: `"100"` becomes a `uint256`, `0x…` becomes a checksummed
`address`, `"true"` becomes a `bool`, nested `tuple` and `address[]` inputs are
handled, and a `bytes32` argument is length-checked. Passing the wrong value
fails with the parameter name, e.g. `account expects an EVM address`.

Only `view` and `pure` functions are callable — a `nonpayable` entry such as
`transfer` is refused before any request is sent, because this client never
sends transactions. Unknown function names fail with the list of available
signatures.

Pass a function by bare name when the ABI names it only once. If the ABI
overloads that name, the bare name is rejected with the list of signatures rather
than silently calling the first one; pass the full signature, e.g.
`"transfer(address,uint256)"`. Spacing inside the signature is ignored, so
`balanceOf(address)` and `balanceOf( address )` are the same function. Tuple
components are expanded rather than collapsed to `tuple`, so
`submit((address,uint256))` and `submit((bool,bytes))` stay distinguishable, and
an array of tuples renders as `submit((address,uint256)[])`.

| Flag | Meaning |
| --- | --- |
| `--abi <path>` | Optional. JSON array of ABI items, or an object with an `abi` array; omit for the built-in ERC-20 ABI |
| `--args <json>` | Arguments as a JSON array |
| `--arg <json>` | One argument, repeatable; non-JSON values are treated as strings |
| `--block <n>` | Pin the call to a block number, or `latest` (default) |
| `--json` | Structured output with bigints as decimal strings |

Simple token reads need no ABI file at all; `examples/erc20.abi.json` is included
as a file copy you can edit and pass to `--abi`.

## Fixed-price market

`market` is a pool that quotes and settles every swap at **one price that never
moves**, so no trade can reprice — devalue — the token. It keeps its state in a
JSON pool file and needs no RPC, no key, and no chain:

```bash
npm run market -- --pool ./market.json --init \
  --price 28.842 --base ZPC --quote AUD --seed 1
npm run market -- --pool ./market.json --buy 5
npm run market -- --pool ./market.json --sell 0.1 --dry-run
npm run market -- --pool ./market.json
```

```
lwc — market

  pool          ./market.json
  base          ZPC (18 decimals)
  quote         AUD (6 decimals)
  price         28.842 AUD per ZPC (fixed)
  fee           30 bps

  reserve       0.5 AUD + 0.017335829692809098 ZPC
  liquidity     1 AUD in 1000000 shares

  volume        0 AUD over 0 swaps
  turnover      0× liquidity settled
  net flow      0 ZPC, 0 AUD
```

`--init` splits one liquidity amount evenly across both legs at the fixed price,
so `--seed 1` really opens a pool worth one dollar. Every later run performs at
most one operation and writes the file back atomically:

| Flag | Meaning |
| --- | --- |
| `--pool <path>` | The pool file to create, read, and update (required) |
| `--init` | Create the pool; needs `--price`, `--base`, `--quote`, `--seed` |
| `--price <n>` | Fixed price, quote per one whole base token (e.g. `28.842`) |
| `--base <symbol>`, `--quote <symbol>` | Labels used in output and in the file |
| `--base-decimals <n>`, `--quote-decimals <n>` | Decimals of each token (defaults 18 and 6) |
| `--fee-bps <n>` | Fee taken from the input leg and left in the pool (default 30, max 1000) |
| `--seed <amount>` | Total liquidity the pool opens with, split half quote and half base |
| `--buy <quote>`, `--sell <base>` | Swap at the fixed price |
| `--dry-run` | Price a swap, print the quote, write nothing |
| `--add <quote>`, `--add-base <base>` | Deposit liquidity for shares |
| `--remove <shares>\|all` | Burn shares for their pro-rata slice of both reserves |
| `--force` | Replace the pool file on `--init` |

A quote is always answered, even when it cannot be settled: `--dry-run` and
`--json` report `executable`, `issue` (`amount-too-small` or
`insufficient-liquidity`), and a human `reason`, and the exit code is `1` only
when the quote is not executable. A real swap that cannot be settled fails with
`market error: …` and leaves the file untouched. Every fill is reported with
`priceImpactBps: 0` — that field cannot be anything else.

### Why one dollar can settle a billion

A constant-product pool needs reserves worth the trade: with `x·y=k` a $1 pool
answers a $1 swap and the price has already moved. A fixed-price pool does not
discover price, so a buy and the matching sell leave the reserves exactly where
they started, minus nothing but the fee, which stays in the pool. Volume is
bounded by the number of swaps, not by the dollars on deposit:

| Round trips | Liquidity | Volume settled | Price |
| --- | --- | --- | --- |
| 1 | 1 AUD | 1 AUD | 28.842 |
| 1,000 | 1 AUD | 1,000 AUD | 28.842 |
| 1,000,000,000 | 1 AUD | 1,000,000,000 AUD | 28.842 |

The `one dollar of liquidity settles a billion units of volume` test runs the
middle row against a 1 AUD pool: 1,000 round trips settle 1,000,000,000 base
units of volume, and the reserves, the share count, and the price all come back
unchanged. Nothing in the engine caps the count, so the last row is the same
code with more cycles.

The one thing no market can do is pay out **net** directional flow from $1. If
traders only ever sell into the pool, someone has to fund the payout: 1,000,000
ZPC at 28.842 needs 28,842,000 AUD of quote. That trade is refused with
`insufficient-liquidity` and a quote that says why, rather than being silently
repriced or paid with freshly minted tokens. Net exposure is reported as
`net flow`, so the gap between volume and backing is always visible.

### Serving the pool over HTTP

`--serve` runs the same pool behind a small JSON API, so a web page can ask for
a quote and submit a swap without reading the pool file itself:

```bash
npm run market -- --pool ./market.json --serve --port 8787 --cors https://example.com
```

```
lwc — market api

  pool          ./market.json
  listening     http://127.0.0.1:8787
  price         28.842 AUD per ZPC (fixed)
  liquidity     1 AUD
  cors          https://example.com

  GET  /           swap page (open in a browser)
  GET  /quote?side=buy&amount=1
  POST /swap  {"side":"buy","amount":"1"}

  Ctrl+C stops the api.
```

| Route | Meaning |
| --- | --- |
| `GET /` | The swap page — buy/sell, a live quote as you type, recent fills |
| `GET /health` | Liveness, fixed price, symbols, fee |
| `GET /market` | Full state plus `capacity` (what one trade can settle now) |
| `GET /quote?side=buy\|sell&amount=<decimal>` | A quote with raw and formatted amounts |
| `POST /swap` with `{"side":"buy","amount":"5"}` | Fill at the fixed price, persisted before it is reported |

```bash
curl 'http://127.0.0.1:8787/quote?side=buy&amount=5'
curl -X POST http://127.0.0.1:8787/swap \
  -H 'content-type: application/json' \
  -d '{"side":"buy","amount":"5"}'
```

The page at `GET /` is a single self-contained document — inline CSS and
JavaScript, no external script, style, font or image — that prices a trade as
you type and lists the fills it submits. Served from the API's own origin it
needs no CORS setup; to point a copy hosted elsewhere at this API, pass the base
URL in the query string, e.g. `https://your.site/swap.html?api=https://market.example.com`,
and start the API with `--cors https://your.site`.

A quote always answers `200` with `executable` and, when it cannot be settled,
the `issue` and a human `reason` — so a page can price a trade and explain a
refusal without guessing. A swap that cannot be settled answers `422` with the
same quote attached and the pool file untouched. Bad input is `400`, an unknown
route `404`, a wrong method `405`, and every response carries
`cache-control: no-store`.

Amounts are decimal strings in each token's own units; `amountOutFormatted`,
`feeFormatted` and `notionalFormatted` are included so a page never has to know
about raw base units. Every response reports `priceImpactBps: 0`, because a
fixed-price fill cannot move the price.

The server binds `127.0.0.1` unless `--host` says otherwise, and sends no CORS
headers unless `--cors <origin>` (repeatable) or `--cors '*'` allows them. It
owns the pool file while it runs: swaps from the API and the CLI must not edit
the same file at once, and a swap is written to disk before the response is
sent.

`--api-key <key>` closes the API to anyone without that key (at least 8
characters, no spaces), so it can be exposed beyond loopback:

```bash
npm run market -- --pool ./market.json --serve --host 0.0.0.0 --port 8787 \
  --api-key "$(openssl rand -hex 16)"
```

Every route that reads or moves the pool — `/health`, `/market`, `/quote`,
`/swap` — answers `401` with `code: "unauthorized"` unless the request carries
the key as `x-market-key: <key>`, `Authorization: Bearer <key>`, or `?key=<key>`.
`GET /` stays reachable: the page shell holds no pool data, and it is where a
browser enters the key. The page keeps the key in `sessionStorage` for that tab
only, strips it from the address bar, and reuses it for every quote and swap.
The key is compared in constant time and never printed, so prefer the header in
scripts and treat a `?key=` link as a secret in your history and logs. Without
`--api-key` the API stays open, and the banner says so when it binds a
non-loopback address.

Requests are limited per client as well: 120 a minute by default, changed with
`--rate-limit <n>` (`0` turns it off), and a client that gets the key wrong ten
times in a minute is blocked for the next minute. Both answer `429` with a
`retry-after` header and a `code` of `rate-limited` or `too-many-attempts`.
`GET /` is never limited, so the unlock form stays reachable.

The counters survive a restart: they are written to `<pool>.limits.json` beside
the pool (another location with `--limits-file <path>`), and expired entries are
pruned on every write. The file holds client addresses and timestamps and
nothing else. If it cannot be written — a read-only directory, say — the API
keeps serving with in-memory limits and says so once on stderr. Separate
processes still count separately unless they share that file.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `LWC_CHAIN` | no | — | Built-in preset: `xlayer` or `base` (`--chain` overrides it) |
| `LWC_CHAIN_ID` | custom chains | preset's id | Chain id the RPC must report |
| `LWC_RPC_URL` | custom chains | preset's endpoint | `http(s)` JSON-RPC endpoint |
| `LWC_FALLBACK_RPC_URL` | no | preset's backup | Second endpoint tried when the primary is unreachable, times out, or answers the wrong chain; unused with `LWC_RPC_AUTH` |
| `LWC_CHAIN_NAME` | no | preset name, or `lwc-<chainId>` | Label used in output |
| `LWC_NATIVE_SYMBOL` | no | preset symbol, or `ETH` | Native currency symbol |
| `LWC_RPC_AUTH` | no | — | `Authorization` header value |
| `LWC_RPC_AUTH_<LABEL>` | no | — | Per-endpoint header for `compare`, named by the endpoint label (`drpc` → `LWC_RPC_AUTH_DRPC`) |
| `LWC_WEBHOOK_AUTH` | no | — | `Authorization` header for alert webhooks (`--alert-webhook-auth` overrides it) |
| `LWC_TIMEOUT_MS` | no | `10000` | Per-request timeout, 250–120000 |

Anything invalid fails fast with a `config error:` line and exit code 1, before
any network call.

## What it checks

1. **Chain id match** — `eth_chainId` must equal the configured chain id, from
   `LWC_CHAIN_ID` or the selected preset. A mismatch is a hard failure
   (`chain mismatch:`), which catches the common mistake of pointing at a testnet
   or a proxy for the wrong network.
2. **Liveness** — latest block number, its timestamp and age.
3. **Cost and client** — `eth_gasPrice` and `web3_clientVersion`, both tolerated
   as unavailable on endpoints that omit them.
4. **Latency** — wall time for the probe round trip.
5. **Advisories** — plaintext `http` to a remote host, and use of an auth header.

## Layout

```
src/chain.ts          config parsing, client factory, probe, formatting
src/chain.test.ts     offline unit tests (no network)
src/balances.ts       batched balance reads, arg parsing, formatting
src/balances.test.ts  offline unit tests (no network)
src/contract.ts       typed readContract helper, Multicall3 example
src/contract.test.ts  offline unit tests (no network)
src/watch.ts          poll loop, stall, drift and gas-surge detection
src/watch.test.ts     offline unit tests, no timers or network
src/sessions.ts       per-session comparison from a watch NDJSON log
src/sessions.test.ts  offline unit tests (no network)
src/rotate.ts         size-triggered NDJSON log rotation
src/rotate.test.ts    offline unit tests, real temp files
src/metrics.ts        rolling latency, block-time, and failure statistics
src/metrics.test.ts   offline unit tests (no network)
src/call.ts           ABI loading, argument coercion, view calls
src/call.test.ts      offline unit tests (no network)
src/signatures.ts     callable-signature listing from an ABI
src/signatures.test.ts offline unit tests (no network)
src/scan.ts           many-owner token scans and CSV output
src/scan.test.ts      offline unit tests (no network)
src/compare.ts        side-by-side RPC latency and head freshness
src/compare.test.ts   offline unit tests (no network)
src/market.ts         fixed-price pool: quotes, swaps, liquidity shares, pool file
src/market.test.ts    offline unit tests, real temp files
src/market-server.ts  JSON API over a pool (page, quotes, swaps, health)
src/market-server.test.ts  offline tests over loopback HTTP
src/market-page.ts    the self-contained swap page served at GET /
src/cli.ts            entry point (chain, balances, views, signatures, example, scan, compare, watch, call, sessions, market)
                      also installs the `lwc` binary via dist/cli.js
src/index.ts          library re-exports
```

## Library use

```ts
import { parseChainConfig, buildClient, probe } from "lovewebconnection";
// inside this repo, the same exports come from "./src/index.ts"

const config = parseChainConfig(process.env, "xlayer"); // or parseChainConfig(process.env)
const client = buildClient(config);
const health = await probe(client, config);

const balance = await client.getBalance({ address: "0x…" });
```

`client` is a standard [viem](https://viem.sh) `PublicClient`, so every read
action works: `getBalance`, `getBlock`, `readContract`, `getLogs`, `simulateContract`.

## Tests

```bash
npm run typecheck
npm test
```

The suite is offline and covers env validation, protocol and auth-header
rejection, warning rules, client chain binding, report formatting, balance
argument parsing, unit formatting, degraded token reads, single-call batching
with its fallback, typed call argument
forwarding, the example call's chain check, and watch-mode stall, drift, and
gas-surge detection with an injected clock, rolling percentile and window
trimming math, watch-log session grouping and per-session percentile
summarisation, and call-command ABI loading,
argument coercion, and output formatting. It makes no RPC calls and starts no
timers.

## Next step

To prove the connection end to end, run `npm run chain` with real values. If the
endpoint is your own node or a private network, set `LWC_RPC_AUTH` when it needs
a bearer token, and prefer `https` — `http` to a non-loopback host is reported as
a warning.
