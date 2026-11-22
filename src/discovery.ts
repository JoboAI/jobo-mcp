/**
 * What this server answers without an access token.
 *
 * Two things, both describing the server rather than serving its data:
 *
 *   1. Static discovery documents, always: the MCP Server Card (SEP-2127) and
 *      the AI Catalog that points at it.
 *   2. In-protocol discovery on `/mcp`, when `MCP_PUBLIC_DISCOVERY` is on: the
 *      handshake and the list methods, so a client, registry or directory can
 *      read the server's identity and its tool schemas before anyone signs in.
 *      `tools/call` is never in this set.
 *
 * Pure and dependency-free so the rules can be unit-tested without a socket.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  In-protocol discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON-RPC methods answered without a token. Everything here must return the
 * same thing to every caller: nothing on this list may read the caller's
 * account or reach the upstream API. Adding a per-user resource or prompt means
 * taking its list method off this list first.
 *
 * `prompts/list` and the two resource lists are here although the server
 * registers neither: clients that probe them regardless then get the same
 * "method not found" as a signed-in client, not a sign-in prompt.
 */
export const PUBLIC_DISCOVERY_METHODS: ReadonlySet<string> = new Set([
  "server/discover", // 2026-07-28: identity, capabilities, supported versions
  "initialize", // 2025-era handshake
  "notifications/initialized",
  "ping",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
]);

/**
 * Whether a parsed POST body asks only for discovery. A batch (2025-03-26
 * clients may still send one) qualifies only when every message in it does, so
 * a `tools/call` cannot ride along behind a `tools/list`.
 */
export function isPublicDiscoveryBody(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return false;
  return messages.every((message) => {
    if (typeof message !== "object" || message === null) return false;
    const method = (message as { method?: unknown }).method;
    return typeof method === "string" && PUBLIC_DISCOVERY_METHODS.has(method);
  });
}

/**
 * Whether an HTTP request to the MCP endpoint may proceed without a token.
 * Only a POST carries a JSON-RPC message; the stateless handler answers every
 * other verb with 405 for everyone, so there is nothing to protect there, and a
 * 401 on the GET a 2025-era client sends after `initialize` would start the
 * sign-in that public discovery exists to defer.
 */
export function isPublicDiscoveryRequest(httpMethod: string, body: unknown): boolean {
  return httpMethod.toUpperCase() !== "POST" || isPublicDiscoveryBody(body);
}

/**
 * `MCP_PUBLIC_DISCOVERY`: off unless explicitly switched on.
 *
 * Off by default because it moves sign-in. A client that gets a 401 on its
 * first request signs the user in while connecting; with discovery public it
 * connects and lists tools unauthenticated, and sign-in waits for the first
 * tool call's 401. Clients that start OAuth from any 401 handle that; one that
 * only looks for it while connecting reports "connected" and then fails every
 * call. Since every tool here needs a token, that is a trade to make on
 * purpose, per deployment.
 */
export function publicDiscoveryEnabled(value: string | undefined): boolean {
  return ["1", "true", "on", "yes"].includes((value ?? "").trim().toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Server Card + AI Catalog
// ─────────────────────────────────────────────────────────────────────────────

export const SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";
export const AI_CATALOG_MEDIA_TYPE = "application/ai-catalog+json";

export interface ServerCardIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
}

export interface ServerCardInput {
  /** Registry-style name, `namespace/name` — the card schema requires the slash. */
  name: string;
  title: string;
  version: string;
  /** At most 100 characters (card schema). */
  description: string;
  websiteUrl: string;
  repositoryUrl: string;
  icons: ServerCardIcon[];
  /** The Streamable HTTP endpoint, e.g. `https://jobs-mcp.jobo.world/mcp`. */
  endpointUrl: string;
  protocolVersions: readonly string[];
}

export interface ServerCard {
  $schema: string;
  name: string;
  version: string;
  description: string;
  title: string;
  websiteUrl: string;
  repository: { url: string; source: string };
  icons: ServerCardIcon[];
  remotes: { type: "streamable-http"; url: string; supportedProtocolVersions: string[] }[];
}

/**
 * The Server Card: who the server is and where to connect, for a client that
 * has not connected yet. The format deliberately carries no tools (those stay
 * behind `tools/list`) and no auth fields — a client learns about OAuth from
 * the protected-resource metadata, as before.
 */
export function buildServerCard(input: ServerCardInput): ServerCard {
  return {
    $schema: SERVER_CARD_SCHEMA,
    name: input.name,
    version: input.version,
    description: input.description,
    title: input.title,
    websiteUrl: input.websiteUrl,
    repository: { url: input.repositoryUrl, source: "github" },
    icons: input.icons,
    remotes: [
      {
        type: "streamable-http",
        url: input.endpointUrl,
        supportedProtocolVersions: [...input.protocolVersions],
      },
    ],
  };
}

/** Where a server's card lives: the reserved `/server-card` under its endpoint. */
export function serverCardUrl(endpointUrl: string): string {
  return `${endpointUrl}/server-card`;
}

/**
 * Whether an `If-None-Match` header names this ETag. Done by hand rather than
 * left to Express's freshness check: `fetch` adds `Cache-Control: no-cache` to
 * any request that sets `If-None-Match` itself, and Express then answers 200.
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}

export interface AiCatalog {
  specVersion: "1.0";
  entries: { identifier: string; type: string; url: string }[];
}

/**
 * The AI Catalog served at `/.well-known/ai-catalog.json`: how a client that
 * knows only the host finds the card. `identifier` follows the discovery doc's
 * one worked example (`com.example/weather` → `urn:air:example.com:mcp:weather`).
 */
export function buildAiCatalog(cardName: string, cardUrl: string): AiCatalog {
  const [namespace = "", name = ""] = cardName.split("/");
  const publisher = namespace.split(".").reverse().join(".");
  return {
    specVersion: "1.0",
    entries: [
      {
        identifier: `urn:air:${publisher}:mcp:${name}`,
        type: SERVER_CARD_MEDIA_TYPE,
        url: cardUrl,
      },
    ],
  };
}
