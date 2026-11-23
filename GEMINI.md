# Jobo Job Search

This extension connects Gemini CLI to Jobo's hosted MCP server, `https://jobs-mcp.jobo.world/mcp`: a live
index of open jobs collected from employer career sites and 200+ applicant tracking systems.

## Signing in

The server uses OAuth. The first tool call opens a browser window where the user signs in with their Jobo
account; there is no API key to paste. If a call answers that authentication is required, tell the user
to run `/mcp auth jobo-job-search`.

## Tools

All seven tools only read data.

| Tool | Use it for |
| --- | --- |
| `search_jobs` | A search with real filters: location, company, occupation, salary floor, seniority, work model, language or a specific ATS. Prefer it whenever the request has structure. |
| `search` | A quick lookup by free text. |
| `fetch` | One job in full, the counterpart of `search`. |
| `get_job_details` | The full listing for one job id, including the description. |
| `find_companies` | Turns a company name into its ids. Free. |
| `find_filter_values` | Occupations, job categories and subcategories, skills, industries and ATS sources, with live job counts. Free. |
| `list_filters` | The fixed vocabularies `search_jobs` accepts: work models, employment types, experience levels, company categories, languages, sort orders, ATS sources. |

## How to use them well

- Resolve names before searching. `find_companies` can return several ids for one company, one per
  careers board: pass every id it returns. `find_filter_values` gives the exact value a filter takes.
- Values are canonical and lowercase (`remote`, `full-time`, `senior`). Use them verbatim; a guessed
  value matches nothing.
- Jobs returned by a search are billed to the user's Jobo account per job, so ask for a small page first
  and fetch more only when the user wants more.
- Every result carries a listing URL and an apply URL. Cite the listing URL.
- Never invent a job, a company or a salary that did not come back from a tool call. When a search
  returns nothing, say so and suggest a wider filter.

Documentation: https://jobo.world/docs/connectors/mcp
