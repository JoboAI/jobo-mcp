import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatCompensation,
  formatLocation,
  jobTitle,
  renderJobDocument,
  renderSearchResults,
  toFetchPayload,
  toSearchPayload,
} from "./format.js";
import type { UpstreamJobDetails, UpstreamJobSummary, UpstreamSearchResponse } from "./upstream.js";

function summary(overrides: Partial<UpstreamJobSummary> = {}): UpstreamJobSummary {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    title: "Senior Rust Engineer",
    normalized_title: "software_engineer",
    summary: "Build low-latency services.",
    listing_url: "https://example.com/jobs/1",
    apply_url: "https://example.com/apply/1",
    source: "greenhouse",
    date_posted: "2026-07-01T00:00:00Z",
    workplace_type: "Remote",
    employment_type: "Full-time",
    experience_level: "Senior",
    compensation: { min: 120000, max: 160000, currency: "USD", period: "yearly" },
    location: { city: "Berlin", region: "Berlin", country: "Germany", is_remote: true },
    company: {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      name: "Acme Corp",
      logo_url: null,
      industries: ["Software"],
      categories: ["b2b"],
      summary: "Acme builds things.",
    },
    top_skills: ["Rust", "Kubernetes"],
    flags: { is_h1b_sponsor: true, is_work_auth_required: null, is_clearance_required: null },
    ...overrides,
  };
}

function details(overrides: Partial<UpstreamJobDetails> = {}): UpstreamJobDetails {
  return {
    summary: summary(),
    qualifications: {
      must_have: {
        education: ["BSc Computer Science"],
        certifications: [],
        skills: [{ name: "Rust", type: "hard" }],
      },
      preferred: null,
    },
    responsibilities: ["Design services", "Mentor engineers"],
    benefits: ["Health insurance"],
    all_locations: [
      { location: null, city: "Berlin", region: "Berlin", country: "Germany" },
      { location: null, city: "Munich", region: "Bavaria", country: "Germany" },
    ],
    valid_through: "2026-09-01T00:00:00Z",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-20T00:00:00Z",
    description: "<p>Raw employer HTML</p>",
    ...overrides,
  };
}

function searchResponse(jobs: UpstreamJobSummary[], overrides: Partial<UpstreamSearchResponse> = {}): UpstreamSearchResponse {
  return {
    jobs,
    total: jobs.length,
    page: 1,
    page_size: 20,
    total_pages: 1,
    has_more: false,
    next_page: null,
    ...overrides,
  };
}

describe("formatLocation", () => {
  it("marks a remote job with its place", () => {
    assert.equal(formatLocation(summary()), "Remote (Berlin, Berlin, Germany)");
  });

  it("renders a non-remote job as a plain place", () => {
    const job = summary({ location: { city: "Berlin", region: null, country: "Germany", is_remote: false } });
    assert.equal(formatLocation(job), "Berlin, Germany");
  });

  it("falls back to the workplace type when there is no location", () => {
    assert.equal(formatLocation(summary({ location: null, workplace_type: "Remote" })), "Remote");
  });

  it("says so plainly when nothing is known", () => {
    assert.equal(formatLocation(summary({ location: null, workplace_type: null })), "Location not stated");
  });

  it("handles a remote job with no place at all", () => {
    const job = summary({ location: { city: null, region: null, country: null, is_remote: true } });
    assert.equal(formatLocation(job), "Remote");
  });
});

describe("formatCompensation", () => {
  it("renders a full range", () => {
    assert.equal(formatCompensation(summary()), "USD 120,000–160,000 per year");
  });

  it("renders a floor only", () => {
    const job = summary({ compensation: { min: 90000, max: null, currency: "EUR", period: "yearly" } });
    assert.equal(formatCompensation(job), "from EUR 90,000 per year");
  });

  it("renders a ceiling only", () => {
    const job = summary({ compensation: { min: null, max: 50, currency: "USD", period: "hourly" } });
    assert.equal(formatCompensation(job), "up to USD 50 per hour");
  });

  it("returns empty when the employer published nothing", () => {
    assert.equal(formatCompensation(summary({ compensation: null })), "");
    const empty = summary({ compensation: { min: null, max: null, currency: "USD", period: "yearly" } });
    assert.equal(formatCompensation(empty), "");
  });
});

describe("search payload — the Deep Research contract", () => {
  it("returns exactly id, title and url per result", () => {
    const payload = toSearchPayload(searchResponse([summary()]));
    assert.equal(payload.results.length, 1);
    assert.deepEqual(Object.keys(payload.results[0]!).sort(), ["id", "title", "url"]);
  });

  it("uses the job id as the id, so it round-trips to fetch", () => {
    const payload = toSearchPayload(searchResponse([summary()]));
    assert.equal(payload.results[0]!.id, "11111111-2222-3333-4444-555555555555");
  });

  it("carries company and location in the title, since that is all the source list shows", () => {
    assert.equal(jobTitle(summary()), "Senior Rust Engineer — Acme Corp (Remote (Berlin, Berlin, Germany))");
  });

  it("falls back to the apply URL when there is no listing URL", () => {
    const payload = toSearchPayload(searchResponse([summary({ listing_url: "" })]));
    assert.equal(payload.results[0]!.url, "https://example.com/apply/1");
  });

  it("returns an empty result set rather than throwing", () => {
    assert.deepEqual(toSearchPayload(searchResponse([])), { results: [] });
  });
});

describe("fetch payload — the Deep Research contract", () => {
  it("returns exactly the five required keys", () => {
    const payload = toFetchPayload(details());
    assert.deepEqual(Object.keys(payload).sort(), ["id", "metadata", "text", "title", "url"]);
  });

  it("gives metadata values as strings, never nested objects", () => {
    const payload = toFetchPayload(details());
    for (const [key, value] of Object.entries(payload.metadata)) {
      assert.equal(typeof value, "string", `metadata.${key} must be a string`);
    }
  });

  it("omits metadata keys the job has no value for", () => {
    const payload = toFetchPayload(
      details({ summary: summary({ compensation: null, employment_type: null }) }),
    );
    assert.equal("compensation" in payload.metadata, false);
    assert.equal("employment_type" in payload.metadata, false);
  });

  it("produces self-contained text, since Deep Research never opens the URL", () => {
    const text = toFetchPayload(details()).text;
    for (const expected of [
      "Senior Rust Engineer",
      "Acme Corp",
      "Design services",
      "BSc Computer Science",
      "Health insurance",
      "USD 120,000–160,000",
    ]) {
      assert.ok(text.includes(expected), `expected the document to contain ${JSON.stringify(expected)}`);
    }
  });
});

describe("renderJobDocument", () => {
  it("surfaces H-1B sponsorship, which is a common filter", () => {
    assert.ok(renderJobDocument(details()).includes("H-1B"));
  });

  it("omits the eligibility section when no flag is set", () => {
    const d = details({
      summary: summary({
        flags: { is_h1b_sponsor: null, is_work_auth_required: null, is_clearance_required: null },
      }),
    });
    assert.equal(renderJobDocument(d).includes("## Eligibility"), false);
  });

  it("lists every location when a job has more than one", () => {
    const text = renderJobDocument(details());
    assert.ok(text.includes("## All locations"));
    assert.ok(text.includes("Munich"));
  });

  it("omits the locations section for a single-location job", () => {
    const d = details({ all_locations: [{ location: null, city: "Berlin", region: null, country: "Germany" }] });
    assert.equal(renderJobDocument(d).includes("## All locations"), false);
  });

  it("leaves the raw HTML description out by default", () => {
    assert.equal(renderJobDocument(details()).includes("Raw employer HTML"), false);
  });

  it("does not emit empty sections when the extracted fields are bare", () => {
    const d = details({ responsibilities: [], benefits: [], qualifications: { must_have: null, preferred: null } });
    const text = renderJobDocument(d);
    for (const heading of ["## Responsibilities", "## Benefits", "## Required qualifications"]) {
      assert.equal(text.includes(heading), false, `did not expect ${heading}`);
    }
  });
});

describe("renderSearchResults", () => {
  it("states the total and the page position", () => {
    const text = renderSearchResults(searchResponse([summary()], { total: 812, total_pages: 41 }));
    assert.ok(text.includes("812 matching jobs"));
    assert.ok(text.includes("page 1 of 41"));
  });

  it("includes each job id so the model can fetch it", () => {
    assert.ok(renderSearchResults(searchResponse([summary()])).includes("id: 11111111-2222-3333-4444-555555555555"));
  });

  it("points at the next page when there is one", () => {
    const text = renderSearchResults(searchResponse([summary()], { has_more: true, next_page: 2 }));
    assert.ok(text.includes("page 2"));
  });

  it("gives an actionable message for no matches", () => {
    const text = renderSearchResults(searchResponse([]));
    assert.ok(text.includes("No jobs matched"));
    assert.ok(text.includes("list_filters"));
  });
});
