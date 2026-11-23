/**
 * Upstream client for the External API's /api/mcp/jobs/* surface.
 *
 * Those endpoints already existed and were built for exactly this: the C#
 * controller notes that the GET search is "convenient for the canonical ChatGPT
 * `search(query)` tool". This server is a thin OAuth-forwarding gateway in front
 * of them.
 *
 * In local mode (`--stdio`) there is no OAuth token, only an API key, and the
 * MCP surface does not take keys. `callApi` then answers the same call from the
 * public REST API instead: see `apikey.ts`.
 */

import { callPublicApi } from "./apikey.js";

const DEFAULT_API_BASE_URL = "https://connect.jobo.world";

export const API_BASE_URL = process.env.JOBO_API_URL ?? DEFAULT_API_BASE_URL;

/** Error carrying the upstream HTTP status so tool handlers can map it. */
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Whole seconds the upstream asked us to wait (Retry-After), when it said. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/**
 * Parse a Retry-After header into whole seconds. Accepts both forms the spec
 * allows — delta-seconds and an HTTP-date — and returns undefined when the
 * header is absent or unparseable.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

// Job search is a Typesense-backed read; it either answers quickly or something
// is wrong. 30s is generous against a p99 well under a second, and keeps a
// wedged request from hanging a model turn (Node's fetch has no default timeout).
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Transient upstream statuses worth retrying — gateway/unavailable only, never 4xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/** Who the caller is: a signed-in user's OAuth token, or an API key in local mode. */
export type Credential = { kind: "oauth"; token: string } | { kind: "apiKey"; key: string };

/**
 * One call on the MCP surface. A bare string is an OAuth token, as it always
 * was. With an API key the same call is answered from the public REST API, so
 * the tools above never need to know which one they are talking to.
 */
export async function callApi<T>(
  method: string,
  path: string,
  credential: string | Credential,
  body?: unknown,
): Promise<T> {
  const resolved: Credential = typeof credential === "string" ? { kind: "oauth", token: credential } : credential;
  if (resolved.kind === "apiKey") return callPublicApi<T>(method, path, resolved.key, body);
  return requestJson<T>(method, path, { Authorization: `Bearer ${resolved.token}` }, body);
}

/** The HTTP exchange itself: timeout, the retry rules above, and `UpstreamError` on a refusal. */
export async function requestJson<T>(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = (await response.text()).trim();
        if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
          lastError = new UpstreamError(response.status, text);
          await sleep(RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        // 429 is deliberately not retried here — the tool error tells the model
        // when to come back instead of this gateway sitting on the request.
        throw new UpstreamError(response.status, text, parseRetryAfter(response.headers.get("retry-after")));
      }

      if (response.status === 204) return {} as T;
      return (await response.json()) as T;
    } catch (err) {
      // Network-level failure (connection reset, DNS, timeout) during a rolling
      // deploy. UpstreamError from above is already final.
      if (err instanceof UpstreamError) throw err;
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("requestJson: exhausted retries");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Upstream response types (match the DTOs at the bottom of McpController.cs)
//
//  The External API serialises with JsonNamingPolicy.SnakeCaseLower, so these
//  are snake_case on the wire.
// ─────────────────────────────────────────────────────────────────────────────

export interface UpstreamCompany {
  id: string;
  name: string;
  logo_url: string | null;
  industries: string[];
  categories: string[];
  summary: string | null;
}

/** The job's occupation in the category › subcategory › occupation taxonomy. */
export interface UpstreamOccupation {
  id: string;
  name: string;
  category: string;
  subcategory: string;
}

export interface UpstreamLocation {
  city: string | null;
  region: string | null;
  country: string | null;
  is_remote: boolean;
}

export interface UpstreamCompensation {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: string | null;
}

export interface UpstreamJobFlags {
  is_h1b_sponsor: boolean | null;
  is_work_auth_required: boolean | null;
  is_clearance_required: boolean | null;
}

export interface UpstreamJobSummary {
  id: string;
  title: string;
  normalized_title: string | null;
  /** Null when the job is not classified. */
  occupation: UpstreamOccupation | null;
  summary: string | null;
  listing_url: string;
  apply_url: string;
  source: string;
  date_posted: string | null;
  workplace_type: string | null;
  employment_type: string | null;
  experience_level: string | null;
  compensation: UpstreamCompensation | null;
  location: UpstreamLocation | null;
  company: UpstreamCompany;
  top_skills: string[];
  flags: UpstreamJobFlags;
}

export interface UpstreamSearchResponse {
  jobs: UpstreamJobSummary[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  has_more: boolean;
  next_page: number | null;
  facets?: Record<string, Array<{ key: string; count: number }>> | null;
  /** Plain-prose filter warnings, e.g. a company name that matched nothing. */
  notes?: string[] | null;
}

export interface UpstreamQualificationGroup {
  education: string[];
  certifications: string[];
  skills: Array<{ name: string; type: string | null }>;
}

export interface UpstreamJobDetails {
  summary: UpstreamJobSummary;
  qualifications: {
    must_have: UpstreamQualificationGroup | null;
    preferred: UpstreamQualificationGroup | null;
  };
  responsibilities: string[];
  benefits: string[];
  all_locations: Array<{
    location: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
  }>;
  valid_through: string | null;
  created_at: string;
  updated_at: string;
  description: string | null;
}

export interface UpstreamFiltersResponse {
  /** Null in local mode: the public API has no free count of the whole index. */
  total_jobs: number | null;
  enums: {
    work_models: string[];
    employment_types: string[];
    experience_levels: string[];
    sources: string[];
  };
  facets: Record<string, Array<{ key: string; count: number }>>;
}

/** One real company from `GET /api/mcp/companies/suggest` (ConnectorCompanySuggestion). */
export interface UpstreamCompanySuggestion {
  /** The board with the most live jobs. */
  id: string;
  /** Every board id of the company — a `companies` filter should carry all of them. */
  ids: string[];
  name: string;
  domain: string | null;
  logo_url: string | null;
  /** HQ country, ISO 3166-1 alpha-2. */
  country: string | null;
  /** Live jobs across `ids`; null when the count was unavailable. */
  job_count: number | null;
}

export interface UpstreamCompanySuggestionsResponse {
  suggestions: UpstreamCompanySuggestion[];
}

/** One value of a filter facet; `name`/`parent` only on the occupation facets. */
export interface UpstreamFilterOption {
  key: string;
  count: number;
  name?: string | null;
  parent?: string | null;
}

export interface UpstreamFilterOptionsResponse {
  facet: string;
  options: UpstreamFilterOption[];
}

/** `GET /api/mcp/occupations?q=` — occupations matching a name, best first. */
export interface UpstreamOccupationSearchResponse {
  occupations: UpstreamOccupation[];
}
