import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The package root, from dist/ at run time. These files are not in the npm
// tarball (`files` lists dist, README, LICENSE); they ship through the public
// mirror, where directory crawlers read them from the repository root.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));

describe("the Gemini CLI extension manifest", () => {
  const pkg = readJson("package.json");
  const server = readJson("server.json");
  const extension = readJson("gemini-extension.json");

  it("carries the package's version, so a release bumps one number everywhere", () => {
    assert.equal(extension.version, pkg.version);
  });

  it("points at the hosted endpoint the MCP Registry entry advertises", () => {
    const servers = Object.values(extension.mcpServers) as Array<{ httpUrl?: string }>;
    assert.equal(servers.length, 1);
    assert.equal(servers[0].httpUrl, server.remotes[0].url);
  });

  it("has a name Gemini CLI accepts: lowercase letters, digits and dashes", () => {
    assert.match(extension.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("names a context file that exists", () => {
    assert.ok(readFileSync(join(root, extension.contextFileName), "utf8").length > 0);
  });
});

// Agent Plugins (open-plugins.com): `plugin.json` plus `mcp.json` at the
// repository root is what plugin directories scan for.
describe("the Agent Plugins manifest", () => {
  const pkg = readJson("package.json");
  const server = readJson("server.json");
  const plugin = readJson("plugin.json");
  const mcp = readJson("mcp.json");

  it("carries the package's version", () => {
    assert.equal(plugin.version, pkg.version);
  });

  it("has a name the standard accepts", () => {
    assert.match(plugin.name, /^[a-z0-9]+([-.][a-z0-9]+)*$/);
    assert.ok(plugin.name.length <= 64);
  });

  it("declares the hosted endpoint as Streamable HTTP, with no headers", () => {
    const entries = Object.values(mcp.mcpServers) as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { type: "streamable-http", url: server.remotes[0].url });
  });
});
