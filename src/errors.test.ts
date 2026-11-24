import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { REQUIRED_SCOPE, problemDetail, readUpstreamBody, toToolError } from "./errors.js";
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
      assert.match(text, /https:\/\/enterprise\.jobo\.world\/credits/, "must tell the model where to top up");
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

  it("404 from a job tool explains where job ids come from", () => {
    for (const tool of ["fetch", "get_job_details"]) {
      const text = toToolError(new UpstreamError(404, JSON.stringify({ error: "Job not found" })), tool).content[0]!.text;
      assert.ok(text.startsWith("No job exists with that id. Job ids come from `search` or `search_jobs`"), text);
    }
  });

  it("429 uses retry-after when the upstream sent it", () => {
    assert.equal(textOf(new UpstreamError(429, "Too Many Requests", 15)), "Rate limited — retry in 15s.");
    assert.equal(
      textOf(new UpstreamError(429, "Too Many Requests")),
      "Rate limited by the Jobo API. Wait a moment before retrying.",
    );
  });

  it("400 keeps a plain-text upstream message and appends the filters hint", () => {
    const text = textOf(new UpstreamError(400, "Unknown work_model 'anywhere'."));
    assert.ok(text.startsWith("The Jobo API rejected the request: Unknown work_model 'anywhere'."), text);
    assert.ok(text.includes("call `list_filters`"));
  });

  it("a non-JSON, non-text body never reaches the model", () => {
    assert.equal(
      textOf(new UpstreamError(502, "<html><body>502 Bad Gateway</body></html>")),
      "The Jobo API is temporarily unavailable (HTTP 502). Try again shortly. Nothing was billed.",
    );
  });

  it("a non-UpstreamError is reported as a connectivity failure", () => {
    assert.equal(textOf(new Error("fetch failed")), "Could not reach the Jobo API: fetch failed");
  });
});

// The API answers errors with RFC 9457 problem documents. These are its real
// shapes (McpController, JobsController), and none of their JSON may reach the model.
describe("toToolError — problem documents from the API", () => {
  const noJson = (text: string) => {
    assert.ok(!text.includes("{") && !text.includes('"'), `raw JSON reached the model: ${text}`);
  };

  it("400 validation problem: each field's message, as a sentence", () => {
    const body = JSON.stringify({
      type: "https://tools.ietf.org/html/rfc9110#section-15.5.1",
      title: "One or more validation errors occurred.",
      status: 400,
      errors: { page_size: ["page_size must be between 1 and 50."] },
    });
    const text = textOf(new UpstreamError(400, body));
    assert.ok(text.startsWith("The Jobo API rejected the request: page_size: page_size must be between 1 and 50."), text);
    assert.ok(text.includes("call `list_filters`"));
    noJson(text);
  });

  it("400 problem with a detail: the detail", () => {
    const body = JSON.stringify({
      title: "Occupation filters are not available in this environment",
      status: 400,
      detail: "job_categories, job_subcategories and occupation_ids can't be used in this environment.",
    });
    const text = textOf(new UpstreamError(400, body));
    assert.ok(
      text.startsWith(
        "The Jobo API rejected the request: job_categories, job_subcategories and occupation_ids can't be used in this environment.",
      ),
      text,
    );
    noJson(text);
  });

  it("503 unavailable: the detail and the delay the API asked for", () => {
    const body = JSON.stringify({
      title: "Search temporarily unavailable",
      status: 503,
      detail: "The job search backend is unavailable. Retry the request after a short delay.",
      instance: "/api/mcp/jobs/search",
    });
    const text = textOf(new UpstreamError(503, body, 5));
    assert.equal(
      text,
      "The Jobo API is temporarily unavailable (HTTP 503): The job search backend is unavailable. Retry the request " +
        "after a short delay. Try again in 5 seconds. Nothing was billed.",
    );
  });

  it("503 search timeout: narrow the search, not try again", () => {
    const body = JSON.stringify({
      title: "Search took too long",
      status: 503,
      detail:
        "The search did not finish within its time limit. Retrying the same request will not help: send fewer " +
        "entries in queries per request, or fewer filters, and try again.",
    });
    const text = textOf(new UpstreamError(503, body));
    assert.ok(text.includes("Narrow it"), text);
    assert.ok(text.includes("will not help"), text);
    assert.ok(!/try again in/i.test(text), text);
    noJson(text);
  });

  it("404 from find_filter_values: the facet is not published, not a missing job", () => {
    const body = JSON.stringify({
      title: "Facet not available in this environment",
      status: 404,
      detail: "The occupations facet is not published yet.",
      instance: "/api/mcp/filter-options/occupations",
    });
    const text = toToolError(new UpstreamError(404, body), "find_filter_values").content[0]!.text;
    assert.ok(text.startsWith("The occupations facet is not published yet."), text);
    assert.ok(!text.includes("No job exists"), text);

    // The occupation name search answers a bare 404 until occupations are published.
    const bare = toToolError(new UpstreamError(404, ""), "find_filter_values").content[0]!.text;
    assert.ok(bare.startsWith("Those filter values are not available in this environment."), bare);
  });

  it("404 for a sandbox key in local mode says so", () => {
    const body = JSON.stringify({ code: "not_available_in_sandbox", detail: "Not available with a sandbox key." });
    const text = toToolError(new UpstreamError(404, body), "find_companies").content[0]!.text;
    assert.ok(text.includes("sandbox key (jbe_test_…)"), text);
  });
});

describe("readUpstreamBody", () => {
  it("reads detail, then error, then title, and the field errors", () => {
    assert.equal(readUpstreamBody(JSON.stringify({ title: "T", detail: "D" })).detail, "D");
    assert.equal(readUpstreamBody(JSON.stringify({ title: "T", error: "E" })).detail, "E");
    assert.equal(readUpstreamBody(JSON.stringify({ title: "T" })).detail, "T");
    assert.deepEqual(readUpstreamBody(JSON.stringify({ errors: { q: ["too long", "bad"] } })).fieldErrors, [
      "q: too long",
      "q: bad",
    ]);
  });

  it("takes nothing from JSON it does not understand, or from HTML", () => {
    for (const body of ["", "[1,2]", "42", "{}", "<html>oops</html>", "{not json"]) {
      assert.equal(readUpstreamBody(body).detail, null, body);
    }
  });
});
