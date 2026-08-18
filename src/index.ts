#!/usr/bin/env node
/**
 * Jobo job-search MCP server.
 *
 * Deliberately separate from Jobo.Enterprise.Mcp, which was re-scoped to
 * analytics-only in v4. Re-adding job tools there would undo that decision, so
 * this is a second server against the same External API. It exists mainly to
 * restore the canonical `search`/`fetch` pair: without them Jobo cannot be used
 * as a ChatGPT Deep Research connector.
 *
 * The shebang plus the package.json `bin` entry make this npx-runnable. This is
 * a Streamable HTTP server, not stdio — `npx jobo-job-search-mcp` boots the gateway
 * on $PORT (default 3002) and MCP clients then connect to http://host:3002/mcp.
 * README snippet, kept here because docs are owned elsewhere:
 *
 *   npx jobo-job-search-mcp                       # starts the HTTP server on :3002
 *   PORT=8080 npx jobo-job-search-mcp             # ...or any port you like
 */

import express from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  API_BASE_URL,
  UpstreamError,
  callApi,
  type UpstreamFiltersResponse,
  type UpstreamJobDetails,
  type UpstreamSearchResponse,
} from "./upstream.js";
import {
  renderSearchResults,
  toFetchPayload,
  toSearchPayload,
  renderJobDocument,
} from "./format.js";
import { EMPLOYMENT_TYPES, EXPERIENCE_LEVELS, WORK_MODELS } from "./filters.js";
import { REQUIRED_SCOPE, toToolError } from "./errors.js";

// ─────────────────────────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────────────────────────

const MCP_RESOURCE_URL = process.env.MCP_RESOURCE_URL ?? "https://jobs-mcp.jobo.world";
const AUTH_SERVER_URL = (process.env.OAUTH_AUTH_SERVER_URL ?? "https://enterprise.jobo.world").replace(/\/$/, "");
const PORT = Number(process.env.PORT ?? 3002);

const SERVER_NAME = "jobo-job-search";
const SERVER_VERSION = "1.1.0";

// ─────────────────────────────────────────────────────────────────────────────
//  Auth — gateway model
//
//  Same design as the analytics server, and for the same reason: the C#
//  External API validates the JWT with OpenIddict against the issuer, audience
//  and `jobs:read` scope. Verifying the signature a second time here would only
//  create a way for the two validators to drift. So this does the minimum a
//  gateway must:
//    1. Require a Bearer token; absent → 401 with the resource-metadata
//       challenge so the client starts the OAuth flow.
//    2. Cheaply reject an already-expired token (decode `exp`, no signature
//       check) so long-lived clients refresh instead of forwarding a dead token.
//    3. Attach the raw, current-request token to `req.auth`, so each tool call
//       forwards the token the client just sent — never one captured at
//       session-initialize.
// ─────────────────────────────────────────────────────────────────────────────

const RESOURCE_METADATA_URL = `${MCP_RESOURCE_URL}/.well-known/oauth-protected-resource`;

function challenge(error: "invalid_token" | "insufficient_scope" | "invalid_request", description: string): string {
  return `Bearer realm="${MCP_RESOURCE_URL}", error="${error}", error_description="${description}", resource_metadata="${RESOURCE_METADATA_URL}"`;
}

/**
 * Decode a JWT's `exp` WITHOUT verifying the signature — used only to
 * short-circuit a dead token at the HTTP layer. Returns null when unparseable,
 * in which case we forward and let the API decide.
 */
export function tokenExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

function requireBearer(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    res
      .status(401)
      .header("WWW-Authenticate", challenge("invalid_request", "Bearer token required"))
      .json({ error: "invalid_request", error_description: "Bearer token required" });
    return;
  }

  const token = header.slice("Bearer ".length).trim();

  const exp = tokenExpiry(token);
  if (exp !== null && exp * 1000 <= Date.now()) {
    res
      .status(401)
      .header("WWW-Authenticate", challenge("invalid_token", "The access token has expired"))
      .json({ error: "invalid_token", error_description: "The access token has expired" });
    return;
  }

  req.auth = { token, clientId: "", scopes: [] };
  next();
}

function bearerFrom(ctx: { http?: { authInfo?: AuthInfo } }): string {
  const token = ctx.http?.authInfo?.token;
  if (!token) throw new UpstreamError(401, "Missing access token on the request.");
  return token;
}

/** Build a querystring, dropping empties so the upstream sees only real filters. */
function query(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" ) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

// ─────────────────────────────────────────────────────────────────────────────
//  MCP server + tools
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_INSTRUCTIONS =
  "Jobo job search: a live index of millions of open jobs collected directly from employer career sites " +
  "and 150+ applicant tracking systems. Use `search` for a quick lookup by free text and `fetch` to read " +
  "one job in full. For anything with structure — a location, salary floor, seniority, work model, or a " +
  "specific ATS — use `search_jobs`, which exposes those as real filters instead of hoping a text query " +
  "captures them. Call `list_filters` first if you are unsure what values a filter accepts; the values are " +
  "canonical and lowercase (`remote`, `full-time`, `senior`). Every result carries a listing URL and an " +
  "apply URL — cite the listing URL. Never invent a job, a company or a salary that did not come back from " +
  "a tool call.";

function buildServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: "Jobo Job Search",
      version: SERVER_VERSION,
      websiteUrl: "https://jobo.world/mcp",
      description:
        "Search a live index of millions of open jobs collected from employer career sites and 150+ applicant tracking systems.",
      icons: [
        { src: "https://jobo.world/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
        { src: "https://jobo.world/apple-touch-icon.png", mimeType: "image/png", sizes: ["180x180"] },
      ],
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // ── search (canonical) ───────────────────────────────────────────────────
  // ChatGPT Deep Research requires a tool named exactly `search` taking a single
  // `query` string and returning {results: [{id, title, url}]}. Removing this
  // pair in v4 is what disqualified Jobo as a Deep Research connector.
  server.registerTool(
    "search",
    {
      title: "Search jobs",
      description:
        "Search live job listings by free text and return matching jobs with their ids, titles and URLs. " +
        "Pass the id of any result to `fetch` to read the full listing. For structured filtering " +
        "(location, salary, seniority, remote-only, specific ATS) prefer `search_jobs`.",
      inputSchema: z.object({
              query: z.string().describe("What to search for, e.g. 'senior rust engineer remote europe'."),
            }),
      outputSchema: z.object({
              results: z.array(
                z.object({
                  id: z.string(),
                  title: z.string(),
                  url: z.string(),
                }),
              ),
            }),
      annotations: {
        title: "Search jobs",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Searching jobs…",
        "openai/toolInvocation/invoked": "Jobs found",
      },
    },
    async ({ query: q }, ctx) => {
      try {
        const res = await callApi<UpstreamSearchResponse>(
          "GET",
          `/api/mcp/jobs/search${query({ q, page_size: 20 })}`,
          bearerFrom(ctx),
        );
        const payload = toSearchPayload(res);
        return {
          content: [{ type: "text", text: renderSearchResults(res) }],
          structuredContent: payload as unknown as { [k: string]: unknown },
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  // ── fetch (canonical) ────────────────────────────────────────────────────
  server.registerTool(
    "fetch",
    {
      title: "Fetch a job listing",
      description:
        "Retrieve one job listing in full by id — responsibilities, qualifications, benefits, compensation, " +
        "locations and company context, as readable text. Ids come from `search` or `search_jobs`.",
      inputSchema: z.object({
              id: z.string().describe("The job id returned by `search` or `search_jobs`."),
            }),
      outputSchema: z.object({
              id: z.string(),
              title: z.string(),
              text: z.string(),
              url: z.string(),
              metadata: z.record(z.string(), z.string()),
            }),
      annotations: {
        title: "Fetch job",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Reading the listing…",
        "openai/toolInvocation/invoked": "Listing read",
      },
    },
    async ({ id }, ctx) => {
      try {
        const res = await callApi<UpstreamJobDetails>(
          "GET",
          `/api/mcp/jobs/${encodeURIComponent(id)}`,
          bearerFrom(ctx),
        );
        const payload = toFetchPayload(res);
        return {
          content: [{ type: "text", text: payload.text }],
          structuredContent: payload as unknown as { [k: string]: unknown },
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  // ── search_jobs (rich) ───────────────────────────────────────────────────
  server.registerTool(
    "search_jobs",
    {
      title: "Search jobs with filters",
      description:
        "Search live job listings with structured filters. Prefer this over `search` whenever the question " +
        "has any structure to it — a place, a salary floor, a seniority, remote-only, a particular ATS.\n\n" +
        "Filter values are canonical and lowercase. Pass several as a comma-separated string " +
        "(`work_model: 'remote,hybrid'`):\n" +
        `- work_model: ${WORK_MODELS.join(", ")}\n` +
        `- employment_type: ${EMPLOYMENT_TYPES.join(", ")}\n` +
        `- experience_level: ${EXPERIENCE_LEVELS.join(", ")}\n` +
        "- source: an ATS id such as greenhouse, lever_co, ashby — `list_filters` has the full list\n\n" +
        "The free-text query always matches descriptions as well as titles; title-only matching " +
        "(`search_description: false` on the public API) is not supported on this endpoint.\n\n" +
        "Salary filters only match jobs whose employer published a range, which is a minority of listings — " +
        "applying one narrows results far more than it looks. Set `include_facets` to see how the matches " +
        "break down before narrowing further.",
      inputSchema: z.object({
              q: z.string().optional().describe("Free-text query matched against title and description."),
              location: z.string().optional().describe("Free-form location, e.g. 'Berlin, Germany' or 'United States'."),
              work_model: z
                .string()
                .optional()
                .describe(`Work model. One or more of: ${WORK_MODELS.join(", ")} (comma-separated).`),
              employment_type: z
                .string()
                .optional()
                .describe(`Employment type. One or more of: ${EMPLOYMENT_TYPES.join(", ")} (comma-separated).`),
              experience_level: z
                .string()
                .optional()
                .describe(`Experience level. One or more of: ${EXPERIENCE_LEVELS.join(", ")} (comma-separated).`),
              source: z.string().optional().describe("ATS source ids, comma-separated."),
              skills: z.string().optional().describe("Required skills, comma-separated."),
              industries: z.string().optional().describe("Company industries, comma-separated."),
              min_salary_usd: z.number().int().optional().describe("Only jobs with a published range at or above this."),
              max_salary_usd: z.number().int().optional().describe("Only jobs with a published range at or below this."),
              posted_after: z.string().optional().describe("ISO-8601 timestamp; only jobs posted on or after it."),
              posted_before: z.string().optional().describe("ISO-8601 timestamp; only jobs posted on or before it."),
              include_facets: z.boolean().optional().describe("Return counts per filter value alongside the results."),
              page: z.number().int().min(1).optional().describe("1-based page number. Defaults to 1."),
              page_size: z.number().int().min(1).max(50).optional().describe("Results per page, max 50. Defaults to 20."),
            }),
      annotations: {
        title: "Search jobs with filters",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Searching jobs…",
        "openai/toolInvocation/invoked": "Jobs found",
      },
    },
    async (args, ctx) => {
      try {
        const res = await callApi<UpstreamSearchResponse>(
          "GET",
          `/api/mcp/jobs/search${query({ ...args, page_size: args.page_size ?? 20 })}`,
          bearerFrom(ctx),
        );

        let text = renderSearchResults(res);
        if (args.include_facets && res.facets) {
          const facetLines = Object.entries(res.facets)
            .map(([name, values]) => {
              const top = values.slice(0, 10).map((v) => `${v.key} (${v.count})`).join(", ");
              return `- ${name}: ${top}`;
            })
            .join("\n");
          if (facetLines) text += `\n\nBreakdown:\n${facetLines}`;
        }

        return {
          content: [{ type: "text", text }],
          structuredContent: res as unknown as { [k: string]: unknown },
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  // ── get_job_details ──────────────────────────────────────────────────────
  server.registerTool(
    "get_job_details",
    {
      title: "Get full job details",
      description:
        "Read one job listing in full by id: responsibilities, required and preferred qualifications, " +
        "benefits, compensation, every location, and company context. Same data as `fetch`, for clients " +
        "that are not using the Deep Research contract.",
      inputSchema: z.object({
              id: z.string().describe("The job id returned by a search tool."),
              include_description: z
                .boolean()
                .optional()
                .describe("Append the raw employer description. Usually unnecessary — the extracted fields cover it and the raw text is long and boilerplate-heavy."),
            }),
      annotations: {
        title: "Get job details",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Reading the listing…",
        "openai/toolInvocation/invoked": "Listing read",
      },
    },
    async ({ id, include_description }, ctx) => {
      try {
        const res = await callApi<UpstreamJobDetails>(
          "GET",
          `/api/mcp/jobs/${encodeURIComponent(id)}`,
          bearerFrom(ctx),
        );

        let text = renderJobDocument(res);
        if (include_description && res.description) {
          text += `\n\n## Full description\n${res.description}`;
        }

        return {
          content: [{ type: "text", text }],
          structuredContent: res as unknown as { [k: string]: unknown },
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  // ── list_filters ─────────────────────────────────────────────────────────
  server.registerTool(
    "list_filters",
    {
      title: "List available filters",
      description:
        "Return the accepted values for every `search_jobs` filter, with how many jobs currently carry each " +
        "one. Call this when you are unsure what a filter accepts, or to size the index before narrowing a " +
        "search. Values are canonical — use them verbatim.",
      inputSchema: z.object({}),
      annotations: {
        title: "List filters",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Loading filters…",
        "openai/toolInvocation/invoked": "Filters ready",
      },
    },
    async (_args, ctx) => {
      try {
        const res = await callApi<UpstreamFiltersResponse>("GET", "/api/mcp/filters", bearerFrom(ctx));

        const sections: string[] = [`${res.total_jobs.toLocaleString("en-US")} active jobs indexed.`];
        sections.push(`**work_model:** ${res.enums.work_models.join(", ")}`);
        sections.push(`**employment_type:** ${res.enums.employment_types.join(", ")}`);
        sections.push(`**experience_level:** ${res.enums.experience_levels.join(", ")}`);
        sections.push(`**source:** ${res.enums.sources.join(", ")}`);

        for (const [name, values] of Object.entries(res.facets ?? {})) {
          const top = values.slice(0, 15).map((v) => `${v.key} (${v.count.toLocaleString("en-US")})`).join(", ");
          if (top) sections.push(`**${name} — current counts:** ${top}`);
        }

        return {
          content: [{ type: "text", text: sections.join("\n\n") }],
          structuredContent: res as unknown as { [k: string]: unknown },
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP server
// ─────────────────────────────────────────────────────────────────────────────

export const app = express();
app.use(express.json({ limit: "1mb" }));

function resourceMetadata(_req: express.Request, res: express.Response): void {
  res.json({
    resource: MCP_RESOURCE_URL,
    authorization_servers: [AUTH_SERVER_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: [REQUIRED_SCOPE],
  });
}
// Both RFC 9728 well-known forms: the root form and the path-suffixed form
// (`…/oauth-protected-resource/mcp`) that clients derive from the /mcp endpoint.
app.get("/.well-known/oauth-protected-resource", resourceMetadata);
app.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: `${SERVER_NAME}-mcp`, version: SERVER_VERSION });
});

// One factory, one endpoint, both protocol eras: `createMcpHandler` serves the
// 2026-07-28 revision (natively stateless — no handshake, no sessions) and,
// via its default `legacy: 'stateless'` fallback, answers 2025-era clients
// through exactly the per-request idiom this server always used. That idiom is
// deliberate: a per-session transport Map lives in process memory, so every
// restart or redeploy stranded clients with "No active session", and it pinned
// the deployment to one replica. The transport object holds live streams, so
// Redis cannot back it either. Method semantics (legacy GET/DELETE → 405) are
// owned by the handler. `toNodeHandler` forwards `req.auth` as the pass-through
// authInfo that tool handlers read via `ctx.http.authInfo`.
const mcpHandler = createMcpHandler(buildServer, {
  onerror: (err) => console.error("MCP request handling failed:", err),
});
const handleMcp = toNodeHandler(mcpHandler, {
  onerror: (err) => console.error("MCP request handling failed:", err),
});
app.all("/mcp", requireBearer, (req, res) => {
  void handleMcp(req, res, req.body);
});

// Skipped under test, which imports `app` directly.
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Jobo job-search MCP server listening on :${PORT}`);
    console.log(`  Resource URL:      ${MCP_RESOURCE_URL}`);
    console.log(`  Authorization srv: ${AUTH_SERVER_URL}`);
    console.log(`  Upstream API:      ${API_BASE_URL}`);
    console.log(`  Token validation:  delegated to the External API (${REQUIRED_SCOPE})`);
  });
}
