// tests/unit/combo/combo-waf-html-block-403.test.ts
// Characterization of isWafHtmlBlockError + RR_FAIL_FAST_MS (combo-hang fix):
// a Cloudflare "Access denied" / errorCode 1010 403 is an HTML page, not a JSON
// auth error — the combo must treat it as transient so it fails over to the next
// target instead of surfacing a raw HTML page to the client. Genuine JSON 403
// auth errors (invalid key) must stay terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWafHtmlBlockError,
  RR_FAIL_FAST_MS,
} from "../../../open-sse/services/combo/comboPredicates.ts";

const CLOUDFLARE_1010_PAGE =
  '<!doctype html><html><head><meta charset="UTF-8"><title>Access denied | opencode.ai ' +
  "used Cloudflare to restrict access</title></head><body><h1>Access denied</h1>" +
  "<p>Your access to this website has been banned by the site owner.</p>" +
  "<code>Error code: 1010</code>";

test("exports isWafHtmlBlockError and RR_FAIL_FAST_MS", () => {
  assert.equal(typeof isWafHtmlBlockError, "function");
  assert.equal(typeof RR_FAIL_FAST_MS, "number");
  assert.ok(RR_FAIL_FAST_MS > 0);
});

test("403 + Cloudflare 1010 HTML body -> WAF block (transient)", () => {
  assert.equal(isWafHtmlBlockError(403, CLOUDFLARE_1010_PAGE), true);
});

test("403 + <!doctype html> alone -> WAF block", () => {
  assert.equal(isWafHtmlBlockError(403, "<!doctype html><html><body>blocked</body></html>"), true);
});

test("403 + lowercase 'cloudflare' marker -> WAF block", () => {
  assert.equal(isWafHtmlBlockError(403, "cloudflare blocked this request"), true);
});

test("403 + 'access denied' marker -> WAF block", () => {
  assert.equal(isWafHtmlBlockError(403, "Access denied by upstream gateway"), true);
});

test("403 + errorcode 1010 -> WAF block", () => {
  assert.equal(isWafHtmlBlockError(403, '{"errorCode":1010,"message":"blocked"}'), true);
});

test("JSON auth 403 (invalid key) is NOT a WAF block", () => {
  const body = '{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}';
  assert.equal(isWafHtmlBlockError(403, body), false);
});

test("403 with empty/absent body is NOT a WAF block (safe default)", () => {
  assert.equal(isWafHtmlBlockError(403, ""), false);
  assert.equal(isWafHtmlBlockError(403, null), false);
  assert.equal(isWafHtmlBlockError(403, undefined), false);
});

test("non-403 statuses are never WAF blocks", () => {
  assert.equal(isWafHtmlBlockError(429, CLOUDFLARE_1010_PAGE), false);
  assert.equal(isWafHtmlBlockError(500, CLOUDFLARE_1010_PAGE), false);
  assert.equal(isWafHtmlBlockError(401, CLOUDFLARE_1010_PAGE), false);
});
