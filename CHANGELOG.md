# Changelog

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
