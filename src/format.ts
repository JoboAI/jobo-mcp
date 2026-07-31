/**
 * Pure mapping between upstream DTOs and what MCP clients consume.
 *
 * Kept free of HTTP and SDK types so the contract that matters most — the
 * canonical `search`/`fetch` shapes ChatGPT Deep Research requires — is
 * directly testable.
 */

import type { UpstreamJobDetails, UpstreamJobSummary, UpstreamSearchResponse } from "./upstream.js";

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
  if (response.jobs.length === 0) {
    return "No jobs matched those filters. Try relaxing one — `list_filters` shows the valid values and how many jobs each has.";
  }

  const lines = response.jobs.map((job, index) => {
    const bits: string[] = [`${index + 1}. ${job.title} — ${job.company.name}`];
    bits.push(`   ${formatLocation(job)}`);

    const facts = [job.employment_type, job.experience_level, formatCompensation(job)].filter(
      (f): f is string => Boolean(f),
    );
    if (facts.length > 0) bits.push(`   ${facts.join(" · ")}`);

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

  return `${header}\n\n${lines.join("\n\n")}${footer}`;
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
