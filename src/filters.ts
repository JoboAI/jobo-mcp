/**
 * The `search_jobs` filter surface and its mapping onto the upstream
 * `POST /api/mcp/jobs/search` body.
 *
 * Enum values come from @jobo-ai/connector-core (the shared filter contract,
 * pinned exactly), so the tool schema prose can never drift from the values the
 * upstream accepts. The filter keys are connector-core's `JOB_SEARCH_FILTERS`
 * keys; `filters.test.ts` fails when that contract grows a filter this tool
 * does not expose.
 */

import {
  COMPANY_CATEGORIES,
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  LANGUAGES,
  SEARCH_SORTS,
  WORK_MODELS,
} from "@jobo-ai/connector-core";
import { z } from "zod";

export {
  COMPANY_CATEGORIES,
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  LANGUAGES,
  SEARCH_SORTS,
  WORK_MODELS,
};

/**
 * Contract filters `search_jobs` deliberately leaves out, with the reason.
 * `description_format`: MCP search results carry no description (the
 * extracted fields replace it), so there is nothing to format.
 */
export const UNSUPPORTED_CONTRACT_FILTERS: Readonly<Record<string, string>> = {
  description_format: "MCP search results carry no description; get_job_details returns it as stored.",
};

/** Facets `find_filter_values` can list — the upstream filter-options facets. */
export const FILTER_VALUE_FACETS = [
  "sources",
  "industries",
  "skills",
  "company_categories",
  "job_categories",
  "job_subcategories",
  "occupations",
] as const;

export type FilterValueFacet = (typeof FILTER_VALUE_FACETS)[number];

/** Which `search_jobs` parameter a facet's values feed. */
export const FACET_FILTER_PARAM: Readonly<Record<FilterValueFacet, string>> = {
  sources: "sources",
  industries: "industries",
  skills: "skills",
  company_categories: "company_categories",
  job_categories: "job_categories",
  job_subcategories: "job_subcategories",
  occupations: "occupation_ids",
};

/**
 * A list-valued filter: an array, or (for backwards compatibility with the
 * 1.1 tool, which took comma-separated strings) a comma-separated string.
 */
const list = (description: string) =>
  z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe(`${description} Pass an array; a comma-separated string is also accepted.`);

/**
 * Company lists are not split on commas: company names contain them
 * ("FedEx, Inc."). A plain string is one company.
 */
const companyList = (description: string) =>
  z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe(`${description} Pass an array (a single string is one company).`);

const languageList = LANGUAGES.map((language) => `${language.code} (${language.name})`).join(", ");

export const SEARCH_JOBS_INPUT = z.object({
  q: z
    .string()
    .optional()
    .describe(
      'Free-text query. Matches titles and, unless search_description is false, summaries and skills. Wrap a phrase in double quotes for an exact title match; prefix a term with "-" to exclude it.',
    ),
  search_description: z
    .boolean()
    .optional()
    .describe("Match q against descriptions (summary, skills) as well as titles. Default true; false = title-only."),
  location: z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe("Free-form location, e.g. 'Berlin, Germany' or 'United States'. Pass an array for several places."),
  sources: list("ATS source ids, e.g. greenhouse, lever_co, ashby. `find_filter_values` with facet sources lists them."),
  source: list("Deprecated alias of `sources`."),
  companies: companyList(
    "Only jobs at these companies. Each value is a Jobo company id (GUID), a website domain ('stripe.com') or a whole company name ('Stripe'). Prefer ids: call `find_companies` and pass every id it returns for the company — names also match every other company with that name, and are not partial matches.",
  ),
  exclude_companies: companyList("Leave out jobs at these companies (ids, domains or whole names, as for companies)."),
  work_model: list(`Work model. One or more of: ${WORK_MODELS.join(", ")}.`),
  employment_type: list(`Employment type. One or more of: ${EMPLOYMENT_TYPES.join(", ")}.`),
  experience_level: list(`Experience level. One or more of: ${EXPERIENCE_LEVELS.join(", ")}.`),
  language: list(
    `Description language as ISO 639-1 codes. Common values: ${languageList}. Any ISO 639-1 code works; names ('German') and locales ('en-US') are mapped server-side.`,
  ),
  skills: list("Require any of these skills, e.g. Python, Kubernetes. `find_filter_values` with facet skills finds the indexed spelling."),
  exclude_skills: list("Leave out jobs asking for any of these skills."),
  industries: list("Hiring company industries. `find_filter_values` with facet industries lists them."),
  exclude_industries: list("Leave out companies in any of these industries."),
  company_categories: list(`Hiring company's business model. One or more of: ${COMPANY_CATEGORIES.join(", ")}.`),
  exclude_company_categories: list(
    `Leave out companies with any of these business models (e.g. agency). Values: ${COMPANY_CATEGORIES.join(", ")}.`,
  ),
  job_categories: list(
    "Occupation category names, e.g. 'Healthcare', 'Software Development'. Case-insensitive. `find_filter_values` with facet job_categories lists them.",
  ),
  exclude_job_categories: list("Leave out jobs in these occupation categories."),
  job_subcategories: list(
    "Occupation subcategory names, e.g. 'Nursing'. Case-insensitive. `find_filter_values` with facet job_subcategories lists them with their category.",
  ),
  exclude_job_subcategories: list("Leave out jobs in these occupation subcategories."),
  occupation_ids: list(
    "Occupation ids, e.g. 'esco:8d3e8aaa-791b-4c75-a465-f3f827028f50' or 'jobo:backend-developer' — ids, not names. `find_filter_values` with facet occupations finds the id for a role name.",
  ),
  exclude_occupation_ids: list("Leave out jobs with these occupation ids."),
  min_salary_usd: z.number().int().optional().describe("Only jobs with a published range at or above this (USD, annual)."),
  max_salary_usd: z.number().int().optional().describe("Only jobs with a published range at or below this (USD, annual)."),
  posted_after: z.string().optional().describe("ISO-8601 timestamp; only jobs the employer posted on or after it."),
  posted_before: z.string().optional().describe("ISO-8601 timestamp; only jobs the employer posted on or before it."),
  discovered_after: z
    .string()
    .optional()
    .describe("ISO-8601 timestamp; only jobs Jobo first indexed on or after it. Use it for 'new since …' questions."),
  discovered_before: z.string().optional().describe("ISO-8601 timestamp; only jobs Jobo first indexed on or before it."),
  sort: z
    .enum(SEARCH_SORTS)
    .optional()
    .describe(
      "relevance (default), discovered_desc (newest first) or discovered_asc (oldest first). The discovered orders keep pages stable.",
    ),
  include_facets: z.boolean().optional().describe("Return counts per filter value alongside the results."),
  page: z.number().int().min(1).optional().describe("1-based page number. Defaults to 1."),
  page_size: z.number().int().min(1).max(50).optional().describe("Results per page, max 50. Defaults to 20."),
});

export type SearchJobsArgs = z.infer<typeof SEARCH_JOBS_INPUT>;

/** Parameters of `search_jobs` that are MCP paging/presentation, not contract filters. */
export const MCP_ONLY_PARAMS = ["include_facets", "page", "page_size", "source"] as const;

/** Normalise an array-or-CSV value into a clean list; undefined when empty. */
export function toList(value: string[] | string | undefined, splitCommas = true): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : splitCommas ? value.split(",") : [value];
  const cleaned = [...new Set(raw.map((v) => v.trim()).filter((v) => v.length > 0))];
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Map `search_jobs` arguments onto the upstream `McpJobSearchRequest`
 * (snake_case, include/exclude flattened into `*_include` / `*_exclude`).
 * Absent filters are omitted, so the body carries only what the caller set.
 */
export function toMcpSearchBody(args: SearchJobsArgs): Record<string, unknown> {
  const sources = [...(toList(args.sources) ?? []), ...(toList(args.source) ?? [])];
  const body: Record<string, unknown> = {
    query: args.q?.trim() || undefined,
    search_description: args.search_description,
    locations: toList(args.location, false),
    sources: sources.length > 0 ? [...new Set(sources)] : undefined,
    companies_include: toList(args.companies, false),
    companies_exclude: toList(args.exclude_companies, false),
    work_models: toList(args.work_model),
    employment_types: toList(args.employment_type),
    experience_levels: toList(args.experience_level),
    languages: toList(args.language),
    skills_include: toList(args.skills),
    skills_exclude: toList(args.exclude_skills),
    industries_include: toList(args.industries),
    industries_exclude: toList(args.exclude_industries),
    company_categories_include: toList(args.company_categories),
    company_categories_exclude: toList(args.exclude_company_categories),
    job_categories_include: toList(args.job_categories),
    job_categories_exclude: toList(args.exclude_job_categories),
    job_subcategories_include: toList(args.job_subcategories),
    job_subcategories_exclude: toList(args.exclude_job_subcategories),
    occupation_ids_include: toList(args.occupation_ids),
    occupation_ids_exclude: toList(args.exclude_occupation_ids),
    min_salary_usd: args.min_salary_usd,
    max_salary_usd: args.max_salary_usd,
    posted_after: args.posted_after,
    posted_before: args.posted_before,
    discovered_after: args.discovered_after,
    discovered_before: args.discovered_before,
    sort: args.sort,
    include_facets: args.include_facets,
    page: args.page,
    page_size: args.page_size ?? 20,
  };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return body;
}
