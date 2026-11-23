# Installing the Jobo Job Search MCP server (for AI agents)

This file is written for an agent that installs MCP servers on a user's behalf, such as Cline. Follow it
instead of building this repository: the server is hosted, so there is nothing to clone, compile or run.

## What to add

One remote server over Streamable HTTP:

| | |
| --- | --- |
| Name | `jobo-job-search` |
| URL | `https://jobs-mcp.jobo.world/mcp` |
| Transport | Streamable HTTP (`streamableHttp`) |
| Auth | OAuth 2.1 with dynamic client registration. No API key, no environment variables. |

For a client configured through a JSON settings file with an `mcpServers` map:

```json
{
  "mcpServers": {
    "jobo-job-search": {
      "type": "streamableHttp",
      "url": "https://jobs-mcp.jobo.world/mcp"
    }
  }
}
```

Keep any servers that are already in the file. Do not add `command`, `args`, `env` or `headers`: the
server needs none of them.

## Signing in

Do not ask the user for a key or a password. The server lists its tools without a token and answers the
first tool call with `401`, which starts the client's OAuth flow: a browser window opens, the user signs in
with their Jobo account (or creates one at https://enterprise.jobo.world) and approves read access.

## Checking it worked

1. The client shows `jobo-job-search` as connected with seven tools: `search`, `fetch`, `search_jobs`,
   `get_job_details`, `find_companies`, `find_filter_values`, `list_filters`.
2. Call `list_filters`. It takes no arguments and returns the filter vocabularies.

If the client cannot do OAuth for remote servers, stop and tell the user. Do not fall back to running
`npx jobo-job-search-mcp` locally: a local copy is still an OAuth resource server and needs the same
sign-in.

## Cost

`find_companies` and `find_filter_values` are free. Jobs returned by a search are billed to the user's
Jobo account per job, so do not run searches as part of installation.

Client-by-client setup guides: https://jobo.world/docs/connectors/mcp
