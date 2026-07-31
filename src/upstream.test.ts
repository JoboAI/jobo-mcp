import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UpstreamError, parseRetryAfter } from "./upstream.js";

describe("parseRetryAfter", () => {
  it("parses the delta-seconds form", () => {
    assert.equal(parseRetryAfter("30"), 30);
    assert.equal(parseRetryAfter("0"), 0);
  });

  it("parses the HTTP-date form as seconds from now", () => {
    const value = parseRetryAfter(new Date(Date.now() + 42_000).toUTCString());
    assert.ok(value !== undefined && value >= 40 && value <= 43, `expected ~42, got ${value}`);
  });

  it("clamps a date in the past to zero rather than going negative", () => {
    assert.equal(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0);
  });

  it("returns undefined for a missing or unparseable header", () => {
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter(""), undefined);
    assert.equal(parseRetryAfter("soon"), undefined);
  });
});

describe("UpstreamError", () => {
  it("carries the retry-after seconds when the upstream sent them", () => {
    const err = new UpstreamError(429, "Too Many Requests", 15);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterSeconds, 15);
  });

  it("leaves retry-after undefined when the upstream said nothing", () => {
    assert.equal(new UpstreamError(429, "Too Many Requests").retryAfterSeconds, undefined);
  });
});
