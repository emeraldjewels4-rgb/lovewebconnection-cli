import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyCoinsAnswer } from "../deploy/serve.mjs";

// serve.mjs ships in the bundle and its startup "rails check" is the only thing that tells a
// deployer the /api/* target is the rails rather than the site. These four are the verdicts it
// must reach, because a proxy that trusts the status alone reports a base path one directory too
// high as configured while every browser parses an HTML page as JSON and shows nothing.
test("a JSON answer to /api/web9999/coins is accepted", () => {
  const verdict = classifyCoinsAnswer("application/json; charset=utf-8", '{"coins":[]}');

  assert.equal(verdict.ok, true);
  assert.equal(verdict.kind, "JSON");
  assert.equal(verdict.why, "");
});

test("an HTML page at 200 is refused, and the reason names HTML", () => {
  const verdict = classifyCoinsAnswer(
    "text/html; charset=utf-8",
    "<!DOCTYPE html><html><body>web9999</body></html>",
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.kind, "HTML");
  assert.match(verdict.why, /HTML/);
});

test("an empty body is refused even when the content type says JSON", () => {
  const verdict = classifyCoinsAnswer("application/json", "");

  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /empty/);
});

test("a JSON content type with a body that does not parse is refused", () => {
  const verdict = classifyCoinsAnswer("application/json", "{not json");

  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /does not parse/);
});
