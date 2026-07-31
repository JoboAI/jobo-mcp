/**
 * Upstream client for the External API's /api/mcp/jobs/* surface.
 *
 * Those endpoints already existed and were built for exactly this: the C#
 * controller notes that the GET search is "convenient for the canonical ChatGPT
 * `search(query)` tool". This server is a thin OAuth-forwarding gateway in front
 * of them.
 */

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

export async function callApi<T>(method: string, path: string, bearer: string, body?: unknown): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
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

  throw lastError ?? new Error("callApi: exhausted retries");
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
  total_jobs: number;
  enums: {
    work_models: string[];
    employment_types: string[];
    experience_levels: string[];
    sources: string[];
  };
  facets: Record<string, Array<{ key: string; count: number }>>;
}
