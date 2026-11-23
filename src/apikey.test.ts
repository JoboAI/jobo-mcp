import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import type {
  UpstreamFiltersResponse,
  UpstreamJobDetails,
  UpstreamOccupationSearchResponse,
  UpstreamSearchResponse,
} from "./upstream.js";

// Local mode answers the MCP-surface calls from the public REST API. A local
// HTTP server stands in for that API here: it records what it was asked and
// answers with the public shapes. `JOBO_API_URL` is read when `upstream.ts`
// loads, so it is set before the import below (each test file is its own process).

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
}

const KEY = "jbe_live_local_mode_test_key";

const job = (overrides: Record<string, unknown> = {}) => ({
  id: "0b9a1f7e-0000-4000-8000-000000000001",
  title: "Senior Backend Engineer",
  normalized_title: "Backend Engineer",
  occupation: { id: "jobo:backend-developer", name: "Backend Developer", category: "Software Development", subcategory: "Backend" },
  company: {
    id: "c4b71ba7-2855-48ef-a893-4cb7e5194c14",
    name: "Stripe",
    website: "https://stripe.com",
    logo_url: "https://cdn.example/stripe.png",
    summary: "Payments infrastructure.",
    industries: ["Fintech"],
    categories: ["enterprise"],
  },
  description: "Build the ledger.",
  summary: "Own the ledger services.",
  listing_url: "https://stripe.com/jobs/1",
  apply_url: "https://stripe.com/jobs/1/apply",
  locations: [
    { location: "Dublin, Ireland", city: "Dublin", region: "Leinster", country: "Ireland", latitude: 53.3, longitude: -6.2 },
    { location: "Remote", city: null, region: null, country: "Ireland", latitude: null, longitude: null },
  ],
  compensation: { min: 120000, max: 160000, currency: "EUR", period: "yearly" },
  employment_type: "Full-time",
  workplace_type: "Remote",
  experience_level: "Senior",
  source: "greenhouse",
  created_at: "2026-11-20T10:00:00Z",
  updated_at: "2026-11-21T10:00:00Z",
  date_posted: "2026-11-19T00:00:00Z",
  valid_through: null,
  qualifications: {
    must_have: {
      education: [],
      certifications: [],
      skills: [
        { name: "Go", type: "hard" },
        { name: "Communication", type: "soft" },
        { name: "PostgreSQL", type: "Hard" },
        { name: " ", type: "hard" },
        ...Array.from({ length: 9 }, (_, i) => ({ name: `Skill ${i}`, type: "hard" })),
      ],
    },
    preferred: null,
  },
  responsibilities: ["Design services"],
  benefits: ["Equity"],
  is_work_auth_required: true,
  is_h1b_sponsor: null,
  is_clearance_required: false,
  ...overrides,
});

describe("local mode: the MCP surface answered from the public API", () => {
  let api: Server;
  let seen: Seen[] = [];
  let respond: (request: Seen) => { status?: number; body: unknown } = () => ({ body: {} });
  let callApi: typeof import("./upstream.js").callApi;
  let clearOccupationCache: typeof import("./apikey.js").clearOccupationCache;
  let UpstreamError: typeof import("./upstream.js").UpstreamError;

  const call = <T>(method: string, path: string, body?: unknown) =>
    callApi<T>(method, path, { kind: "apiKey", key: KEY }, body);

  before(async () => {
    api = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const request: Seen = {
          method: req.method ?? "",
          path: req.url ?? "",
          headers: req.headers,
          body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
        };
        seen.push(request);
        const { status = 200, body } = respond(request);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    process.env.JOBO_API_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    ({ callApi, UpstreamError } = await import("./upstream.js"));
    ({ clearOccupationCache } = await import("./apikey.js"));
  });

  after(() => {
    api.close();
  });

  beforeEach(() => {
    seen = [];
    clearOccupationCache();
  });

  it("sends the key the way the public API reads it, and never as a bearer token", async () => {
    respond = () => ({ body: { suggestions: [] } });

    await call("GET", "/api/mcp/companies/suggest?q=stripe&limit=5");

    assert.equal(seen[0].headers["x-api-key"], KEY);
    assert.equal(seen[0].headers["x-jobo-client"], "mcp");
    assert.equal(seen[0].headers.authorization, undefined);
  });

  it("turns the flat search body into the public one: nested filters, a salary range, no facets unless asked", async () => {
    respond = () => ({ body: { jobs: [], total: 0, page: 1, page_size: 20, total_pages: 0, facets: {} } });

    await call("POST", "/api/mcp/jobs/search", {
      query: "  backend  ",
      locations: ["Berlin, Germany"],
      companies_include: ["c4b71ba7-2855-48ef-a893-4cb7e5194c14"],
      skills_include: ["Go"],
      skills_exclude: ["PHP"],
      industries_exclude: ["Gambling"],
      work_models: ["remote"],
      min_salary_usd: 100000,
      sort: "discovered_desc",
      page: 2,
      page_size: 20,
    });

    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].path, "/api/jobs/search");
    assert.deepEqual(seen[0].body, {
      queries: ["backend"],
      locations: ["Berlin, Germany"],
      companies: { include: ["c4b71ba7-2855-48ef-a893-4cb7e5194c14"] },
      skills: { include: ["Go"], exclude: ["PHP"] },
      industries: { exclude: ["Gambling"] },
      work_models: ["remote"],
      salary_usd: { min: 100000 },
      sort: "discovered_desc",
      page: 2,
      page_size: 20,
      include_facets: [],
    });
  });

  it("asks for the surface's four facets when facets are wanted, and returns them", async () => {
    respond = () => ({
      body: { jobs: [], total: 0, page: 1, page_size: 20, total_pages: 0, facets: { sources: [{ key: "greenhouse", count: 9 }] } },
    });

    const res = await call<UpstreamSearchResponse>("POST", "/api/mcp/jobs/search", { include_facets: true, page_size: 20 });

    assert.deepEqual(seen[0].body?.include_facets, ["work_model", "experience_level", "employment_type", "sources"]);
    assert.deepEqual(res.facets, { sources: [{ key: "greenhouse", count: 9 }] });
  });

  it("projects a public job into the summary the tools render", async () => {
    respond = () => ({
      body: {
        jobs: [job()],
        total: 41,
        page: 1,
        page_size: 20,
        total_pages: 3,
        facets: { sources: [{ key: "greenhouse", count: 9 }] },
        warnings: [{ code: "companies_unmatched", message: "\"Strype\" matched no company." }],
      },
    });

    const res = await call<UpstreamSearchResponse>("POST", "/api/mcp/jobs/search", { query: "backend", page_size: 20 });

    assert.equal(res.has_more, true);
    assert.equal(res.next_page, 2);
    assert.equal(res.facets, null, "facets were not asked for");
    assert.deepEqual(res.notes, ["\"Strype\" matched no company."]);

    const summary = res.jobs[0];
    assert.equal(summary.company.name, "Stripe");
    assert.deepEqual(summary.company.industries, ["Fintech"]);
    assert.deepEqual(summary.occupation, {
      id: "jobo:backend-developer",
      name: "Backend Developer",
      category: "Software Development",
      subcategory: "Backend",
    });
    assert.deepEqual(summary.location, { city: "Dublin", region: "Leinster", country: "Ireland", is_remote: true });
    assert.deepEqual(summary.top_skills.slice(0, 2), ["Go", "PostgreSQL"], "hard skills only, whatever the casing");
    assert.equal(summary.top_skills.length, 8, "capped at eight");
    assert.ok(!summary.top_skills.includes("Communication"));
    assert.equal(summary.summary, "Own the ledger services.\n\nJobs brought to you by [Jobo AI](https://jobo.world).");
    assert.deepEqual(summary.flags, { is_h1b_sponsor: null, is_work_auth_required: true, is_clearance_required: false });
  });

  it("answers the canonical search with the public search", async () => {
    respond = () => ({ body: { jobs: [job()], total: 1, page: 1, page_size: 20, total_pages: 1 } });

    const res = await call<UpstreamSearchResponse>("GET", "/api/mcp/jobs/search?q=ledger&page_size=20");

    assert.equal(seen[0].path, "/api/jobs/search");
    assert.deepEqual(seen[0].body, { queries: ["ledger"], page_size: 20, include_facets: [] });
    assert.equal(res.has_more, false);
    assert.equal(res.next_page, null);
    assert.equal(res.notes, null);
  });

  it("reads one job, and includes the description only when it was asked for", async () => {
    respond = () => ({ body: job() });

    const without = await call<UpstreamJobDetails>("GET", "/api/mcp/jobs/0b9a1f7e-0000-4000-8000-000000000001");
    const withIt = await call<UpstreamJobDetails>(
      "GET",
      "/api/mcp/jobs/0b9a1f7e-0000-4000-8000-000000000001?include_description=true",
    );

    assert.equal(seen[0].method, "GET");
    assert.equal(seen[0].path, "/api/jobs/0b9a1f7e-0000-4000-8000-000000000001");
    assert.equal(without.description, null);
    assert.equal(withIt.description, "Build the ledger.\n\nJobs brought to you by [Jobo AI](https://jobo.world).");
    assert.deepEqual(without.all_locations[1], { location: "Remote", city: null, region: null, country: "Ireland" });
    assert.deepEqual(without.responsibilities, ["Design services"]);
    assert.equal(without.summary.title, "Senior Backend Engineer");
  });

  it("lists the filters from the free endpoint and leaves the index total unknown", async () => {
    respond = () => ({
      body: {
        enums: { work_models: ["remote", "hybrid"], employment_types: ["full-time"], experience_levels: ["senior"] },
        sources: [
          { key: "greenhouse", count: 120 },
          { key: "lever_co", count: 80 },
        ],
      },
    });

    const res = await call<UpstreamFiltersResponse>("GET", "/api/mcp/filters");

    assert.equal(seen.length, 1, "no search is run for a count: that would be billed");
    assert.equal(seen[0].path, "/api/connectors/filters");
    assert.equal(res.total_jobs, null);
    assert.deepEqual(res.enums.sources, ["greenhouse", "lever_co"]);
    assert.deepEqual(res.enums.work_models, ["remote", "hybrid"]);
    assert.deepEqual(res.facets.sources, [
      { key: "greenhouse", count: 120 },
      { key: "lever_co", count: 80 },
    ]);
  });

  it("passes the company and filter-value lookups through to their public twins", async () => {
    respond = () => ({ body: { facet: "skills", options: [{ key: "Terraform", count: 12 }] } });

    await call("GET", "/api/mcp/filter-options/skills?q=terra&limit=25");
    await call("GET", "/api/mcp/companies/suggest?q=stripe");

    assert.equal(seen[0].path, "/api/connectors/filter-options/skills?q=terra&limit=25");
    assert.equal(seen[1].path, "/api/connectors/companies/suggest?q=stripe");
  });

  it("searches occupations by name over the public taxonomy, best match first, and loads it once", async () => {
    respond = () => ({
      body: {
        version: "1",
        categories: [
          {
            name: "Healthcare",
            subcategories: [
              { name: "Nursing", occupations: [{ id: "esco:1", name: "Registered Nurse" }, { id: "esco:2", name: "Nurse Practitioner" }] },
              { name: "Therapy", occupations: [{ id: "esco:3", name: "School Nurse Assistant" }] },
            ],
          },
          {
            name: "Education",
            subcategories: [{ name: "Nursing Education", occupations: [{ id: "esco:4", name: "Clinical Instructor" }] }],
          },
        ],
      },
    });

    const res = await call<UpstreamOccupationSearchResponse>("GET", "/api/mcp/occupations?q=Nurse&limit=3");
    const second = await call<UpstreamOccupationSearchResponse>("GET", "/api/mcp/occupations?q=clinical");

    assert.equal(seen.length, 1, "the taxonomy is fetched once and reused");
    assert.equal(seen[0].path, "/api/occupations");
    // Starts-with first, then contains; a subcategory match would come last.
    assert.deepEqual(
      res.occupations.map((occupation) => occupation.name),
      ["Nurse Practitioner", "Registered Nurse", "School Nurse Assistant"],
    );
    assert.deepEqual(res.occupations[0], { id: "esco:2", name: "Nurse Practitioner", category: "Healthcare", subcategory: "Nursing" });
    assert.deepEqual(second.occupations.map((occupation) => occupation.id), ["esco:4"]);
  });

  it("ranks an occupation whose subcategory matches after the ones whose name does", async () => {
    respond = () => ({
      body: {
        version: "1",
        categories: [
          {
            name: "Education",
            subcategories: [{ name: "Nursing Education", occupations: [{ id: "esco:4", name: "Clinical Instructor" }] }],
          },
          { name: "Healthcare", subcategories: [{ name: "Wards", occupations: [{ id: "esco:1", name: "Staff nursing lead" }] }] },
        ],
      },
    });

    const res = await call<UpstreamOccupationSearchResponse>("GET", "/api/mcp/occupations?q=nursing");

    assert.deepEqual(res.occupations.map((occupation) => occupation.id), ["esco:1", "esco:4"]);
  });

  it("keeps the API's refusal, with its status, for the error text to explain", async () => {
    respond = () => ({ status: 401, body: { error: "Invalid or expired API key" } });

    await assert.rejects(
      () => call("POST", "/api/mcp/jobs/search", { query: "x", page_size: 5 }),
      (err: unknown) => err instanceof UpstreamError && err.status === 401,
    );
  });

  it("still forwards an OAuth token to the MCP surface untouched", async () => {
    respond = () => ({ body: { suggestions: [] } });

    await callApi("GET", "/api/mcp/companies/suggest?q=stripe", "token-abc");

    assert.equal(seen[0].path, "/api/mcp/companies/suggest?q=stripe");
    assert.equal(seen[0].headers.authorization, "Bearer token-abc");
    assert.equal(seen[0].headers["x-api-key"], undefined);
  });
});
