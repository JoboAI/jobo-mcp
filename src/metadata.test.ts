import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";

// Its own file: the configuration is read once when `index.ts` loads, and the
// test runner gives every file a fresh process.
describe("the protected resource metadata", () => {
  let server: Server;
  let base: string;

  before(async () => {
    process.env.NODE_ENV = "test";
    delete process.env.OAUTH_AUTH_SERVER_URL;
    delete process.env.OAUTH_AUTH_SERVER_ISSUER;
    delete process.env.MCP_RESOURCE_URL;
    const { app } = await import("./index.js");
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  // The authorization server's metadata declares its issuer as
  // "https://enterprise.jobo.world/". RFC 8414 §3.3 has a client compare that
  // with the issuer it was pointed at, and mcp-remote 0.16 refused to sign in
  // while this document named it without the slash.
  it("names the authorization server by its exact issuer, trailing slash included", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { authorization_servers: string[] };
      assert.deepEqual(body.authorization_servers, ["https://enterprise.jobo.world/"]);
    }
  });
});
