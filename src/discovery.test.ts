import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";

import {
  AI_CATALOG_MEDIA_TYPE,
  PUBLIC_DISCOVERY_METHODS,
  SERVER_CARD_MEDIA_TYPE,
  SERVER_CARD_SCHEMA,
  buildAiCatalog,
  etagMatches,
  isPublicDiscoveryBody,
  isPublicDiscoveryRequest,
  publicDiscoveryEnabled,
} from "./discovery.js";

// ─────────────────────────────────────────────────────────────────────────────
//  The rules
// ─────────────────────────────────────────────────────────────────────────────

const rpc = (method: string, id: number | null = 1) =>
  id === null ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", id, method };

describe("isPublicDiscoveryBody", () => {
  it("lets the handshake and the list methods through", () => {
    for (const method of ["server/discover", "initialize", "notifications/initialized", "ping", "tools/list"]) {
      assert.equal(isPublicDiscoveryBody(rpc(method)), true, method);
    }
  });

  it("never lets a tool call through", () => {
    assert.equal(PUBLIC_DISCOVERY_METHODS.has("tools/call"), false);
    assert.equal(isPublicDiscoveryBody(rpc("tools/call")), false);
  });

  it("rejects anything that is not a discovery request", () => {
    for (const method of ["resources/read", "prompts/get", "subscriptions/listen", "notifications/cancelled", "nope"]) {
      assert.equal(isPublicDiscoveryBody(rpc(method)), false, method);
    }
    for (const body of [undefined, null, "", "tools/list", 42, {}, { method: 7 }, { jsonrpc: "2.0", id: 1, result: {} }]) {
      assert.equal(isPublicDiscoveryBody(body), false, JSON.stringify(body));
    }
  });

  it("takes a batch only when every message in it is discovery", () => {
    assert.equal(isPublicDiscoveryBody([rpc("initialize"), rpc("tools/list", 2)]), true);
    assert.equal(isPublicDiscoveryBody([rpc("tools/list"), rpc("tools/call", 2)]), false);
    assert.equal(isPublicDiscoveryBody([]), false);
  });
});

describe("isPublicDiscoveryRequest", () => {
  it("judges a POST by its body and passes every other verb", () => {
    assert.equal(isPublicDiscoveryRequest("POST", rpc("tools/list")), true);
    assert.equal(isPublicDiscoveryRequest("POST", rpc("tools/call")), false);
    assert.equal(isPublicDiscoveryRequest("post", rpc("tools/call")), false);
    assert.equal(isPublicDiscoveryRequest("GET", undefined), true);
    assert.equal(isPublicDiscoveryRequest("DELETE", undefined), true);
  });
});

describe("publicDiscoveryEnabled", () => {
  it("is off unless switched on", () => {
    for (const value of [undefined, "", "false", "0", "off", "anything"]) {
      assert.equal(publicDiscoveryEnabled(value), false, String(value));
    }
    for (const value of ["true", "TRUE", " 1 ", "on", "yes"]) {
      assert.equal(publicDiscoveryEnabled(value), true, value);
    }
  });
});

describe("etagMatches", () => {
  it("matches the tag in any of the forms a client may send", () => {
    assert.equal(etagMatches('"abc"', '"abc"'), true);
    assert.equal(etagMatches('W/"abc"', '"abc"'), true);
    assert.equal(etagMatches('"old", "abc"', '"abc"'), true);
    assert.equal(etagMatches("*", '"abc"'), true);
    assert.equal(etagMatches('"old"', '"abc"'), false);
    assert.equal(etagMatches(undefined, '"abc"'), false);
  });
});

describe("buildAiCatalog", () => {
  it("derives the URN from the registry name", () => {
    assert.deepEqual(buildAiCatalog("com.example/weather", "https://example.com/mcp/server-card"), {
      specVersion: "1.0",
      entries: [
        {
          identifier: "urn:air:example.com:mcp:weather",
          type: SERVER_CARD_MEDIA_TYPE,
          url: "https://example.com/mcp/server-card",
        },
      ],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  The wire — the real app, on a real socket, with no upstream API behind it.
//  Nothing here needs one: that is the property under test.
// ─────────────────────────────────────────────────────────────────────────────

const MODERN = "2026-07-28";

describe("the MCP endpoint without a token, public discovery on", () => {
  let server: Server;
  let base: string;

  before(async () => {
    process.env.NODE_ENV = "test"; // `index.ts` only listens outside tests
    process.env.MCP_PUBLIC_DISCOVERY = "true"; // read once, when `index.ts` loads
    delete process.env.MCP_RESOURCE_URL;
    const { app } = await import("./index.js");
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  /** A JSON-RPC response arrives as JSON or as a one-message SSE stream. */
  async function rpcResult(res: Response): Promise<any> {
    const text = await res.text();
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const data = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .filter(Boolean);
      return JSON.parse(data[data.length - 1]!);
    }
    return JSON.parse(text);
  }

  /** A 2025-era request: no envelope, no protocol headers. */
  function legacy(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  }

  /** A 2026-07-28 request: the version travels in the envelope and the headers. */
  function modern(method: string, params: Record<string, unknown> = {}, name?: string): Promise<Response> {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN,
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientInfo": { name: "discovery-test", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  }

  it("answers server/discover", async () => {
    const res = await modern("server/discover");
    assert.equal(res.status, 200);
    const { result } = await rpcResult(res);
    assert.ok(result.supportedVersions.includes(MODERN));
    assert.equal(result.cacheScope, "public");
    assert.ok(result.capabilities.tools, "the server must advertise its tools capability");
  });

  it("answers tools/list with every tool's schema, each marked as needing OAuth", async () => {
    const res = await modern("tools/list");
    assert.equal(res.status, 200);
    const { result } = await rpcResult(res);
    assert.deepEqual(
      result.tools.map((tool: { name: string }) => tool.name).sort(),
      ["fetch", "find_companies", "find_filter_values", "get_job_details", "list_filters", "search", "search_jobs"],
    );
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.deepEqual(tool._meta.securitySchemes, [{ type: "oauth2", scopes: ["jobs:read"] }], tool.name);
    }
    assert.equal(result.cacheScope, "public");
    assert.ok(result.ttlMs > 0);
  });

  it("answers the 2025-era handshake and tools/list", async () => {
    const init = await legacy({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "discovery-test", version: "0.0.0" } },
    });
    assert.equal(init.status, 200);
    assert.equal((await rpcResult(init)).result.serverInfo.name, "jobo-job-search");

    const initialized = await legacy({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(initialized.status, 202);

    const list = await legacy({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(list.status, 200);
    assert.equal((await rpcResult(list)).result.tools.length, 7);
  });

  it("answers the 2025-era GET with the stateless 405, not a sign-in challenge", async () => {
    const res = await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } });
    assert.equal(res.status, 405);
  });

  it("answers a tool call with a real 401 and the challenge that starts sign-in", async () => {
    for (const res of [
      await modern("tools/call", { name: "search", arguments: { query: "nurse" } }, "search"),
      await legacy({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "nurse" } } }),
    ]) {
      assert.equal(res.status, 401);
      const header = res.headers.get("www-authenticate") ?? "";
      assert.ok(header.startsWith("Bearer "), header);
      assert.ok(
        header.includes('resource_metadata="https://jobs-mcp.jobo.world/.well-known/oauth-protected-resource"'),
        header,
      );
      assert.ok(header.includes('scope="jobs:read"'), header);
    }
  });

  it("does not let a tool call ride in a batch behind a list", async () => {
    const res = await legacy([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_filters", arguments: {} } },
    ]);
    assert.equal(res.status, 401);
  });

  it("still rejects an expired token, even for discovery", async () => {
    const expired = `x.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.x`;
    const res = await legacy({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: `Bearer ${expired}` });
    assert.equal(res.status, 401);
    assert.ok((res.headers.get("www-authenticate") ?? "").includes('error="invalid_token"'));
  });

  // ── Server Card + AI Catalog ───────────────────────────────────────────────

  const manifest = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));

  it("serves the Server Card under the endpoint, publicly cacheable and CORS-open", async () => {
    const res = await fetch(`${base}/mcp/server-card`, { headers: { accept: SERVER_CARD_MEDIA_TYPE } });
    assert.equal(res.status, 200);
    assert.ok((res.headers.get("content-type") ?? "").startsWith(SERVER_CARD_MEDIA_TYPE));
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("access-control-expose-headers"), "ETag");
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    const etag = res.headers.get("etag");
    assert.ok(etag, "the card must carry an ETag");

    const card = await res.json();
    assert.equal(card.$schema, SERVER_CARD_SCHEMA);
    assert.match(card.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    assert.ok(card.description.length >= 1 && card.description.length <= 100, "card description is 1–100 chars");
    assert.ok(card.title.length >= 1 && card.title.length <= 100);

    const unchanged = await fetch(`${base}/mcp/server-card`, { headers: { "if-none-match": etag! } });
    assert.equal(unchanged.status, 304);

    const preflight = await fetch(`${base}/mcp/server-card`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET");
  });

  it("keeps the card in step with the registry manifest and with server/discover", async () => {
    const card = await (await fetch(`${base}/mcp/server-card`)).json();
    assert.equal(card.name, manifest.name);
    assert.equal(card.title, manifest.title);
    assert.equal(card.description, manifest.description);
    assert.equal(card.version, manifest.version);
    assert.equal(card.websiteUrl, manifest.websiteUrl);
    assert.deepEqual(card.repository, manifest.repository);
    assert.deepEqual(card.icons, manifest.icons);
    assert.equal(card.remotes.length, 1);
    assert.equal(card.remotes[0].type, manifest.remotes[0].type);
    assert.equal(card.remotes[0].url, manifest.remotes[0].url);

    // A card should not contradict the live answer.
    const { result } = await rpcResult(await modern("server/discover"));
    const info = result._meta["io.modelcontextprotocol/serverInfo"];
    assert.equal(card.version, info.version);
    assert.equal(card.title, info.title);
    assert.equal(card.description, info.description);
    for (const version of result.supportedVersions) {
      assert.ok(card.remotes[0].supportedProtocolVersions.includes(version), `card is missing ${version}`);
    }
  });

  it("serves the AI Catalog pointing at the card", async () => {
    const res = await fetch(`${base}/.well-known/ai-catalog.json`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get("content-type") ?? "").startsWith(AI_CATALOG_MEDIA_TYPE));
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await res.json(), {
      specVersion: "1.0",
      entries: [
        {
          identifier: "urn:air:jobo.world:mcp:job-search",
          type: SERVER_CARD_MEDIA_TYPE,
          url: "https://jobs-mcp.jobo.world/mcp/server-card",
        },
      ],
    });
  });
});
