import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Local mode end to end: the built server started with `--stdio`, driven over
// its stdin and stdout the way a client or a directory's build check drives it,
// with a local HTTP server standing in for the public API.

const entry = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const KEY = "jbe_live_stdio_mode_test_key";

interface Reply {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** One server process and the JSON-RPC conversation with it. */
class Session {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly waiting = new Map<number, (reply: Reply) => void>();
  private nextId = 1;
  /** Every line the server wrote to stdout, to prove none of it is chatter. */
  readonly stdoutLines: string[] = [];
  stderr = "";

  constructor(env: Record<string, string | undefined>) {
    this.child = spawn(process.execPath, [entry, "--stdio"], {
      env: { ...process.env, NODE_ENV: "production", JOBO_API_KEY: undefined, ...env } as NodeJS.ProcessEnv,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        this.stdoutLines.push(line);
        const reply = JSON.parse(line) as Reply;
        if (reply.id !== undefined) this.waiting.get(reply.id)?.(reply);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => (this.stderr += chunk));
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method}; stderr: ${this.stderr}`)), 20_000);
      this.waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async open(): Promise<Reply> {
    const reply = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-test", version: "0" },
    });
    this.notify("notifications/initialized");
    return reply;
  }

  close(): void {
    this.child.kill();
  }
}

const textOf = (reply: Reply): string =>
  ((reply.result?.content as Array<{ text: string }> | undefined) ?? []).map((part) => part.text).join("\n");

describe("local mode over stdio", () => {
  let api: Server;
  let apiUrl: string;
  let seen: Array<{ method: string; path: string; headers: IncomingMessage["headers"] }> = [];
  const sessions: Session[] = [];

  const start = (env: Record<string, string | undefined>): Session => {
    const session = new Session({ JOBO_API_URL: apiUrl, ...env });
    sessions.push(session);
    return session;
  };

  before(async () => {
    api = createServer((req, res) => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers });
      req.resume();
      req.on("end", () => {
        if (req.headers["x-api-key"] !== KEY) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid or expired API key" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            enums: { work_models: ["remote", "hybrid", "on-site"], employment_types: ["full-time"], experience_levels: ["senior"] },
            sources: [{ key: "greenhouse", count: 120 }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  after(() => {
    for (const session of sessions) session.close();
    api.close();
  });

  it("starts without a key and lists every tool, which is all a directory's build check needs", async () => {
    const session = start({});

    const opened = await session.open();
    const listed = await session.request("tools/list");

    assert.equal((opened.result?.serverInfo as { name: string }).name, "jobo-job-search");
    const tools = listed.result?.tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["fetch", "find_companies", "find_filter_values", "get_job_details", "list_filters", "search", "search_jobs"],
    );
    // OAuth is how the hosted server signs people in. Here it is a key.
    for (const tool of tools) {
      assert.equal(tool._meta?.securitySchemes, undefined, `${tool.name} must not claim OAuth in local mode`);
    }
  });

  it("answers a tool call without a key by saying which variable to set, and calls nothing", async () => {
    seen = [];
    const session = start({});
    await session.open();

    const reply = await session.request("tools/call", { name: "list_filters", arguments: {} });

    assert.equal(reply.result?.isError, true);
    assert.match(textOf(reply), /JOBO_API_KEY/);
    assert.match(textOf(reply), /enterprise\.jobo\.world\/api-keys/);
    assert.equal(seen.length, 0, "no request is made without a key");
  });

  it("calls the public API with the key and returns the tool's usual text", async () => {
    seen = [];
    const session = start({ JOBO_API_KEY: KEY });
    await session.open();

    const reply = await session.request("tools/call", { name: "list_filters", arguments: {} });

    assert.notEqual(reply.result?.isError, true, textOf(reply));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, "/api/connectors/filters");
    assert.equal(seen[0].headers["x-api-key"], KEY);
    assert.equal(seen[0].headers.authorization, undefined);
    assert.match(textOf(reply), /\*\*work_model:\*\* remote, hybrid, on-site/);
    assert.match(textOf(reply), /\*\*sources:\*\* greenhouse/);
    assert.doesNotMatch(textOf(reply), /active jobs indexed/, "the index total is not known in local mode");
  });

  it("explains a rejected key in terms of the key, not of signing in again", async () => {
    const session = start({ JOBO_API_KEY: "jbe_live_some_other_key_entirely" });
    await session.open();

    const reply = await session.request("tools/call", { name: "list_filters", arguments: {} });

    assert.equal(reply.result?.isError, true);
    assert.match(textOf(reply), /rejected the API key/);
    assert.doesNotMatch(textOf(reply), /Re-authenticate/);
  });

  it("writes nothing to stdout but protocol messages", async () => {
    const session = start({ JOBO_API_KEY: KEY });
    await session.open();
    await session.request("tools/list");

    for (const line of session.stdoutLines) {
      assert.equal((JSON.parse(line) as { jsonrpc?: string }).jsonrpc, "2.0", `not a protocol message: ${line.slice(0, 80)}`);
    }
    assert.match(session.stderr, /on stdio/, "the start-up line goes to stderr");
  });
});
