import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UpstreamError, isJobId, jobPath, parseRetryAfter } from "./upstream.js";

describe("jobPath", () => {
  it("builds the job route for a UUID, in either case", () => {
    assert.equal(jobPath("0b9a1f7e-0000-4000-8000-000000000001"), "/api/mcp/jobs/0b9a1f7e-0000-4000-8000-000000000001");
    assert.equal(isJobId("0B9A1F7E-0000-4000-8000-00000000000A"), true);
  });

  it("refuses anything else with a 404, so no other route can be reached through a job id", () => {
    // "search" is the billed GET /api/mcp/jobs/search; the rest are words, fragments and paths.
    for (const id of ["search", "expired", "", " 0b9a1f7e-0000-4000-8000-000000000001", "0b9a1f7e", "../filters"]) {
      assert.throws(
        () => jobPath(id),
        (err: unknown) => err instanceof UpstreamError && err.status === 404,
        JSON.stringify(id),
      );
    }
  });
});

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
