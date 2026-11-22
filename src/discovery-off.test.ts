import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { SERVER_CARD_MEDIA_TYPE } from "./discovery.js";

// The default deployment: MCP_PUBLIC_DISCOVERY unset. Its own file because the
// flag is read once when `index.ts` loads, and the test runner gives every file
// a fresh process.
describe("the MCP endpoint without a token, public discovery off (the default)", () => {
  let server: Server;
  let base: string;

  before(async () => {
    process.env.NODE_ENV = "test";
    delete process.env.MCP_PUBLIC_DISCOVERY;
    delete process.env.MCP_RESOURCE_URL;
    const { app } = await import("./index.js");
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  const post = (body: unknown) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    });

  it("challenges every request, so a client signs in while connecting", async () => {
    for (const res of [
      await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
      await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_filters", arguments: {} } }),
      await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } }),
    ]) {
      assert.equal(res.status, 401);
      const header = res.headers.get("www-authenticate") ?? "";
      assert.ok(header.includes("resource_metadata="), header);
      assert.ok(header.includes('scope="jobs:read"'), header);
    }
  });

  it("still serves the Server Card and the AI Catalog, which never need a token", async () => {
    const card = await fetch(`${base}/mcp/server-card`);
    assert.equal(card.status, 200);
    assert.ok((card.headers.get("content-type") ?? "").startsWith(SERVER_CARD_MEDIA_TYPE));
    assert.equal((await card.json()).remotes[0].url, "https://jobs-mcp.jobo.world/mcp");

    assert.equal((await fetch(`${base}/.well-known/ai-catalog.json`)).status, 200);
  });
});
