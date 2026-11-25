# Contributing

Thanks for helping with `lwc`. The CLI is read-only by design: it holds no
private keys, signs nothing, and sends no transactions, so a change that adds
key handling or writes on chain is out of scope.

## Getting set up

Node.js 24+ and npm are required. `npm install` installs the dependencies and
the pre-commit hook, which runs `npm run typecheck` and `npm test` on every
commit. [Setup](README.md#setup) covers the environment file and how to skip the
hook when you need to.

The hook refuses a commit whose suite skipped more than the browser test. `php`
stays optional: with it installed, any proxy skip is refused, and without it the
hook refuses only when the staged files touch `explorer/rpc.php` or
`src/explorer-rpc.test.mjs`, warning instead for every other change. Set `LWC_PHP`
to a php binary with `curl` and `openssl` to run those twelve cases locally; CI
always does.

### The proxy tests on Windows

`src/explorer-rpc.test.mjs` needs a PHP CLI with the `curl` extension, and the
`openssl` CLI on `PATH` to make its loopback certificate. PHP's own OpenSSL
library is not enough: the test spawns `openssl` by name. The smallest setup
that gives both, with no package manager and no administrator rights:

1. Download the VS17 x64 zip from <https://windows.php.net/download/> (or run
   `winget install --id PHP.PHP.NTS.8.4 --scope user`) and extract it to
   `C:\php84`. Copy `php.ini-development` to `php.ini`, then uncomment
   `extension=curl` and `extension=openssl`.
2. Point the hook at that interpreter for future shells:
   `setx LWC_PHP "C:/php84/php.exe"`.
3. Append the OpenSSL CLI to the user `PATH` — the one Git for Windows already
   ships is enough, and appending it cannot shadow an existing tool:
   `powershell -Command "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';C:\Program Files\Git\usr\bin', 'User')"`.

Open a new terminal, then confirm the three parts:

```bash
openssl version
"$LWC_PHP" -m | grep -E '^(curl|openssl)$'
node --test src/explorer-rpc.test.mjs   # 12 pass
```

`openssl` resolving from MSYS2's `C:\msys64\ucrt64\bin` also works, but that one
entry puts a whole toolchain on `PATH`.

## Before you commit

```bash
npm run typecheck
npm test
```

The suite is offline and needs no RPC endpoint. Test files are listed one by one
in the `test` script in `package.json`; a new file that is not added there will
not run. Use `node:test`, and do not let tests reach the network.

One test does need a browser: `src/explorer-browser.test.ts` drives the explorer
page in headless Chrome and skips itself when none is installed. Set
`CHROME_PATH` to a Chrome, Edge or Chromium binary to run it, or
`LWC_SKIP_BROWSER=1 npm test` to skip only that file. [Tests](README.md#tests)
describes the CI steps, including the browser test's separate workflow step.

Install the distro package rather than a downloaded Chrome build: the package
pulls in the shared libraries (`libnss3`, `libatk`, `libgbm` and friends) that a
bare download expects and a fresh machine does not have. Then point
`CHROME_PATH` at the binary. It must be an absolute path — the test looks for a
file at that path, it does not search `PATH`, so `CHROME_PATH=chromium` finds
nothing:

| Platform | Install | `CHROME_PATH` |
| --- | --- | --- |
| Debian | `sudo apt update && sudo apt install chromium` | `/usr/bin/chromium` |
| Ubuntu | `sudo snap install chromium` (Chromium is snap-only there) | `/snap/bin/chromium` |
| Fedora | `sudo dnf install chromium` | `/usr/bin/chromium-browser` |
| Arch | `sudo pacman -S chromium` | `/usr/bin/chromium` |
| macOS | `brew install --cask chromium`, or use an installed Chrome | `/Applications/Chromium.app/Contents/MacOS/Chromium` |
| Windows | `winget install Chromium.Chromium`, or use an installed Chrome | `C:\Program Files\Chromium\Application\chrome.exe` |

`npm test` prints `skipped 1` when the browser test skipped, so a green run with
that count did not check the page.

## Scope

Keep changes read-only and dependency-light. A new runtime dependency needs a
clear reason, and the test suite must stay offline.
