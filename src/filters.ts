/**
 * Canonical filter enum values for the /api/mcp surface.
 *
 * Source of truth is Jobo.Connectors/packages/connector-core/src/filters.ts —
 * duplicated locally because this package intentionally has no dependency on
 * connector-core (it is standalone, with its own lockfile consumed by the
 * Dockerfile); a repo-level drift guard compares the two.
 *
 * Tool input descriptions are built from these arrays, so the schema prose can
 * never drift from the values the upstream actually accepts.
 */

export const WORK_MODELS = ["remote", "hybrid", "onsite"] as const;

export const EMPLOYMENT_TYPES = [
  "full-time",
  "part-time",
  "contract",
  "internship",
  "freelance",
  "temporary",
] as const;

export const EXPERIENCE_LEVELS = ["intern", "entry", "mid", "senior", "lead", "executive"] as const;
