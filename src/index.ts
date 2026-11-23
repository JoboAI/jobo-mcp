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

import { createHash } from "node:crypto";

import express from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import {
  API_BASE_URL,
  UpstreamError,
  callApi,
  type Credential,
  type UpstreamCompanySuggestionsResponse,
  type UpstreamFilterOptionsResponse,
  type UpstreamFiltersResponse,
  type UpstreamJobDetails,
  type UpstreamOccupationSearchResponse,
  type UpstreamSearchResponse,
} from "./upstream.js";
import {
  renderCompanySuggestions,
  renderFilterValues,
  renderOccupationMatches,
  renderSearchResults,
  toFetchPayload,
  toSearchPayload,
  renderJobDocument,
} from "./format.js";
import {
  COMPANY_CATEGORIES,
  FILTER_VALUE_FACETS,
  LANGUAGES,
  SEARCH_JOBS_INPUT,
  SEARCH_SORTS,
  toMcpSearchBody,
} from "./filters.js";
import { MissingApiKeyError, REQUIRED_SCOPE, setAuthMode, toToolError } from "./errors.js";
import { setUserAgent } from "./apikey.js";
import {
  AI_CATALOG_MEDIA_TYPE,
  SERVER_CARD_MEDIA_TYPE,
  buildAiCatalog,
  buildServerCard,
  etagMatches,
  isPublicDiscoveryRequest,
  publicDiscoveryEnabled,
  serverCardUrl,
} from "./discovery.js";

// ─────────────────────────────────────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────────────────────────────────────

const MCP_RESOURCE_URL = process.env.MCP_RESOURCE_URL ?? "https://jobs-mcp.jobo.world";
const MCP_ENDPOINT_URL = `${MCP_RESOURCE_URL.replace(/\/$/, "")}/mcp`;
const AUTH_SERVER_URL = (process.env.OAUTH_AUTH_SERVER_URL ?? "https://enterprise.jobo.world").replace(/\/$/, "");
/**
 * The authorization server's issuer identifier, exactly as its own metadata
 * publishes it: with a trailing slash. RFC 8414 §3.3 has a client compare the
 * issuer it was pointed at with the one the metadata declares, and a strict
 * client (mcp-remote 0.16) refuses to sign in when they differ by that slash.
 */
export const AUTH_SERVER_ISSUER = process.env.OAUTH_AUTH_SERVER_ISSUER ?? `${AUTH_SERVER_URL}/`;
const PORT = Number(process.env.PORT ?? 3002);
/**
 * Local mode: serve MCP over stdio instead of HTTP, as the caller who owns
 * `JOBO_API_KEY`. This is how a client that starts servers as child processes
 * runs it, and how a directory builds and inspects it.
 */
const STDIO = process.argv.includes("--stdio");
const LOCAL_API_KEY = process.env.JOBO_API_KEY?.trim() || undefined;
/** Answer the handshake and the list methods without a token. Opt-in: see `publicDiscoveryEnabled`. */
const PUBLIC_DISCOVERY = publicDiscoveryEnabled(process.env.MCP_PUBLIC_DISCOVERY);

const SERVER_NAME = "jobo-job-search";
const SERVER_VERSION = "1.4.1";

// Identity shared by `server/discover` and the Server Card, which must not
// contradict each other. REGISTRY_NAME and the description are the ones in
// `server.json`; a test fails when the card and that manifest drift apart.
const REGISTRY_NAME = "world.jobo/job-search";
const SERVER_TITLE = "Jobo Job Search";
const SERVER_DESCRIPTION =
  "Search a live index of millions of open jobs from employer career sites and 200+ ATS platforms.";
const SERVER_WEBSITE = "https://jobo.world/mcp";
const SERVER_REPOSITORY = "https://github.com/JoboAI/jobo-mcp";
const SERVER_ICONS = [
  { src: "https://jobo.world/apple-touch-icon.png", mimeType: "image/png", sizes: ["180x180"] },
  { src: "https://jobo.world/favicon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
];

/** 2026-07-28 first, then every 2025-era revision the legacy fallback answers. */
const PROTOCOL_VERSIONS = ["2026-07-28", ...SUPPORTED_PROTOCOL_VERSIONS];

// ─────────────────────────────────────────────────────────────────────────────
//  Auth — gateway model
//
//  Same design as the analytics server, and for the same reason: the C#
//  External API validates the JWT with OpenIddict against the issuer, audience
//  and `jobs:read` scope. Verifying the signature a second time here would only
//  create a way for the two validators to drift. So this does the minimum a
//  gateway must:
//    1. With MCP_PUBLIC_DISCOVERY on, answer discovery (the handshake and the
//       list methods) without a token, so the tool schemas are readable before
//       sign-in. Nothing on that path touches the upstream API.
//    2. Require a Bearer token for everything else; absent → 401 with the
//       resource-metadata challenge so the client starts the OAuth flow. It
//       has to be a real HTTP 401: clients start sign-in from the status, not
//       from an error inside a 200.
//    3. Cheaply reject an already-expired token (decode `exp`, no signature
//       check) so long-lived clients refresh instead of forwarding a dead token.
//    4. Attach the raw, current-request token to `req.auth`, so each tool call
//       forwards the token the client just sent — never one captured at
//       session-initialize.
// ─────────────────────────────────────────────────────────────────────────────

const RESOURCE_METADATA_URL = `${MCP_RESOURCE_URL}/.well-known/oauth-protected-resource`;

function challenge(error: "invalid_token" | "insufficient_scope" | "invalid_request", description: string): string {
  return (
    `Bearer realm="${MCP_RESOURCE_URL}", error="${error}", error_description="${description}", ` +
    `resource_metadata="${RESOURCE_METADATA_URL}", scope="${REQUIRED_SCOPE}"`
  );
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

function authenticate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    // No token: discovery is answered as it is for everyone, with no `req.auth`.
    if (PUBLIC_DISCOVERY && isPublicDiscoveryRequest(req.method, req.body)) {
      next();
      return;
    }
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

/**
 * Who a tool call is made as. On the hosted server that is the token the
 * client just sent. In local mode (`--stdio`) there is no HTTP request and no
 * sign-in: the caller is whoever owns the key in `JOBO_API_KEY`.
 */
function bearerFrom(ctx: { http?: { authInfo?: AuthInfo } }): Credential {
  const token = ctx.http?.authInfo?.token;
  if (token) return { kind: "oauth", token };
  if (STDIO) {
    if (!LOCAL_API_KEY) throw new MissingApiKeyError();
    return { kind: "apiKey", key: LOCAL_API_KEY };
  }
  throw new UpstreamError(401, "Missing access token on the request.");
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
  "and 200+ applicant tracking systems. Use `search` for a quick lookup by free text and `fetch` to read " +
  "one job in full. For anything with structure — a location, company, occupation, salary floor, seniority, " +
  "work model, language, or a specific ATS — use `search_jobs`, which exposes those as real filters instead " +
  "of hoping a text query captures them. Resolve names to filter values before searching: `find_companies` " +
  "turns a company name into its ids (pass every id it returns), and `find_filter_values` lists " +
  "occupations, job categories and subcategories, skills, industries and ATS sources with live job counts. " +
  "`list_filters` shows the fixed vocabularies; values are canonical and lowercase (`remote`, `full-time`, " +
  "`senior`). Every result carries a listing URL and an apply URL — cite the listing URL. Never invent a " +
  "job, a company or a salary that did not come back from a tool call.";

/**
 * Every tool needs the user's token. `tools/list` can be read before sign-in
 * (MCP_PUBLIC_DISCOVERY), so each tool says so itself: this is the per-tool
 * declaration ChatGPT reads (`securitySchemes`, carried in `_meta` because the
 * SDK only passes known top-level tool fields through).
 */
const OAUTH_REQUIRED = STDIO ? {} : { securitySchemes: [{ type: "oauth2", scopes: [REQUIRED_SCOPE] }] };

/** The catalogue is the same for every caller and only changes on a deploy. */
const PUBLIC_CACHE = { ttlMs: 5 * 60 * 1000, cacheScope: "public" } as const;

function buildServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version: SERVER_VERSION,
      websiteUrl: SERVER_WEBSITE,
      description: SERVER_DESCRIPTION,
      icons: SERVER_ICONS,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
      cacheHints: { "server/discover": PUBLIC_CACHE, "tools/list": PUBLIC_CACHE },
    },
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
        "Search live job listings by free text and return up to 20 matching jobs, most relevant first, each " +
        "with its id, a title line (job title, company, location) and URL. Pass the id of any result to " +
        "`fetch` to read the full listing. For structured filtering (location, salary, seniority, " +
        "remote-only, specific ATS) or more than 20 results, prefer `search_jobs`.",
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
        ...OAUTH_REQUIRED,
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
        "Retrieve one job listing in full by id as a single readable document: responsibilities, " +
        "qualifications, benefits, compensation, locations and company context. This is the document form " +
        "that pairs with `search`; `get_job_details` returns the same listing as structured fields and can " +
        "append the raw employer description. An unknown id, or one whose listing has closed and been " +
        "removed, returns an error. Free.",
      inputSchema: z.object({
              id: z.string().describe("The job's id, a UUID, exactly as `search` or `search_jobs` returned it."),
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
        ...OAUTH_REQUIRED,
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
  // POSTs the typed body: list filters travel as JSON arrays, so a value with a
  // comma in it (a company name) survives intact.
  server.registerTool(
    "search_jobs",
    {
      title: "Search jobs with filters",
      description:
        "Search live job listings with structured filters. Prefer this over `search` whenever the question " +
        "has any structure to it — a place, a company, an occupation, a salary floor, a seniority, " +
        "remote-only, a language, a particular ATS.\n\n" +
        "Returns the total number of matches and one page of jobs, most relevant first unless `sort` says " +
        "otherwise: 20 by default, `page_size` up to 50, `page` for the next. Each job has its title, " +
        "company, location, employment type, level, published pay, occupation, top skills, a short summary, " +
        "listing URL and id; pass the id to `get_job_details` for the full listing. No match returns a " +
        "message, not an error, with a note when a filter value such as a company name matched nothing.\n\n" +
        "Fixed vocabularies (work_model, employment_type, experience_level, company_categories, language, " +
        "sort) are listed on each parameter; values are canonical and lowercase.\n\n" +
        "Open vocabularies — look the values up first:\n" +
        "- companies: call `find_companies` and pass every id it returns for the company\n" +
        "- occupation_ids, job_categories, job_subcategories, skills, industries, sources: call " +
        "`find_filter_values` with that facet\n\n" +
        "companies, skills, industries, company_categories, job_categories, job_subcategories and " +
        "occupation_ids each have an exclude_ twin (exclude_companies, exclude_skills, …). Set " +
        "search_description: false for title-only matching. Use discovered_after for 'new since …' " +
        "questions.\n\n" +
        "Salary filters only match jobs whose employer published a range, which is a minority of listings — " +
        "applying one narrows results far more than it looks. Set `include_facets` to see how the matches " +
        "break down before narrowing further.",
      inputSchema: SEARCH_JOBS_INPUT,
      annotations: {
        title: "Search jobs with filters",
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        ...OAUTH_REQUIRED,
        "openai/toolInvocation/invoking": "Searching jobs…",
        "openai/toolInvocation/invoked": "Jobs found",
      },
    },
    async (args, ctx) => {
      try {
        const res = await callApi<UpstreamSearchResponse>(
          "POST",
          "/api/mcp/jobs/search",
          bearerFrom(ctx),
          toMcpSearchBody(args),
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

  // ── find_companies ───────────────────────────────────────────────────────
  server.registerTool(
    "find_companies",
    {
      title: "Find companies",
      description:
        "Look up companies by name or website domain (prefix match, 2+ characters) and return each with its " +
        "Jobo company ids, domain, HQ country and live job count — companies with live jobs first. Use it " +
        "before filtering `search_jobs` by company: pass every id of the company you mean as `companies` " +
        "(one company can have several ids, one per careers board). It returns at most `limit` companies " +
        "(8 by default), and a message, not an error, when nothing matches. Free.",
      inputSchema: z.object({
        q: z.string().describe("Company name or domain prefix, e.g. 'stripe' or 'stripe.com'."),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum companies to return (1–20, default 8)."),
      }),
      annotations: {
        title: "Find companies",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        ...OAUTH_REQUIRED,
        "openai/toolInvocation/invoking": "Looking up companies…",
        "openai/toolInvocation/invoked": "Companies found",
      },
    },
    async ({ q, limit }, ctx) => {
      try {
        const res = await callApi<UpstreamCompanySuggestionsResponse>(
          "GET",
          `/api/mcp/companies/suggest${query({ q, limit })}`,
          bearerFrom(ctx),
        );
        return {
          content: [{ type: "text", text: renderCompanySuggestions(q, res.suggestions ?? []) }],
          structuredContent: res as unknown as { [k: string]: unknown },
        };
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  // ── find_filter_values ───────────────────────────────────────────────────
  server.registerTool(
    "find_filter_values",
    {
      title: "Find filter values",
      description:
        "List the values of one open-vocabulary `search_jobs` filter, optionally narrowed by `q`. Facets: " +
        "occupations (a role name such as 'registered nurse' → its occupation id, category and subcategory, " +
        "for occupation_ids), job_categories, job_subcategories (with their category), skills, industries, " +
        "company_categories, sources (ATS ids). Without `q` it lists the values with the most live jobs. " +
        "Each line gives the value to pass, its display name and parent where it has one, and its live job " +
        "count; a named occupation returns matching ids with their category and subcategory, best first. " +
        "Nothing matching returns a message, not an error. Use it to turn a role, field or skill the user " +
        "names into the exact value a filter takes; for companies use `find_companies`, and for the fixed " +
        "vocabularies `list_filters`. Free.",
      inputSchema: z.object({
        facet: z.enum(FILTER_VALUE_FACETS).describe("Which filter's values to list."),
        q: z
          .string()
          .optional()
          .describe(
            "What to look for. For occupations, any part of the role, subcategory or category name ('nurse'); " +
              "for the other facets, the start of a value ('nurs', 'pyth'). Omit for the most common values.",
          ),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum values to return (default 25)."),
      }),
      annotations: {
        title: "Find filter values",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        ...OAUTH_REQUIRED,
        "openai/toolInvocation/invoking": "Looking up filter values…",
        "openai/toolInvocation/invoked": "Filter values ready",
      },
    },
    async ({ facet, q, limit }, ctx) => {
      try {
        // Occupation facet buckets are keyed by id, so a name never prefix-
        // matches them: a named role goes to the taxonomy search instead.
        if (facet === "occupations" && q?.trim()) {
          const found = await callApi<UpstreamOccupationSearchResponse>(
            "GET",
            `/api/mcp/occupations${query({ q: q.trim(), limit: limit ?? 25 })}`,
            bearerFrom(ctx),
          );
          return {
            content: [{ type: "text", text: renderOccupationMatches(q.trim(), found.occupations ?? []) }],
            structuredContent: found as unknown as { [k: string]: unknown },
          };
        }

        const res = await callApi<UpstreamFilterOptionsResponse>(
          "GET",
          `/api/mcp/filter-options/${encodeURIComponent(facet)}${query({ q, limit: limit ?? 25 })}`,
          bearerFrom(ctx),
        );
        return {
          content: [{ type: "text", text: renderFilterValues(facet, q, res.options ?? []) }],
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
        "benefits, compensation, every location, and company context, as readable text with the structured " +
        "fields alongside. Use it after `search_jobs`; `fetch` returns the same listing as one text document " +
        "for clients that pair it with `search`. An unknown id, or one whose listing has closed and been " +
        "removed, returns an error: search again instead of retrying the id. Free.",
      inputSchema: z.object({
              id: z.string().describe("The job's id, a UUID, exactly as a search tool returned it."),
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
        ...OAUTH_REQUIRED,
        "openai/toolInvocation/invoking": "Reading the listing…",
        "openai/toolInvocation/invoked": "Listing read",
      },
    },
    async ({ id, include_description }, ctx) => {
      try {
        const res = await callApi<UpstreamJobDetails>(
          "GET",
          `/api/mcp/jobs/${encodeURIComponent(id)}${query({ include_description: include_description ? true : undefined })}`,
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
        "Return the fixed vocabularies `search_jobs` accepts (work models, employment types, experience " +
        "levels, company categories, languages, sort orders, ATS sources), with live counts for the common " +
        "ones. Call this when you are unsure what a filter accepts, or to size the index before narrowing a " +
        "search. It takes no arguments and returns one line per filter, `name: value, value, …`, then the " +
        "live counts as `value (count)`. Values are canonical — use them verbatim. For companies, " +
        "occupations, job categories, skills and industries use `find_companies` and `find_filter_values`. " +
        "Free.",
      inputSchema: z.object({}),
      annotations: {
        title: "List filters",
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        ...OAUTH_REQUIRED,
        "openai/toolInvocation/invoking": "Loading filters…",
        "openai/toolInvocation/invoked": "Filters ready",
      },
    },
    async (_args, ctx) => {
      try {
        const res = await callApi<UpstreamFiltersResponse>("GET", "/api/mcp/filters", bearerFrom(ctx));

        const sections: string[] =
          res.total_jobs != null ? [`${res.total_jobs.toLocaleString("en-US")} active jobs indexed.`] : [];
        sections.push(`**work_model:** ${res.enums.work_models.join(", ")}`);
        sections.push(`**employment_type:** ${res.enums.employment_types.join(", ")}`);
        sections.push(`**experience_level:** ${res.enums.experience_levels.join(", ")}`);
        sections.push(`**company_categories:** ${COMPANY_CATEGORIES.join(", ")}`);
        sections.push(
          `**language** (ISO 639-1; any code works): ${LANGUAGES.map((l) => `${l.code} (${l.name})`).join(", ")}`,
        );
        sections.push(`**sort:** ${SEARCH_SORTS.join(", ")}`);
        sections.push(`**sources:** ${res.enums.sources.join(", ")}`);
        sections.push(
          "**companies, occupation_ids, job_categories, job_subcategories, skills, industries:** open " +
            "vocabularies — look values up with `find_companies` and `find_filter_values`.",
        );

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
    authorization_servers: [AUTH_SERVER_ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: [REQUIRED_SCOPE],
  });
}
// Both RFC 9728 well-known forms: the root form and the path-suffixed form
// (`…/oauth-protected-resource/mcp`) that clients derive from the /mcp endpoint.
app.get("/.well-known/oauth-protected-resource", resourceMetadata);
app.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata);

// Server Card (SEP-2127) and the AI Catalog pointing at it: who the server is
// and where to connect, for a client that has not connected yet. Public by
// design — identity and the endpoint URL only, no tools and no credentials.
// The CORS and cache headers are the ones the card's discovery doc asks for.
function publicDocument(mediaType: string, document: object): express.RequestHandler {
  const body = JSON.stringify(document);
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  return (req, res) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
      "Access-Control-Expose-Headers": "ETag",
      "Cache-Control": "public, max-age=3600",
      ETag: etag,
    });
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    if (etagMatches(req.headers["if-none-match"], etag)) {
      res.status(304).end();
      return;
    }
    res.type(mediaType).send(body);
  };
}

const serverCard = publicDocument(
  SERVER_CARD_MEDIA_TYPE,
  buildServerCard({
    name: REGISTRY_NAME,
    title: SERVER_TITLE,
    version: SERVER_VERSION,
    description: SERVER_DESCRIPTION,
    websiteUrl: SERVER_WEBSITE,
    repositoryUrl: SERVER_REPOSITORY,
    icons: SERVER_ICONS,
    endpointUrl: MCP_ENDPOINT_URL,
    protocolVersions: PROTOCOL_VERSIONS,
  }),
);
const aiCatalog = publicDocument(
  AI_CATALOG_MEDIA_TYPE,
  buildAiCatalog(REGISTRY_NAME, serverCardUrl(MCP_ENDPOINT_URL)),
);
// `/mcp/server-card` is the reserved location: the card sits under the endpoint
// it describes. It is its own route, outside `authenticate` — the card must
// never ask for a token.
app.get("/mcp/server-card", serverCard);
app.options("/mcp/server-card", serverCard);
app.get("/.well-known/ai-catalog.json", aiCatalog);
app.options("/.well-known/ai-catalog.json", aiCatalog);

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
app.all("/mcp", authenticate, (req, res) => {
  void handleMcp(req, res, req.body);
});

// Local mode: one client, stdin and stdout. Nothing but protocol messages may
// reach stdout, so the start-up line goes to stderr.
if (STDIO) {
  setAuthMode("apiKey");
  setUserAgent(`${SERVER_NAME}-mcp/${SERVER_VERSION} (stdio)`);
  serveStdio(buildServer, { onerror: (err) => console.error("MCP request handling failed:", err) });
  console.error(
    `Jobo job-search MCP server on stdio (${LOCAL_API_KEY ? "API key set" : "no JOBO_API_KEY: tool calls will ask for one"}).`,
  );
}

// Skipped under test, which imports `app` directly, and in local mode.
if (!STDIO && process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Jobo job-search MCP server listening on :${PORT}`);
    console.log(`  Resource URL:      ${MCP_RESOURCE_URL}`);
    console.log(`  Authorization srv: ${AUTH_SERVER_URL}`);
    console.log(`  Upstream API:      ${API_BASE_URL}`);
    console.log(`  Token validation:  delegated to the External API (${REQUIRED_SCOPE})`);
    console.log(
      `  Public discovery:  ${PUBLIC_DISCOVERY ? "on (handshake + list methods need no token)" : "off (set MCP_PUBLIC_DISCOVERY=true)"}`,
    );
    console.log(`  Server card:       ${serverCardUrl(MCP_ENDPOINT_URL)}`);
  });
}
