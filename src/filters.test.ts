import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { JOB_SEARCH_FILTERS } from "@jobo-ai/connector-core";

import {
  COMPANY_CATEGORIES,
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  FACET_FILTER_PARAM,
  FILTER_VALUE_FACETS,
  MCP_ONLY_PARAMS,
  SEARCH_JOBS_INPUT,
  SEARCH_SORTS,
  UNSUPPORTED_CONTRACT_FILTERS,
  WORK_MODELS,
  toList,
  toMcpSearchBody,
} from "./filters.js";

const toolParams = Object.keys(SEARCH_JOBS_INPUT.shape);

/**
 * Drift guard: `search_jobs` exposes every filter of the shared contract
 * (connector-core's JOB_SEARCH_FILTERS) unless it is explicitly exempted with
 * a reason, and nothing beyond it except MCP paging/presentation params.
 */
describe("search_jobs covers the shared filter contract", () => {
  it("exposes every connector-core search filter", () => {
    const missing = JOB_SEARCH_FILTERS.map((f) => f.key).filter(
      (key) => !toolParams.includes(key) && !(key in UNSUPPORTED_CONTRACT_FILTERS),
    );
    assert.deepEqual(missing, [], `search_jobs is missing contract filters: ${missing.join(", ")}`);
  });

  it("has no parameter outside the contract except MCP-only ones", () => {
    const contractKeys = new Set(JOB_SEARCH_FILTERS.map((f) => f.key));
    const extra = toolParams.filter(
      (key) => !contractKeys.has(key) && !(MCP_ONLY_PARAMS as readonly string[]).includes(key),
    );
    assert.deepEqual(extra, []);
  });

  it("exemptions name real contract filters", () => {
    const contractKeys = new Set(JOB_SEARCH_FILTERS.map((f) => f.key));
    for (const key of Object.keys(UNSUPPORTED_CONTRACT_FILTERS)) assert.ok(contractKeys.has(key), key);
  });

  it("every open-vocabulary filter has a lookup facet", () => {
    for (const filter of JOB_SEARCH_FILTERS) {
      if (!filter.dynamicOptions || filter.dynamicOptions === "companies") continue;
      if (filter.key.startsWith("exclude_")) continue;
      const facet = FILTER_VALUE_FACETS.find((f) => FACET_FILTER_PARAM[f] === filter.key);
      assert.ok(facet, `no find_filter_values facet feeds ${filter.key}`);
    }
  });

  // Skipped when the generated contract is absent — the public mirror of mcp/
  // and the Docker build don't carry ../contracts/.
  it("enum vocabularies match contracts/filters.json", (t) => {
    const contractPath = join(import.meta.dirname, "..", "..", "contracts", "filters.json");
    if (!existsSync(contractPath)) {
      t.skip("contracts/filters.json not present (mirror or Docker build)");
      return;
    }
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as {
      enums: Record<string, string[]>;
      search_filters: Array<{ key: string }>;
    };
    assert.deepEqual([...WORK_MODELS], contract.enums.work_models);
    assert.deepEqual([...EMPLOYMENT_TYPES], contract.enums.employment_types);
    assert.deepEqual([...EXPERIENCE_LEVELS], contract.enums.experience_levels);
    assert.deepEqual([...COMPANY_CATEGORIES], contract.enums.company_categories);
    assert.deepEqual([...SEARCH_SORTS], contract.enums.search_sorts);
    assert.deepEqual(
      contract.search_filters.map((f) => f.key),
      JOB_SEARCH_FILTERS.map((f) => f.key),
      "the installed connector-core differs from the repo contract — bump the pinned version",
    );
  });
});

describe("toMcpSearchBody", () => {
  it("maps every filter onto the flattened upstream body", () => {
    const body = toMcpSearchBody(
      SEARCH_JOBS_INPUT.parse({
        q: " nurse ",
        search_description: false,
        location: "Berlin, Germany",
        sources: ["greenhouse"],
        source: "lever_co, greenhouse",
        companies: ["FedEx, Inc.", "stripe.com"],
        exclude_companies: "Acme, Ltd.",
        work_model: "remote,hybrid",
        employment_type: ["full-time"],
        experience_level: "senior",
        language: ["en", "de"],
        skills: "Python, Kubernetes",
        exclude_skills: ["PHP"],
        industries: ["Hospitals"],
        exclude_industries: ["Staffing"],
        company_categories: ["saas"],
        exclude_company_categories: ["agency"],
        job_categories: ["Healthcare"],
        exclude_job_categories: ["Sales"],
        job_subcategories: ["Nursing"],
        exclude_job_subcategories: ["Midwifery"],
        occupation_ids: ["esco:abc"],
        exclude_occupation_ids: ["jobo:backend-developer"],
        min_salary_usd: 80000,
        max_salary_usd: 200000,
        posted_after: "2026-11-01T00:00:00Z",
        posted_before: "2026-11-09T00:00:00Z",
        discovered_after: "2026-11-02T00:00:00Z",
        discovered_before: "2026-11-08T00:00:00Z",
        sort: "discovered_desc",
        include_facets: true,
        page: 2,
        page_size: 30,
      }),
    );

    assert.deepEqual(body, {
      query: "nurse",
      search_description: false,
      // Locations are never split: "Berlin, Germany" is one place.
      locations: ["Berlin, Germany"],
      sources: ["greenhouse", "lever_co"],
      // Company names keep their commas.
      companies_include: ["FedEx, Inc.", "stripe.com"],
      companies_exclude: ["Acme, Ltd."],
      work_models: ["remote", "hybrid"],
      employment_types: ["full-time"],
      experience_levels: ["senior"],
      languages: ["en", "de"],
      skills_include: ["Python", "Kubernetes"],
      skills_exclude: ["PHP"],
      industries_include: ["Hospitals"],
      industries_exclude: ["Staffing"],
      company_categories_include: ["saas"],
      company_categories_exclude: ["agency"],
      job_categories_include: ["Healthcare"],
      job_categories_exclude: ["Sales"],
      job_subcategories_include: ["Nursing"],
      job_subcategories_exclude: ["Midwifery"],
      occupation_ids_include: ["esco:abc"],
      occupation_ids_exclude: ["jobo:backend-developer"],
      min_salary_usd: 80000,
      max_salary_usd: 200000,
      posted_after: "2026-11-01T00:00:00Z",
      posted_before: "2026-11-09T00:00:00Z",
      discovered_after: "2026-11-02T00:00:00Z",
      discovered_before: "2026-11-08T00:00:00Z",
      sort: "discovered_desc",
      include_facets: true,
      page: 2,
      page_size: 30,
    });
  });

  it("sends only the filters that were set, with the MCP default page size", () => {
    assert.deepEqual(toMcpSearchBody(SEARCH_JOBS_INPUT.parse({ q: "rust", skills: " , " })), {
      query: "rust",
      page_size: 20,
    });
  });

  it("rejects values outside a closed vocabulary", () => {
    assert.throws(() => SEARCH_JOBS_INPUT.parse({ sort: "newest" }));
  });

  it("toList trims, dedupes and drops empties", () => {
    assert.deepEqual(toList(" a, b ,a,,"), ["a", "b"]);
    assert.deepEqual(toList("FedEx, Inc.", false), ["FedEx, Inc."]);
    assert.equal(toList([]), undefined);
    assert.equal(toList(undefined), undefined);
  });
});
