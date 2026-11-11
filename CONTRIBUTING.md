# Contributing

Thanks for helping with `lwc`. The CLI is read-only by design: it holds no
private keys, signs nothing, and sends no transactions, so a change that adds
key handling or writes on chain is out of scope.

## Getting set up

Node.js 24+ and npm are required. `npm install` installs the dependencies and
the pre-commit hook, which runs `npm run typecheck` and `npm test` on every
commit. [Setup](README.md#setup) covers the environment file and how to skip the
hook when you need to.

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

## Scope

Keep changes read-only and dependency-light. A new runtime dependency needs a
clear reason, and the test suite must stay offline.
