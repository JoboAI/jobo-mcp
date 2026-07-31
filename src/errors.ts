/**
 * Upstream HTTP status → tool error text.
 *
 * Pure and dependency-free so it can be unit-tested directly: the model only
 * ever sees this string, so a raw JSON body leaking through is a real product
 * bug — it turns an actionable "top up your wallet" into noise the assistant
 * either parrots verbatim or silently gives up on.
 */

import { UpstreamError } from "./upstream.js";

export const REQUIRED_SCOPE = "jobs:read";

/** Where a caller tops the wallet up. Used when the API's own detail is missing. */
const TOP_UP_URL = "https://enterprise.jobo.world/credits";

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

export function toToolError(err: unknown): ToolError {
  let text: string;
  if (err instanceof UpstreamError) {
    if (err.status === 401) {
      text =
        "Authentication failed: the Jobo API rejected the access token (it may have expired). " +
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
      text = `Authorization failed: the token is missing the required '${REQUIRED_SCOPE}' scope.`;
    } else if (err.status === 404) {
      text = "No job exists with that id. Job ids come from `search` or `search_jobs`; listings are removed once they close.";
    } else if (err.status === 429) {
      text =
        err.retryAfterSeconds != null
          ? `Rate limited — retry in ${err.retryAfterSeconds}s.`
          : "Rate limited by the Jobo API. Wait a moment before retrying.";
    } else {
      text = err.message || `Jobo API error ${err.status}.`;
      if (err.status === 400) {
        text +=
          "\n\nHint: call `list_filters` for the exact accepted values for work model, employment type, " +
          "experience level and source. Also note salary filters only match jobs whose employer disclosed a salary.";
      }
    }
  } else {
    text = `Could not reach the Jobo API: ${(err as Error).message}`;
  }
  return { content: [{ type: "text", text }], isError: true };
}
