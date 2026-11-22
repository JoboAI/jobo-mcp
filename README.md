# Jobo Job Search MCP Server

Remote MCP server exposing Jobo's live job index — millions of listings collected from employer career
sites and 200+ applicant tracking systems — to LLM clients.

Full client setup (Claude, ChatGPT, Cursor, Codex CLI) and the tool reference:
[jobo.world/docs/connectors/mcp](https://jobo.world/docs/connectors/mcp).

- **Transport:** Streamable HTTP, single `/mcp` endpoint, stateless. Serves MCP spec **2026-07-28**
  natively and every 2025-era client through the built-in legacy fallback (SDK v2
  `createMcpHandler`, one factory for both eras).
- **Auth:** OAuth 2.1. This is a Resource Server; the Authorization Server is the Jobo API. Clients log in
  with their Jobo account — no API key copy-paste. Required scope: `jobs:read`.
- **Discovery without a token:** a public [Server Card](#discovery-without-a-token) at `/mcp/server-card`,
  and, opt-in, the tool schemas themselves (`MCP_PUBLIC_DISCOVERY`).

## Self-hosting

The hosted deployment is `https://jobs-mcp.jobo.world`. To run your own copy instead:

```bash
npx jobo-job-search-mcp
```

Starts the Streamable HTTP server on `$PORT` (default `3002`); point your client at
`http://localhost:3002/mcp`. This changes *where* the gateway runs, not its auth model — it's still an
OAuth resource server gated on Jobo account sign-in, since the upstream API validates every request against
the Authorization Server regardless of which copy of the gateway forwarded it. Set `MCP_RESOURCE_URL` to
match whatever host you actually serve it from — see [Configuration](#configuration) below.

## Why this is a separate server

`Jobo.Enterprise/Jobo.Enterprise.Mcp` was deliberately re-scoped to analytics-only in v4, which removed
`search_jobs`, `get_job_details`, `list_filters`, `search` and `fetch`. Adding job tools back there would
undo that decision, so this is a second server against the same External API.

The `/api/mcp/jobs/*` endpoints were never removed — `McpController.cs` still serves them, and its own
comment notes the GET search is "convenient for the canonical ChatGPT `search(query)` tool". This server
is a thin OAuth-forwarding gateway in front of endpoints that were built for it.

The immediate payoff: **`search` + `fetch` restore Deep Research compatibility.** Without that canonical
pair a server cannot be used as a ChatGPT Deep Research connector at all.

## Tools

| Tool | Purpose |
| --- | --- |
| `search` | Canonical Deep Research contract: `{query}` → `{results: [{id, title, url}]}`. |
| `fetch` | Canonical Deep Research contract: `{id}` → `{id, title, text, url, metadata}`. |
| `search_jobs` | Structured search over the full connector filter set — see below. |
| `find_companies` | Company name or domain prefix → each company's ids, domain, country and live job count. |
| `find_filter_values` | Values of one open-vocabulary filter (occupations, job categories/subcategories, skills, industries, company categories, sources), with live counts. |
| `get_job_details` | Full listing for clients not using the Deep Research contract. |
| `list_filters` | The fixed vocabularies (work models, employment types, levels, company categories, languages, sorts, sources), with live counts. |

`search`/`fetch` deliberately take the minimum arguments the contract allows. Anything with structure
should go through `search_jobs`, where filters are real parameters rather than hopeful free text.

### `search_jobs` filters

`search_jobs` exposes every filter of the shared connector contract (`JOB_SEARCH_FILTERS` in
`@jobo-ai/connector-core`, pinned exactly in `package.json`) except `description_format` — MCP search
results carry no description. `src/filters.test.ts` fails when the contract gains a filter the tool doesn't
expose.

- `q`, `search_description` (`false` = title-only), `location` (one or several places), `sources`
  (`source` is a 1.1 alias)
- `companies` — ids from `find_companies` (send every id of the company), domains or whole names
- `work_model`, `employment_type`, `experience_level`, `language` (ISO 639-1)
- `skills`, `industries`, `company_categories`, `job_categories`, `job_subcategories`, `occupation_ids`
- `exclude_` twins of `companies`, `skills`, `industries`, `company_categories`, `job_categories`,
  `job_subcategories`, `occupation_ids`
- `min_salary_usd`, `max_salary_usd`, `posted_after`/`posted_before`, `discovered_after`/`discovered_before`
- `sort` (`relevance`, `discovered_desc`, `discovered_asc`), `include_facets`, `page`, `page_size`

List filters take arrays; comma-separated strings also work, except for `companies` (a string is one
company — names contain commas). The tool POSTs to `/api/mcp/jobs/search`; the lookups call
`/api/mcp/companies/suggest`, `/api/mcp/filter-options/{facet}` and (for a named occupation)
`/api/mcp/occupations`, the OAuth twins of the connector endpoints and `GET /api/occupations` (those take an
API key, which this gateway never holds).

### What `fetch` returns

`text` is self-contained prose, because Deep Research reads it and never opens the URL. It is built from
the AI-extracted fields (responsibilities, qualifications, benefits, compensation) in preference to the
raw employer HTML, which is boilerplate-heavy and frequently longer than it is useful. The raw description
is available via `get_job_details` with `include_description: true`.

## Auth model

The server is a gateway, not the cryptographic authority. The C# External API validates the JWT with
OpenIddict against the same issuer, audience and `jobs:read` scope; verifying the signature a second time
here would only let the two validators drift. So this does the minimum a gateway must:

1. Require a Bearer token; absent → `401` with the resource-metadata challenge (naming the `jobs:read`
   scope), starting the OAuth flow. With `MCP_PUBLIC_DISCOVERY` on, discovery requests are the one
   exception — see below.
2. Cheaply reject an already-expired token (decode `exp`, no signature check) so long-lived clients
   refresh rather than forwarding a dead token.
3. Attach the raw current-request token to `req.auth`, so every tool call forwards the token the client
   just sent — never one captured at session-initialize.

## Discovery without a token

Two layers. Only the first is on by default.

**Server Card — always on.** `GET /mcp/server-card` returns the MCP Server Card
([SEP-2127](https://modelcontextprotocol.io/seps/2127-mcp-server-cards)): name, title, version,
description, icons, the endpoint URL and the protocol versions it answers. `GET /.well-known/ai-catalog.json`
points at it, for a client that knows only the host. Both are static, CORS-open and cacheable. The card
format has no tools in it and no auth fields: tools stay behind `tools/list`, and a client still learns
about OAuth from `/.well-known/oauth-protected-resource`. The card is built from the same constants as
`server/discover`, and a test fails when it drifts from `server.json`.

**In-protocol discovery — `MCP_PUBLIC_DISCOVERY=true`.** A request without a token is then answered when
it asks only for discovery: `server/discover`, `initialize`, `notifications/initialized`, `ping`,
`tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`. A registry, a directory or a
client can read every tool's schema before anyone signs in. `tools/call` is never on that list — it gets
the same `401` challenge as before, as a real HTTP status, because clients start sign-in from the status
and not from an error inside a `200`. A batch qualifies only if every message in it does, and a request
that does carry a token is checked as always.

It is off by default because it moves sign-in from connecting to the first tool call:

- The [2026-07-28 spec](https://modelcontextprotocol.io/specification/2026-07-28/changelog) does not ask
  for it. `server/discover` is mandatory to implement, but nothing says it is answered without a token,
  and the authorization section still expects one on every request. Tokenless `tools/list` is a
  convention some servers and SDKs have adopted, not a requirement.
- A client that starts OAuth from any `401` keeps working — Claude documents this as
  [lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication): it connects,
  lists tools, and asks for sign-in on the first call. A client that only looks for the `401` while
  connecting reports "connected" and then fails every call.
- Every tool here needs a token, so nothing becomes usable earlier, only visible earlier.

Turn it on when being readable by scanners matters more than signing in up front, and try the clients you
care about first. Each tool carries `securitySchemes: [{ type: "oauth2", scopes: ["jobs:read"] }]` in its
`_meta` either way, so a client that lists before sign-in knows every tool needs it.

## Stateless by design

No session map. That map lived in process memory, so every restart or redeploy stranded clients with
"No active session", and it pinned the deployment to a single replica. Redis cannot back it either: the
value is a live transport object holding open streams. Each POST is served by a fresh server and transport
with no `mcp-session-id` issued.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `JOBO_API_URL` | `https://connect.jobo.world` | Upstream External API. |
| `MCP_RESOURCE_URL` | `https://jobs-mcp.jobo.world` | OAuth audience. **Must differ from the analytics server's `mcp.jobo.world`.** |
| `OAUTH_AUTH_SERVER_URL` | `https://enterprise.jobo.world` | Authorization Server. |
| `PORT` | `3002` | Analytics server uses 3001. |
| `MCP_PUBLIC_DISCOVERY` | off | `true` answers the handshake and the list methods without a token. See [Discovery without a token](#discovery-without-a-token). |

## Development

```bash
npm install && npm run build && npm test
```

```bash
npm run dev
```

### Verifying without credentials

`node --test dist/format.test.js` covers the mapping logic, including that `search` and `fetch` return
exactly the shapes Deep Research requires. For the wire path, point the server at a stub:

```bash
JOBO_API_URL=http://localhost:3098 PORT=3097 MCP_RESOURCE_URL=http://localhost:3097 node dist/index.js
```

Then `tools/list` and `tools/call` over HTTP with any JWT-shaped bearer whose `exp` is in the future —
the gateway forwards it and the stub answers. A real token is only needed against the live API.

## Registry listing

Published to the official MCP Registry as **`world.jobo/job-search`** (the `mcpName` in `package.json`;
`server.json` in this directory is the registry manifest). Publishing is automated: the `mcp-v*` tag
workflow publishes npm first, then pushes `server.json` to the registry under the DNS-TXT-verified
`world.jobo/*` namespace — see `../RELEASING.md`. There is no review queue and aggregators poll roughly
hourly. Note the official registry has **no per-server web page** by design — it is a metadata API for
aggregators. The downstream surfaces differ: PulseMCP emits a dofollow link, Glama and mcp.so are
`nofollow`. Manual directory submissions (Claude, ChatGPT, aggregator claims) live in
`../MCP-DISTRIBUTION.md`.
