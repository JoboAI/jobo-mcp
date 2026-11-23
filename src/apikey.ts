/**
 * Local mode: the same tools, answered from the public REST API with an API key.
 *
 * The hosted server forwards a signed-in user's OAuth token to the External
 * API's `/api/mcp/*` surface. A server someone runs themselves over stdio has
 * no browser to sign in with, only a key, and that surface does not take keys.
 * It does not need to: every `/api/mcp/*` response is a projection of what the
 * public API already returns. So each MCP-surface call is translated here into
 * its public counterpart and the answer is projected back into the shape the
 * tools were written against.
 *
 * Going through the public API is deliberate. A key then meets exactly the
 * limits, billing and logging it meets everywhere else; nothing about keys gets
 * a second code path on the server.
 *
 * The projections mirror `ToRichSummary` and `ToDetails` in `McpController.cs`.
 * Keep the two in step.
 */

import {
  requestJson,
  UpstreamError,
  type UpstreamFiltersResponse,
  type UpstreamJobDetails,
  type UpstreamJobSummary,
  type UpstreamOccupation,
  type UpstreamOccupationSearchResponse,
  type UpstreamSearchResponse,
} from "./upstream.js";

/** Appended to summaries and descriptions, as the MCP surface does. */
export const JOBO_ATTRIBUTION = "Jobs brought to you by [Jobo AI](https://jobo.world).";

/** The facets the MCP surface returns when `include_facets` is set. */
const DEFAULT_FACETS = ["work_model", "experience_level", "employment_type", "sources"];

const OCCUPATION_DEFAULT_LIMIT = 25;
const OCCUPATION_MAX_LIMIT = 100;
const OCCUPATION_CACHE_MS = 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
//  The public API's shapes (snake_case on the wire), as far as this file reads them
// ─────────────────────────────────────────────────────────────────────────────

interface PublicSkill {
  name: string;
  type: string | null;
}

interface PublicQualificationGroup {
  education: string[];
  certifications: string[];
  skills: PublicSkill[];
}

interface PublicLocation {
  location: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
}

export interface PublicJob {
  id: string;
  title: string;
  normalized_title: string | null;
  occupation?: UpstreamOccupation | null;
  company: {
    id: string;
    name: string;
    logo_url: string | null;
    industries?: string[] | null;
    categories?: string[] | null;
    summary: string | null;
  } | null;
  description: string | null;
  summary: string | null;
  listing_url: string | null;
  apply_url: string | null;
  locations?: PublicLocation[] | null;
  compensation: UpstreamJobSummary["compensation"];
  employment_type: string | null;
  workplace_type: string | null;
  experience_level: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
  date_posted: string | null;
  valid_through: string | null;
  qualifications?: { must_have: PublicQualificationGroup | null; preferred: PublicQualificationGroup | null } | null;
  responsibilities?: string[] | null;
  benefits?: string[] | null;
  is_work_auth_required: boolean | null;
  is_h1b_sponsor: boolean | null;
  is_clearance_required: boolean | null;
}

interface PublicSearchResponse {
  jobs: PublicJob[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  facets?: Record<string, Array<{ key: string; count: number }>> | null;
  warnings?: Array<{ message: string }> | null;
}

interface PublicConnectorFilters {
  enums: { work_models: string[]; employment_types: string[]; experience_levels: string[] };
  sources: Array<{ key: string; count: number }>;
}

interface PublicOccupationTaxonomy {
  categories: Array<{
    name: string;
    subcategories: Array<{ name: string; occupations: Array<{ id: string; name: string }> }>;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Projections
// ─────────────────────────────────────────────────────────────────────────────

export function addAttribution(content: string | null | undefined): string {
  if (!content || content.trim().length === 0) return JOBO_ATTRIBUTION;
  if (content.toLowerCase().includes(JOBO_ATTRIBUTION.toLowerCase())) return content;
  return `${content.trimEnd()}\n\n${JOBO_ATTRIBUTION}`;
}

export function toRichSummary(job: PublicJob): UpstreamJobSummary {
  const primary = job.locations?.[0];
  const topSkills = (job.qualifications?.must_have?.skills ?? [])
    .filter((skill) => skill.type?.toLowerCase() === "hard")
    .map((skill) => skill.name)
    .filter((name) => typeof name === "string" && name.trim().length > 0)
    .slice(0, 8);

  return {
    id: job.id,
    title: job.title,
    normalized_title: job.normalized_title ?? null,
    occupation: job.occupation
      ? {
          id: job.occupation.id,
          name: job.occupation.name,
          category: job.occupation.category,
          subcategory: job.occupation.subcategory,
        }
      : null,
    summary: addAttribution(job.summary),
    listing_url: job.listing_url ?? "",
    apply_url: job.apply_url ?? "",
    source: job.source ?? "",
    date_posted: job.date_posted ?? null,
    workplace_type: job.workplace_type ?? null,
    employment_type: job.employment_type ?? null,
    experience_level: job.experience_level ?? null,
    compensation: job.compensation ?? null,
    location: primary
      ? {
          city: primary.city ?? null,
          region: primary.region ?? null,
          country: primary.country ?? null,
          is_remote: job.workplace_type?.toLowerCase() === "remote",
        }
      : null,
    company: {
      id: job.company?.id ?? "",
      name: job.company?.name ?? "",
      logo_url: job.company?.logo_url ?? null,
      industries: job.company?.industries ?? [],
      categories: job.company?.categories ?? [],
      summary: job.company?.summary ?? null,
    },
    top_skills: topSkills,
    flags: {
      is_h1b_sponsor: job.is_h1b_sponsor ?? null,
      is_work_auth_required: job.is_work_auth_required ?? null,
      is_clearance_required: job.is_clearance_required ?? null,
    },
  };
}

export function toDetails(job: PublicJob, includeDescription: boolean): UpstreamJobDetails {
  return {
    summary: toRichSummary(job),
    qualifications: {
      must_have: job.qualifications?.must_have ?? null,
      preferred: job.qualifications?.preferred ?? null,
    },
    responsibilities: job.responsibilities ?? [],
    benefits: job.benefits ?? [],
    all_locations: (job.locations ?? []).map((location) => ({
      location: location.location ?? null,
      city: location.city ?? null,
      region: location.region ?? null,
      country: location.country ?? null,
    })),
    valid_through: job.valid_through ?? null,
    created_at: job.created_at,
    updated_at: job.updated_at,
    description: includeDescription ? addAttribution(job.description) : null,
  };
}

function toSearchResponse(res: PublicSearchResponse, facetsRequested: boolean): UpstreamSearchResponse {
  const notes = (res.warnings ?? []).map((warning) => warning.message).filter((message) => !!message);
  return {
    jobs: (res.jobs ?? []).map(toRichSummary),
    total: res.total,
    page: res.page,
    page_size: res.page_size,
    total_pages: res.total_pages,
    has_more: res.page < res.total_pages,
    next_page: res.page < res.total_pages ? res.page + 1 : null,
    facets: facetsRequested ? (res.facets ?? null) : null,
    notes: notes.length > 0 ? notes : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Request translation
// ─────────────────────────────────────────────────────────────────────────────

const list = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length > 0 ? (value as string[]) : undefined;

function includeExclude(include: unknown, exclude: unknown): { include?: string[]; exclude?: string[] } | undefined {
  const filter: { include?: string[]; exclude?: string[] } = {};
  if (list(include)) filter.include = list(include);
  if (list(exclude)) filter.exclude = list(exclude);
  return filter.include || filter.exclude ? filter : undefined;
}

/**
 * The MCP surface's flat search body (`toMcpSearchBody`) as the body
 * `POST /api/jobs/search` takes: one query becomes `queries`, each
 * `*_include` / `*_exclude` pair becomes a nested filter, and the salary pair
 * becomes a range. `include_facets` is a switch there and a list here.
 */
export function toPublicSearchBody(mcp: Record<string, unknown>): Record<string, unknown> {
  const query = typeof mcp.query === "string" && mcp.query.trim().length > 0 ? mcp.query.trim() : undefined;
  const salary =
    mcp.min_salary_usd !== undefined || mcp.max_salary_usd !== undefined
      ? { min: mcp.min_salary_usd, max: mcp.max_salary_usd }
      : undefined;

  const body: Record<string, unknown> = {
    queries: query ? [query] : undefined,
    search_description: mcp.search_description,
    locations: list(mcp.locations),
    sources: list(mcp.sources),
    companies: includeExclude(mcp.companies_include, mcp.companies_exclude),
    skills: includeExclude(mcp.skills_include, mcp.skills_exclude),
    industries: includeExclude(mcp.industries_include, mcp.industries_exclude),
    company_categories: includeExclude(mcp.company_categories_include, mcp.company_categories_exclude),
    job_categories: includeExclude(mcp.job_categories_include, mcp.job_categories_exclude),
    job_subcategories: includeExclude(mcp.job_subcategories_include, mcp.job_subcategories_exclude),
    occupation_ids: includeExclude(mcp.occupation_ids_include, mcp.occupation_ids_exclude),
    work_models: list(mcp.work_models),
    employment_types: list(mcp.employment_types),
    experience_levels: list(mcp.experience_levels),
    languages: list(mcp.languages),
    salary_usd: salary,
    posted_after: mcp.posted_after,
    posted_before: mcp.posted_before,
    discovered_after: mcp.discovered_after,
    discovered_before: mcp.discovered_before,
    sort: mcp.sort,
    page: mcp.page,
    page_size: mcp.page_size,
    // An empty list means "no facets"; leaving it out would bring the default set.
    include_facets: mcp.include_facets === true ? DEFAULT_FACETS : [],
  };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  return body;
}

/** 0 name starts with, 1 name contains, 2 subcategory or category contains, -1 no match. */
function occupationRank(occupation: UpstreamOccupation, query: string): number {
  const name = occupation.name.toLowerCase();
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (occupation.subcategory.toLowerCase().includes(query) || occupation.category.toLowerCase().includes(query)) {
    return 2;
  }
  return -1;
}

/** Occupations matching a name, best first: what `GET /api/mcp/occupations` does on the server. */
export function searchOccupations(
  taxonomy: PublicOccupationTaxonomy,
  q: string,
  limit: number,
): UpstreamOccupationSearchResponse {
  const query = q.trim().toLowerCase();
  if (query.length === 0) return { occupations: [] };

  const all: UpstreamOccupation[] = [];
  for (const category of taxonomy.categories ?? []) {
    for (const subcategory of category.subcategories ?? []) {
      for (const occupation of subcategory.occupations ?? []) {
        all.push({ id: occupation.id, name: occupation.name, category: category.name, subcategory: subcategory.name });
      }
    }
  }

  const bounded = Math.min(Math.max(Number.isFinite(limit) ? limit : OCCUPATION_DEFAULT_LIMIT, 1), OCCUPATION_MAX_LIMIT);
  const occupations = all
    .map((occupation) => ({ occupation, rank: occupationRank(occupation, query) }))
    .filter((entry) => entry.rank >= 0)
    .sort(
      (a, b) =>
        a.rank - b.rank || a.occupation.name.localeCompare(b.occupation.name, "en", { sensitivity: "base" }),
    )
    .slice(0, bounded)
    .map((entry) => entry.occupation);
  return { occupations };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The call
// ─────────────────────────────────────────────────────────────────────────────

let userAgent = "jobo-job-search-mcp";

/** Names this server and its version to the API. Set once at start-up. */
export function setUserAgent(value: string): void {
  userAgent = value;
}

let taxonomyCache: { key: string; at: number; value: Promise<PublicOccupationTaxonomy> } | undefined;

/** Test hook: forget the cached occupation taxonomy. */
export function clearOccupationCache(): void {
  taxonomyCache = undefined;
}

export async function callPublicApi<T>(method: string, path: string, apiKey: string, body?: unknown): Promise<T> {
  const headers = { "X-Api-Key": apiKey, "X-Jobo-Client": "mcp", "User-Agent": userAgent };
  const send = <R>(verb: string, target: string, payload?: unknown): Promise<R> =>
    requestJson<R>(verb, target, headers, payload);

  const url = new URL(path, "http://mcp.invalid");
  const route = url.pathname;
  const param = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;

  // search (GET, the canonical `search` tool) and search_jobs (POST).
  if (route === "/api/mcp/jobs/search") {
    const mcpBody: Record<string, unknown> =
      method === "POST"
        ? ((body ?? {}) as Record<string, unknown>)
        : {
            query: param("q"),
            page: param("page") ? Number(param("page")) : undefined,
            page_size: param("page_size") ? Number(param("page_size")) : undefined,
            include_facets: param("include_facets") === "true",
          };
    const res = await send<PublicSearchResponse>("POST", "/api/jobs/search", toPublicSearchBody(mcpBody));
    return toSearchResponse(res, mcpBody.include_facets === true) as T;
  }

  // fetch and get_job_details.
  if (route.startsWith("/api/mcp/jobs/")) {
    const id = route.slice("/api/mcp/jobs/".length);
    const job = await send<PublicJob>("GET", `/api/jobs/${id}`);
    return toDetails(job, param("include_description") === "true") as T;
  }

  // list_filters. The public surface has no free count of the whole index, and
  // a one-job search to get one would be billed, so the total is left unknown.
  if (route === "/api/mcp/filters") {
    const res = await send<PublicConnectorFilters>("GET", "/api/connectors/filters");
    const sources = res.sources ?? [];
    const filters: UpstreamFiltersResponse = {
      total_jobs: null,
      enums: {
        work_models: res.enums?.work_models ?? [],
        employment_types: res.enums?.employment_types ?? [],
        experience_levels: res.enums?.experience_levels ?? [],
        sources: sources.map((source) => source.key),
      },
      facets: sources.length > 0 ? { sources: sources.map(({ key, count }) => ({ key, count })) } : {},
    };
    return filters as T;
  }

  // find_filter_values for a named occupation: the public API serves the whole
  // taxonomy, so the name search the MCP surface does on the server happens here.
  if (route === "/api/mcp/occupations") {
    const now = Date.now();
    if (!taxonomyCache || taxonomyCache.key !== apiKey || now - taxonomyCache.at > OCCUPATION_CACHE_MS) {
      const value = send<PublicOccupationTaxonomy>("GET", "/api/occupations");
      taxonomyCache = { key: apiKey, at: now, value };
      // A failed load must not be remembered for an hour.
      value.catch(() => {
        if (taxonomyCache?.value === value) taxonomyCache = undefined;
      });
    }
    const limit = param("limit") ? Number(param("limit")) : OCCUPATION_DEFAULT_LIMIT;
    return searchOccupations(await taxonomyCache.value, param("q") ?? "", limit) as T;
  }

  // find_companies and find_filter_values: the same documents under /api/connectors.
  if (route === "/api/mcp/companies/suggest" || route.startsWith("/api/mcp/filter-options/")) {
    return send<T>(method, `/api/connectors${route.slice("/api/mcp".length)}${url.search}`);
  }

  throw new UpstreamError(404, `No public counterpart for ${method} ${route}.`);
}
