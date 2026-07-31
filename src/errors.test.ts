import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { REQUIRED_SCOPE, problemDetail, toToolError } from "./errors.js";
import { UpstreamError } from "./upstream.js";

/** The single text the model actually sees. */
function textOf(err: unknown): string {
  const result = toToolError(err);
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
  return result.content[0]!.text;
}

describe("problemDetail", () => {
  it("extracts a non-empty string detail from a problem document", () => {
    const body = JSON.stringify({ title: "Insufficient credits", status: 402, detail: "Top up to continue." });
    assert.equal(problemDetail(body), "Top up to continue.");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(problemDetail(JSON.stringify({ detail: "  spaced  " })), "spaced");
  });

  it("returns null for a body that is not JSON, not an object, or has no usable detail", () => {
    assert.equal(problemDetail(""), null);
    assert.equal(problemDetail("<html>502 Bad Gateway</html>"), null);
    assert.equal(problemDetail("null"), null);
    assert.equal(problemDetail('"just a string"'), null);
    assert.equal(problemDetail(JSON.stringify({ title: "no detail here" })), null);
    assert.equal(problemDetail(JSON.stringify({ detail: "   " })), null);
    assert.equal(problemDetail(JSON.stringify({ detail: 42 })), null);
  });
});

describe("toToolError — 402 payment required", () => {
  // The reason this branch exists: without it the raw problem+json body was
  // handed to the model verbatim.
  const body = JSON.stringify({
    type: "https://tools.ietf.org/html/rfc9110#section-15.5.3",
    title: "Insufficient credits",
    status: 402,
    detail:
      "Your Jobo wallet does not have enough credits for this job search: it needs 30 credits " +
      "(about $0.03) and the balance is 5. Top up at https://enterprise.jobo.world/credits and run the search again.",
    credits_required: 30,
    credits_balance: 5,
  });

  it("surfaces the API's detail sentence and never the raw body", () => {
    const text = textOf(new UpstreamError(402, body));
    assert.equal(
      text,
      "Your Jobo wallet does not have enough credits for this job search: it needs 30 credits " +
        "(about $0.03) and the balance is 5. Top up at https://enterprise.jobo.world/credits and run the search again.",
    );
    assert.ok(!text.includes("{"), "tool text must not contain raw JSON");
    assert.ok(!text.includes("credits_required"), "tool text must not leak wire field names");
  });

  it("falls back to an actionable sentence when the body is not a problem document", () => {
    for (const wireBody of ["", "Payment Required", "<html>402</html>", "{}"]) {
      const text = textOf(new UpstreamError(402, wireBody));
      assert.ok(text.includes("out of credits"), `expected a credits explanation, got: ${text}`);
      assert.ok(text.includes("https://enterprise.jobo.world/credits"), "must tell the model where to top up");
      assert.ok(!text.includes("<html>"), "must not echo the raw body");
    }
  });
});

describe("toToolError — statuses unchanged by the 402 work", () => {
  it("401 asks the client to re-authenticate", () => {
    const text = textOf(new UpstreamError(401, "Unauthorized"));
    assert.equal(
      text,
      "Authentication failed: the Jobo API rejected the access token (it may have expired). Re-authenticate and retry.",
    );
  });

  it("403 names the missing scope", () => {
    assert.equal(
      textOf(new UpstreamError(403, "Forbidden")),
      `Authorization failed: the token is missing the required '${REQUIRED_SCOPE}' scope.`,
    );
  });

  it("404 explains where job ids come from", () => {
    assert.equal(
      textOf(new UpstreamError(404, "Not Found")),
      "No job exists with that id. Job ids come from `search` or `search_jobs`; listings are removed once they close.",
    );
  });

  it("429 uses retry-after when the upstream sent it", () => {
    assert.equal(textOf(new UpstreamError(429, "Too Many Requests", 15)), "Rate limited — retry in 15s.");
    assert.equal(
      textOf(new UpstreamError(429, "Too Many Requests")),
      "Rate limited by the Jobo API. Wait a moment before retrying.",
    );
  });

  it("400 keeps the upstream message and appends the filters hint", () => {
    const text = textOf(new UpstreamError(400, "Unknown work_model 'anywhere'."));
    assert.ok(text.startsWith("Unknown work_model 'anywhere'."));
    assert.ok(text.includes("call `list_filters`"));
  });

  it("an unmapped status falls back to the upstream message", () => {
    assert.equal(textOf(new UpstreamError(503, "Search temporarily unavailable")), "Search temporarily unavailable");
    assert.equal(textOf(new UpstreamError(503, "")), "Jobo API error 503.");
  });

  it("a non-UpstreamError is reported as a connectivity failure", () => {
    assert.equal(textOf(new Error("fetch failed")), "Could not reach the Jobo API: fetch failed");
  });
});
