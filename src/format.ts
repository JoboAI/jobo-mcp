/**
 * Pure mapping between upstream DTOs and what MCP clients consume.
 *
 * Kept free of HTTP and SDK types so the contract that matters most — the
 * canonical `search`/`fetch` shapes ChatGPT Deep Research requires — is
 * directly testable.
 */

import { FACET_FILTER_PARAM, type FilterValueFacet } from "./filters.js";
import type {
  UpstreamCompanySuggestion,
  UpstreamFilterOption,
  UpstreamJobDetails,
  UpstreamJobSummary,
  UpstreamOccupation,
  UpstreamSearchResponse,
} from "./upstream.js";

/**
 * One `search` hit. ChatGPT Deep Research requires exactly this shape: `id`,
 * `title` and `url`, where `id` is what gets handed back to `fetch`.
 */
export interface SearchResult {
  id: string;
  title: string;
  url: string;
}

export interface SearchPayload {
  results: SearchResult[];
}

/**
 * One `fetch` document. `text` must be self-contained prose — Deep Research
 * reads it directly rather than following the URL.
 */
export interface FetchPayload {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata: Record<string, string>;
}

/** Render a location as a single human phrase. */
export function formatLocation(job: UpstreamJobSummary): string {
  const loc = job.location;
  if (!loc) return job.workplace_type === "Remote" ? "Remote" : "Location not stated";

  const parts = [loc.city, loc.region, loc.country].filter((p): p is string => Boolean(p && p.trim()));
  const place = parts.join(", ");

  if (loc.is_remote) return place ? `Remote (${place})` : "Remote";
  return place || "Location not stated";
}

/** Render compensation, or an empty string when the employer did not state it. */
export function formatCompensation(job: UpstreamJobSummary): string {
  const comp = job.compensation;
  if (!comp || (comp.min == null && comp.max == null)) return "";

  const currency = comp.currency ?? "";
  const period = comp.period ? ` per ${comp.period.replace(/ly$/, "")}` : "";
  const money = (n: number): string => n.toLocaleString("en-US");

  if (comp.min != null && comp.max != null) {
    return `${currency} ${money(comp.min)}–${money(comp.max)}${period}`.trim();
  }
  const single = comp.min ?? comp.max;
  const prefix = comp.min != null ? "from" : "up to";
  return `${prefix} ${currency} ${money(single as number)}${period}`.trim();
}

/** Render the occupation as "Registered Nurse (Healthcare › Nursing)", or empty when unclassified. */
export function formatOccupation(job: UpstreamJobSummary): string {
  const occ = job.occupation;
  if (!occ?.name) return "";

  const path = [occ.category, occ.subcategory].filter((p): p is string => Boolean(p && p.trim()));
  return path.length > 0 ? `${occ.name} (${path.join(" › ")})` : occ.name;
}

/**
 * A job's title line, used as the `title` for both search hits and fetched
 * documents. Company and location are folded in because Deep Research shows the
 * title alone in its source list — "Senior Engineer" on its own is useless.
 */
export function jobTitle(job: UpstreamJobSummary): string {
  return `${job.title} — ${job.company.name} (${formatLocation(job)})`;
}

export function toSearchPayload(response: UpstreamSearchResponse): SearchPayload {
  return {
    results: response.jobs.map((job) => ({
      id: job.id,
      title: jobTitle(job),
      url: job.listing_url || job.apply_url,
    })),
  };
}

/** Compact multi-job rendering for the rich `search_jobs` tool. */
export function renderSearchResults(response: UpstreamSearchResponse): string {
  // Notes explain an empty or narrowed result (e.g. a company name that matched
  // nothing) — without them a model reports "no such jobs" instead.
  const notes = response.notes?.length ? `Note: ${response.notes.join(" ")}\n\n` : "";
  if (response.jobs.length === 0) {
    return (
      notes +
      "No jobs matched those filters. Try relaxing one — `list_filters` shows the valid values and how many jobs each has."
    );
  }

  const lines = response.jobs.map((job, index) => {
    const bits: string[] = [`${index + 1}. ${job.title} — ${job.company.name}`];
    bits.push(`   ${formatLocation(job)}`);

    const facts = [job.employment_type, job.experience_level, formatCompensation(job)].filter(
      (f): f is string => Boolean(f),
    );
    if (facts.length > 0) bits.push(`   ${facts.join(" · ")}`);

    const occupation = formatOccupation(job);
    if (occupation) bits.push(`   Occupation: ${occupation}`);
    if (job.top_skills.length > 0) bits.push(`   Skills: ${job.top_skills.slice(0, 8).join(", ")}`);
    if (job.summary) bits.push(`   ${job.summary}`);
    bits.push(`   ${job.listing_url || job.apply_url}`);
    bits.push(`   id: ${job.id}`);

    return bits.join("\n");
  });

  const shown = response.jobs.length;
  const header =
    `${response.total.toLocaleString("en-US")} matching jobs; showing ${shown} ` +
    `(page ${response.page} of ${response.total_pages}).`;
  const footer = response.has_more
    ? `\n\nMore available — request page ${response.next_page ?? response.page + 1} for the next ${response.page_size}.`
    : "";

  return `${notes}${header}\n\n${lines.join("\n\n")}${footer}`;
}

/** `find_companies` output: one line per company with every id to filter on. */
export function renderCompanySuggestions(query: string, companies: UpstreamCompanySuggestion[]): string {
  if (companies.length === 0) {
    return (
      `No company matched "${query}". Lookups match the start of a company name or website domain ` +
      "(2+ characters) — try a shorter or different spelling, or the company's domain."
    );
  }

  const lines = companies.map((company, index) => {
    const facts = [company.domain, company.country].filter((f): f is string => Boolean(f));
    const jobs = company.job_count == null ? "" : ` · ${company.job_count.toLocaleString("en-US")} live jobs`;
    const ids = company.ids.length > 0 ? company.ids : [company.id];
    return (
      `${index + 1}. ${company.name}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}${jobs}\n` +
      `   companies: ${JSON.stringify(ids)}`
    );
  });

  return (
    `${companies.length} compan${companies.length === 1 ? "y" : "ies"} matching "${query}". To filter ` +
    "`search_jobs` to one, pass its whole `companies` list (one id per careers board).\n\n" +
    lines.join("\n")
  );
}

/** `find_filter_values` output for a named occupation: ids with their place in the taxonomy. */
export function renderOccupationMatches(query: string, occupations: UpstreamOccupation[]): string {
  if (occupations.length === 0) {
    return (
      `No occupation, subcategory or category name contains "${query}". Try a broader word ('nurse', ` +
      "'engineer'), or filter with job_categories / job_subcategories instead."
    );
  }
  const lines = occupations.map(
    (occupation) => `- ${occupation.id} — ${occupation.name} (${occupation.category} › ${occupation.subcategory})`,
  );
  return (
    `${occupations.length} occupation${occupations.length === 1 ? "" : "s"} matching "${query}", best first. ` +
    "Pass ids as `occupation_ids`; for a whole field, pass the category or subcategory name as " +
    "`job_categories` / `job_subcategories` instead.\n\n" +
    lines.join("\n")
  );
}

/** `find_filter_values` output: the value to pass, its display name and parent, and live jobs. */
export function renderFilterValues(
  facet: FilterValueFacet,
  query: string | undefined,
  options: UpstreamFilterOption[],
): string {
  const param = FACET_FILTER_PARAM[facet];
  if (options.length === 0) {
    return query
      ? `No ${facet} value starts with "${query}". Try a shorter prefix, or omit q for the most common values.`
      : `No ${facet} values are available right now.`;
  }

  const lines = options.map((option) => {
    const label = option.name && option.name !== option.key ? ` — ${option.name}` : "";
    const parent = option.parent ? ` (in ${option.parent})` : "";
    return `- ${option.key}${label}${parent}: ${option.count.toLocaleString("en-US")} jobs`;
  });

  const hint =
    facet === "occupations"
      ? "Pass the id (the value before the dash) as `occupation_ids`."
      : facet === "job_categories" || facet === "job_subcategories"
        ? `Pass the value (or its display name) as \`${param}\`.`
        : `Pass the value as \`${param}\`.`;

  return `${options.length} ${facet} value${options.length === 1 ? "" : "s"}${query ? ` matching "${query}"` : ""}. ${hint}\n\n${lines.join("\n")}`;
}

/**
 * Flatten a job into self-contained prose.
 *
 * Deep Research reads `text` and never opens the URL, so everything that would
 * justify citing this job has to be here. The AI-extracted fields
 * (responsibilities, qualifications, benefits) are preferred over the raw HTML
 * description, which is boilerplate-heavy and often longer than it is useful.
 */
export function renderJobDocument(details: UpstreamJobDetails): string {
  const job = details.summary;
  const sections: string[] = [];

  sections.push(`# ${job.title}`);
  sections.push(`**Company:** ${job.company.name}`);
  sections.push(`**Location:** ${formatLocation(job)}`);
  const occupation = formatOccupation(job);
  if (occupation) sections.push(`**Occupation:** ${occupation}`);

  const facts: string[] = [];
  if (job.employment_type) facts.push(`Employment: ${job.employment_type}`);
  if (job.experience_level) facts.push(`Level: ${job.experience_level}`);
  if (job.workplace_type) facts.push(`Work model: ${job.workplace_type}`);
  const pay = formatCompensation(job);
  if (pay) facts.push(`Compensation: ${pay}`);
  if (job.date_posted) facts.push(`Posted: ${job.date_posted.slice(0, 10)}`);
  if (details.valid_through) facts.push(`Closes: ${details.valid_through.slice(0, 10)}`);
  if (facts.length > 0) sections.push(facts.join("\n"));

  if (job.company.industries.length > 0) {
    sections.push(`**Industry:** ${job.company.industries.join(", ")}`);
  }
  if (job.company.summary) sections.push(`**About ${job.company.name}:** ${job.company.summary}`);
  if (job.summary) sections.push(`## Summary\n${job.summary}`);

  if (details.responsibilities.length > 0) {
    sections.push(`## Responsibilities\n${details.responsibilities.map((r) => `- ${r}`).join("\n")}`);
  }

  const renderQualifications = (
    label: string,
    group: UpstreamJobDetails["qualifications"]["must_have"],
  ): void => {
    if (!group) return;
    const items: string[] = [
      ...group.skills.map((s) => s.name),
      ...group.education,
      ...group.certifications,
    ].filter(Boolean);
    if (items.length > 0) sections.push(`## ${label}\n${items.map((i) => `- ${i}`).join("\n")}`);
  };
  renderQualifications("Required qualifications", details.qualifications.must_have);
  renderQualifications("Preferred qualifications", details.qualifications.preferred);

  if (details.benefits.length > 0) {
    sections.push(`## Benefits\n${details.benefits.map((b) => `- ${b}`).join("\n")}`);
  }

  const flagNotes: string[] = [];
  if (job.flags.is_h1b_sponsor === true) flagNotes.push("Employer has sponsored H-1B visas.");
  if (job.flags.is_work_auth_required === true) flagNotes.push("Existing work authorisation required.");
  if (job.flags.is_clearance_required === true) flagNotes.push("Security clearance required.");
  if (flagNotes.length > 0) sections.push(`## Eligibility\n${flagNotes.map((f) => `- ${f}`).join("\n")}`);

  if (details.all_locations.length > 1) {
    const places = details.all_locations
      .map((l) => l.location || [l.city, l.region, l.country].filter(Boolean).join(", "))
      .filter(Boolean);
    if (places.length > 0) sections.push(`## All locations\n${places.map((p) => `- ${p}`).join("\n")}`);
  }

  sections.push(`**Apply:** ${job.apply_url || job.listing_url}`);
  sections.push(`_Source: ${job.source}_`);

  return sections.join("\n\n");
}

export function toFetchPayload(details: UpstreamJobDetails): FetchPayload {
  const job = details.summary;

  // Metadata values must be strings — Deep Research renders them verbatim.
  const metadata: Record<string, string> = {
    company: job.company.name,
    source: job.source,
    location: formatLocation(job),
  };
  if (job.employment_type) metadata.employment_type = job.employment_type;
  if (job.experience_level) metadata.experience_level = job.experience_level;
  if (job.workplace_type) metadata.workplace_type = job.workplace_type;
  const occupation = formatOccupation(job);
  if (occupation) metadata.occupation = occupation;
  if (job.date_posted) metadata.date_posted = job.date_posted;
  const pay = formatCompensation(job);
  if (pay) metadata.compensation = pay;

  return {
    id: job.id,
    title: jobTitle(job),
    text: renderJobDocument(details),
    url: job.listing_url || job.apply_url,
    metadata,
  };
}
