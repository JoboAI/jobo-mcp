# Changelog

## 1.4.0

Local mode: run the server yourself over stdio and sign in with an API key.

### Added

- **`--stdio`** serves MCP over stdin and stdout instead of HTTP, for clients that start a server as a
  child process and for directories that build and inspect one. `npx jobo-job-search-mcp --stdio`.
- **API-key sign-in in local mode.** Set `JOBO_API_KEY`. There is no browser sign-in: the caller is the
  account that owns the key. The same seven tools answer from the public REST API (`POST /api/jobs/search`,
  `GET /api/jobs/{id}`, `/api/connectors/*`, `/api/occupations`) and return what they return on the hosted
  server, so a key meets the limits, billing and logging it meets everywhere else. Searches are billed per
  job returned; `get_job_details`, `fetch` and the lookups are free.
- The tool list is readable without a key. A tool call without one says which variable to set.
- `server.json` lists the stdio way of running the package next to the HTTP one.

### Changed

- In local mode `list_filters` does not report how many jobs are indexed: the public API has no free count
  of the whole index, and a search to get one would be billed.
- In local mode the tools do not declare OAuth (`securitySchemes`), and a rejected key is explained as a
  rejected key.

### Fixed

- `get_job_details` with `include_description: true` never returned the description: the flag was not sent
  to the API. It is now.

### Security

- The lockfile moves to patched releases of the MCP SDK (`@modelcontextprotocol/server` 2.4.0,
  `@modelcontextprotocol/node` 2.1.2), `zod` 4.6.7, `express` 4.22.3, `hono` 4.13.21, `body-parser` 1.20.9,
  `qs` 6.16.2 and `proxy-addr` 2.0.8. `npm audit` reports nothing. The image and any build from this
  repository use the lockfile; an `npx` install already resolved the newest versions in range.

## 1.3.0

Discovery without a token: what a client, registry or directory can learn about the server before
anyone signs in.

### Added

- **Server Card** (MCP SEP-2127) at `GET /mcp/server-card`: the server's identity, endpoint URL and
  supported protocol versions, as `application/mcp-server-card+json`. Public, CORS-open, cacheable
  (`ETag`, `304` on `If-None-Match`). It carries no tools — the card format leaves those to `tools/list`.
- **AI Catalog** at `GET /.well-known/ai-catalog.json`, pointing at the card, so a client that knows only
  the host can find it.
- **`MCP_PUBLIC_DISCOVERY`** (off by default). Set to `true` and the handshake (`server/discover`,
  `initialize`, `notifications/initialized`, `ping`) and the list methods (`tools/list`, `prompts/list`,
  `resources/list`, `resources/templates/list`) are answered without a token, so the tool schemas are
  readable before sign-in. `tools/call` always needs a token. This moves sign-in from connecting to the
  first tool call — see "Discovery without a token" in the README before turning it on.
- Every tool declares `securitySchemes: [{ type: "oauth2", scopes: ["jobs:read"] }]` in its `_meta`, so a
  client that lists tools before sign-in knows each one needs it.
- `tools/list` and `server/discover` results carry `cacheScope: "public"` and a 5-minute `ttlMs`
  (2026-07-28 clients only): the catalogue is the same for every caller.

### Changed

- The `401` challenge names the scope: `WWW-Authenticate: Bearer …, scope="jobs:read"`.
- `serverInfo.description` is now the registry's one-line description, so `server/discover`, the Server
  Card and `server.json` say the same thing.

## 1.2.0

Brings `search_jobs` up to the full job-search filter set shared by every Jobo connector
(`@jobo-ai/connector-core` 0.4.0), and adds lookups so an assistant can turn names into filter values.

### Added

- **`search_jobs` filters:** `companies`, `language`, `company_categories`, `job_categories`,
  `job_subcategories`, `occupation_ids`, `discovered_after` / `discovered_before`, `search_description`
  (`false` = title-only matching) and `sort` (`relevance`, `discovered_desc`, `discovered_asc`).
  `companies`, `skills`, `industries`, `company_categories`, `job_categories`, `job_subcategories` and
  `occupation_ids` each have an `exclude_` twin. `location` also takes several places.
- **`find_companies`:** company name or domain prefix → each company's ids, domain, HQ country and live job
  count. Pass every id of a company as `companies`; one company can have several careers boards.
- **`find_filter_values`:** values of one open-vocabulary filter (occupations, job categories and
  subcategories, skills, industries, company categories, ATS sources), with live job counts, optionally by
  prefix. For occupations, `q` searches role, subcategory and category names, so "nurse" finds the
  `occupation_ids` value for Registered Nurse.
- `list_filters` also lists company categories, languages and sort orders.
- `search_jobs` shows the API's notes (for example, a company name that matched nothing) above the results.

### Changed

- List filters take arrays. Comma-separated strings, as 1.1 took, still work — except for `companies`,
  where a string is one company, since company names contain commas.
- `source` is now `sources`; `source` keeps working as an alias.
- `search_jobs` calls `POST /api/mcp/jobs/search` with a typed body instead of the GET query string.
- Enum vocabularies come from `@jobo-ai/connector-core` (pinned `0.4.0`); a test fails when the shared
  contract gains a filter `search_jobs` does not expose.

### Requires

- The External API release that adds the new `McpJobSearchRequest` fields and
  `GET /api/mcp/companies/suggest`, `GET /api/mcp/filter-options/{facet}` and `GET /api/mcp/occupations`.
  Against an older API the new filters are silently ignored and the lookup tools return 404, so deploy the
  API first.

## 1.1.0

- MCP SDK v2: serves spec 2026-07-28 natively and 2025-era clients through the stateless legacy fallback.
- Published to the official MCP Registry as `world.jobo/job-search`.
