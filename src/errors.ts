/**
 * Upstream HTTP status → tool error text.
 *
 * Pure and dependency-free so it can be unit-tested directly: the model only
 * ever sees this string, so a raw JSON body leaking through is a real product
 * bug — it turns an actionable "top up your wallet" into noise the assistant
 * either parrots verbatim or silently gives up on.
 */

import { SEARCH_TIMED_OUT_TITLE, UpstreamError } from "./upstream.js";

export const REQUIRED_SCOPE = "jobs:read";

/** Where a caller tops the wallet up. Used when the API's own detail is missing. */
const TOP_UP_URL = "https://enterprise.jobo.world/credits";

/** Where an API key is created, for the local-mode messages. */
const API_KEYS_URL = "https://enterprise.jobo.world/api-keys";

/**
 * How this process authenticates to the API: a signed-in user's token on the
 * hosted server, an API key in local mode. One process is only ever one of
 * them, and the difference is what a failed call should tell the user to do.
 */
let authMode: "oauth" | "apiKey" = "oauth";

export function setAuthMode(mode: "oauth" | "apiKey"): void {
  authMode = mode;
}

/** Local mode was started without a key. The tool list still works; a call says this. */
export class MissingApiKeyError extends UpstreamError {
  constructor() {
    super(
      401,
      `No Jobo API key is configured. Set the JOBO_API_KEY environment variable for this server ` +
        `(create a key at ${API_KEYS_URL}) and restart it.`,
    );
    this.name = "MissingApiKeyError";
  }
}

// A type alias, not an interface: the MCP SDK's tool-result type carries an
// `[x: string]: unknown` index signature, and only aliases get the implicit
// index signature that makes them assignable to it.
export type ToolError = {
  content: { type: "text"; text: string }[];
  isError: true;
};

/**
 * Pull the RFC 9457 `detail` sentence out of a problem+json body. The External
 * API writes `detail` as a complete sentence aimed at the end user (it names
 * the shortfall and the top-up URL), which is exactly what belongs in the tool
 * result. Returns null for anything that isn't a problem document with a
 * non-empty string `detail`, so the caller can fall back rather than surface
 * a fragment of JSON.
 */
export function problemDetail(body: string): string | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const detail = (parsed as { detail?: unknown }).detail;
  return typeof detail === "string" && detail.trim().length > 0 ? detail.trim() : null;
}

interface UpstreamBody {
  /** A machine-readable code, e.g. `not_available_in_sandbox`. */
  code: string | null;
  /** The problem's `title`, e.g. "Search took too long". */
  title: string | null;
  /** The sentence the API wrote for a person: `detail`, else `error`, else `title`. */
  detail: string | null;
  /** Per-field messages of a validation problem, flattened. */
  fieldErrors: string[];
}

/**
 * Read the API's error body. It answers with RFC 9457 problem documents
 * (`detail`, `title`, and `errors` on a validation problem) and, from the key
 * check, with a bare `{ "error": "…" }`. Anything else that is JSON yields
 * nothing, so the caller falls back to its own sentence rather than surface a
 * fragment of JSON. A short plain-text body (no JSON, no HTML) is taken as the
 * sentence itself. The same reading as `readUpstreamBody` in the developer
 * server (`../dev-mcp/src/errors.ts`).
 */
export function readUpstreamBody(body: string): UpstreamBody {
  const empty: UpstreamBody = { code: null, title: null, detail: null, fieldErrors: [] };
  const trimmed = body?.trim() ?? "";
  if (!trimmed) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const plain = !/^[<{[]/.test(trimmed) && trimmed.length <= 300;
    return plain ? { ...empty, detail: trimmed } : empty;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return empty;
  const record = parsed as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };

  const fieldErrors: string[] = [];
  if (typeof record.errors === "object" && record.errors !== null) {
    for (const [field, messages] of Object.entries(record.errors as Record<string, unknown>)) {
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (typeof message === "string") fieldErrors.push(`${field}: ${message}`);
      }
    }
  }
  return {
    code: text("code"),
    title: text("title"),
    detail: text("detail") ?? text("error") ?? text("title"),
    fieldErrors,
  };
}

/** Text that ends like a sentence, so the next one can follow it. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The tools that read one job by id, where a 404 means the job is gone. */
const JOB_TOOLS: ReadonlySet<string> = new Set(["fetch", "get_job_details"]);

function notFoundMessage(body: UpstreamBody, tool: string | undefined): string {
  if (tool !== undefined && JOB_TOOLS.has(tool)) {
    return (
      "No job exists with that id. Job ids come from `search` or `search_jobs`; listings are removed once they " +
      "close, so search again rather than retrying the id."
    );
  }
  if (body.code === "not_available_in_sandbox") {
    return (
      "This lookup is not available with a sandbox key (jbe_test_…): the sandbox serves job search and lookups by " +
      "id only. Use a live key (jbe_live_…) for it; the lookups are free."
    );
  }
  if (tool === "find_filter_values") {
    return (
      `${body.detail ? sentence(body.detail) : "Those filter values are not available in this environment."} ` +
      "Search with the other filters, or by keyword, instead."
    );
  }
  return body.detail ? sentence(body.detail) : "The Jobo API has nothing at that address (HTTP 404).";
}

function serverErrorMessage(err: UpstreamError, body: UpstreamBody): string {
  // The one 5xx that waiting will not fix: the search itself was too broad or
  // too heavy for the time limit, and the API says so by sending no Retry-After.
  if (body.title === SEARCH_TIMED_OUT_TITLE) {
    return (
      "The search did not finish within its time limit, and running the same search again will not help. " +
      "Narrow it (fewer filters or places, or a shorter query) and search again. Nothing was billed."
    );
  }
  const what = `The Jobo API is temporarily unavailable (HTTP ${err.status})`;
  const why = body.detail ? `: ${sentence(body.detail)}` : ".";
  const when =
    err.retryAfterSeconds != null
      ? `Try again in ${err.retryAfterSeconds} second${err.retryAfterSeconds === 1 ? "" : "s"}.`
      : "Try again shortly.";
  return `${what}${why} ${when} Nothing was billed.`;
}

/**
 * The tool error for anything a tool call threw. `tool` is the tool that
 * failed: a 404 means a closed listing to `fetch`, and an unpublished facet to
 * `find_filter_values`.
 */
export function toToolError(err: unknown, tool?: string): ToolError {
  let text: string;
  if (err instanceof MissingApiKeyError) {
    text = err.message;
  } else if (err instanceof UpstreamError) {
    const body = readUpstreamBody(err.message);
    if (err.status === 401) {
      text =
        authMode === "apiKey"
          ? `Authentication failed: the Jobo API rejected the API key in JOBO_API_KEY. ` +
            `Check it at ${API_KEYS_URL}, set the variable again and restart this server.`
          : "Authentication failed: the Jobo API rejected the access token (it may have expired). " +
            "Re-authenticate and retry.";
    } else if (err.status === 402) {
      // Job search is billed per job returned. The API sends a problem+json
      // document whose `detail` already reads as a sentence — prefer it, and
      // never fall through to dumping the body.
      text =
        problemDetail(err.message) ??
        `This search could not run because the Jobo wallet is out of credits. ` +
          `Job search is billed per job returned; top up at ${TOP_UP_URL} and try again.`;
    } else if (err.status === 403) {
      text =
        authMode === "apiKey"
          ? (problemDetail(err.message) ?? "The Jobo API refused this request for this API key.")
          : `Authorization failed: the token is missing the required '${REQUIRED_SCOPE}' scope.`;
    } else if (err.status === 404) {
      text = notFoundMessage(body, tool);
    } else if (err.status === 429) {
      text =
        err.retryAfterSeconds != null
          ? `Rate limited — retry in ${err.retryAfterSeconds}s.`
          : "Rate limited by the Jobo API. Wait a moment before retrying.";
    } else if (err.status === 400) {
      const problems = body.fieldErrors.length > 0 ? body.fieldErrors.join(" ") : body.detail;
      text =
        `The Jobo API rejected the request${problems ? `: ${sentence(problems)}` : "."}` +
        "\n\nHint: call `list_filters` for the exact accepted values for work model, employment type, " +
        "experience level and source. Also note salary filters only match jobs whose employer disclosed a salary.";
    } else if (err.status >= 500) {
      text = serverErrorMessage(err, body);
    } else {
      text = body.detail ? sentence(body.detail) : `The Jobo API answered HTTP ${err.status}.`;
    }
  } else {
    text = `Could not reach the Jobo API: ${(err as Error).message}`;
  }
  return { content: [{ type: "text", text }], isError: true };
}
