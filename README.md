# Jobo Job Search MCP Server

Remote MCP server exposing Jobo's live job index — millions of listings collected from employer career
sites and 100+ applicant tracking systems — to LLM clients.

Full client setup (Claude, ChatGPT, Cursor, Codex CLI) and the tool reference:
[jobo.world/docs/connectors/mcp](https://jobo.world/docs/connectors/mcp).

- **Transport:** Streamable HTTP, single `/mcp` endpoint (MCP spec 2025-06-18), stateless.
- **Auth:** OAuth 2.1. This is a Resource Server; the Authorization Server is the Jobo API. Clients log in
  with their Jobo account — no API key copy-paste. Required scope: `jobs:read`.

## Self-hosting

The hosted deployment is `https://jobs-mcp.jobo.world`. To run your own copy instead:

```bash
npx jobo-jobs-mcp
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
| `search_jobs` | Structured search — location, work model, employment type, experience level, source, skills, industries, salary, date, facets, paging. |
| `get_job_details` | Full listing for clients not using the Deep Research contract. |
| `list_filters` | Accepted values for every filter, with live counts. |

`search`/`fetch` deliberately take the minimum arguments the contract allows. Anything with structure
should go through `search_jobs`, where filters are real parameters rather than hopeful free text.

### What `fetch` returns

`text` is self-contained prose, because Deep Research reads it and never opens the URL. It is built from
the AI-extracted fields (responsibilities, qualifications, benefits, compensation) in preference to the
raw employer HTML, which is boilerplate-heavy and frequently longer than it is useful. The raw description
is available via `get_job_details` with `include_description: true`.

## Auth model

The server is a gateway, not the cryptographic authority. The C# External API validates the JWT with
OpenIddict against the same issuer, audience and `jobs:read` scope; verifying the signature a second time
here would only let the two validators drift. So this does the minimum a gateway must:

1. Require a Bearer token; absent → `401` with the resource-metadata challenge, starting the OAuth flow.
2. Cheaply reject an already-expired token (decode `exp`, no signature check) so long-lived clients
   refresh rather than forwarding a dead token.
3. Attach the raw current-request token to `req.auth`, so every tool call forwards the token the client
   just sent — never one captured at session-initialize.

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

Publish once to the official MCP Registry with a DNS-TXT-verified `world.jobo/*` namespace; there is no
review queue and aggregators poll it roughly hourly. Note the official registry has **no per-server web
page** by design — it is a metadata API for aggregators. The downstream surfaces differ: PulseMCP emits a
dofollow link, Glama and mcp.so are `nofollow`.
