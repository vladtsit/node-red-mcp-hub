import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { connect } from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../src/config.js";
import { createGateway } from "../src/index.js";
import { NodeRedClient, UpstreamError } from "../src/node-red.js";

async function start(server: ReturnType<typeof createServer>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function mcp(base: string, secret: string) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/private_${secret}`)));
  return client;
}

async function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    socket.setEncoding("utf8");
    let response = "";
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

test("malformed request targets return 400 without crashing the gateway", async (t) => {
  const gateway = await start(createGateway(parseConfig({
    mcp_path_secret: "e".repeat(64), read_only: true,
    servers: [{ id: "target", name: "Target", url: "http://127.0.0.1:1", auth_mode: "none", read_only: false }],
  })));
  t.after(gateway.close);
  const port = Number(new URL(gateway.url).port);
  const response = await rawRequest(port, "GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.equal((await fetch(`${gateway.url}/healthz`)).status, 200);
});

test("actual MCP client initializes, discovers, and routes simultaneous target reads", async (t) => {
  const targets = await Promise.all(["one", "two"].map(async (label) => start(createServer((request, response) => {
    if (request.url === "/admin/flows") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ rev: label, flows: [
        { id: `${label}-tab`, type: "tab", label: `Flow ${label}` },
        { id: label, type: "inject", name: `Hello ${label}`, z: `${label}-tab`, payload: "not returned by summaries" },
      ] }));
      return;
    }
    if (request.url === "/admin/settings") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: `4.0.${label === "one" ? 1 : 2}` }));
      return;
    }
    response.writeHead(404).end();
  }))));
  t.after(async () => { await Promise.all(targets.map((target) => target.close())); });
  const secret = "b".repeat(64);
  const gateway = await start(createGateway(parseConfig({
    mcp_path_secret: secret, read_only: true,
    servers: targets.map((target, index) => ({ id: index ? "two" : "one", name: `Target ${index + 1}`, url: `${target.url}/admin`, auth_mode: "none", read_only: false })),
  })));
  t.after(gateway.close);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["check_servers", "get_diagnostics", "get_flow", "get_flow_state", "get_flows", "get_installed_modules", "get_settings", "list_flows", "list_servers", "search_nodes"]);
  assert.ok(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations.openWorldHint === true));
  const checks = await client.callTool({ name: "check_servers", arguments: {} });
  assert.match((checks.content as { text: string }[])[0].text, /"ok":true/);
  assert.match((checks.content as { text: string }[])[0].text, /"version":"4\.0\.1"/);
  const [one, two] = await Promise.all(["one", "two"].map((server_id) => client.callTool({ name: "get_flows", arguments: { server_id } })));
  assert.match((one.content as { text: string }[])[0].text, /"one"/);
  assert.match((two.content as { text: string }[])[0].text, /"two"/);
  assert.ok(one.structuredContent && "data" in (one.structuredContent as Record<string, unknown>));
  const summaries = await client.callTool({ name: "list_flows", arguments: { server_id: "one" } });
  assert.match((summaries.content as { text: string }[])[0].text, /"node_count":1/);
  assert.doesNotMatch((summaries.content as { text: string }[])[0].text, /not returned by summaries/);
  const search = await client.callTool({ name: "search_nodes", arguments: { server_id: "one", query: "hello" } });
  assert.match((search.content as { text: string }[])[0].text, /"flow_label":"Flow one"/);
  assert.doesNotMatch((search.content as { text: string }[])[0].text, /not returned by summaries/);
});

test("global tool policy hides tools and target policy blocks calls", async (t) => {
  const secret = "a".repeat(64);
  const gateway = await start(createGateway(parseConfig({
    mcp_path_secret: secret, read_only: true, disabled_tools: "get_diagnostics",
    servers: [{ id: "target", name: "Target", url: "http://127.0.0.1:1", auth_mode: "none", read_only: true, disabled_tools: "get_flows" }],
  })));
  t.after(gateway.close);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "get_diagnostics"), false);
  assert.equal(tools.tools.some((tool) => tool.name === "get_flows"), true);
  const blocked = await client.callTool({ name: "get_flows", arguments: { server_id: "target" } });
  assert.equal(blocked.isError, true);
  assert.match((blocked.content as { text: string }[])[0].text, /TOOL_DISABLED/);
});

test("private route rejects browser origins and write protection applies at target scope", async (t) => {
  const target = await start(createServer((_request, response) => { response.writeHead(204).end(); }));
  t.after(target.close);
  const secret = "c".repeat(64);
  const gateway = await start(createGateway(parseConfig({
    mcp_path_secret: secret, read_only: false,
    servers: [{ id: "locked", name: "Locked", url: target.url, auth_mode: "none", read_only: true }],
  })));
  t.after(gateway.close);
  const wrong = await fetch(`${gateway.url}/private_wrong`);
  assert.equal(wrong.status, 404);
  const query = await fetch(`${gateway.url}/private_${secret}?unexpected=true`, { method: "POST", body: "{}" });
  assert.equal(query.status, 404);
  const browser = await fetch(`${gateway.url}/private_${secret}`, { method: "POST", headers: { origin: "http://evil.invalid" }, body: "{}" });
  assert.equal(browser.status, 403);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());
  const response = await client.callTool({ name: "delete_flow", arguments: { server_id: "locked", flow_id: "x" } });
  assert.equal(response.isError, true);
  assert.match((response.content as { text: string }[])[0].text, /read_only/);
});

test("Basic-authenticated writes create a private pre-write flow backup", async (t) => {
  const authorizations: string[] = [];
  const target = await start(createServer((request, response) => {
    authorizations.push(String(request.headers.authorization));
    if (request.url === "/flows") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rev: "before", flows: [{ id: "tab", type: "tab", label: "Main" }] }));
      return;
    }
    if (request.url === "/flow") { response.writeHead(204).end(); return; }
    response.writeHead(404).end();
  }));
  t.after(target.close);
  const backupDir = await mkdtemp(join(tmpdir(), "node-red-mcp-backup-"));
  t.after(() => rm(backupDir, { recursive: true, force: true }));
  const secret = "f".repeat(64);
  const config = parseConfig({
    mcp_path_secret: secret, read_only: false, backup_before_write: true,
    servers: [{ id: "target", name: "Target", url: target.url, auth_mode: "basic", username: "ha", password: "secret", read_only: false }],
  });
  config.backupDir = backupDir;
  const gateway = await start(createGateway(config));
  t.after(gateway.close);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());
  const tools = await client.listTools();
  const create = tools.tools.find((tool) => tool.name === "create_flow");
  assert.equal(create?.annotations?.destructiveHint, false);
  const response = await client.callTool({ name: "create_flow", arguments: { server_id: "target", flow: { id: "new" } } });
  assert.equal(response.isError, undefined);
  // backup GET /flows, create POST /flow, then the redeploy's GET /flows + POST /flows.
  assert.deepEqual(authorizations, ["Basic aGE6c2VjcmV0", "Basic aGE6c2VjcmV0", "Basic aGE6c2VjcmV0", "Basic aGE6c2VjcmV0"]);
  const files = await readdir(join(backupDir, "target"));
  assert.equal(files.length, 1);
  const backup = JSON.parse(await readFile(join(backupDir, "target", files[0]), "utf8"));
  assert.equal(backup.flows.rev, "before");
});

test("a failed pre-write backup blocks the mutation", async (t) => {
  let writes = 0;
  const target = await start(createServer((request, response) => {
    if (request.url === "/flows") { response.writeHead(503).end(); return; }
    if (request.url === "/flow") writes += 1;
    response.writeHead(204).end();
  }));
  t.after(target.close);
  const secret = "9".repeat(64);
  const gateway = await start(createGateway(parseConfig({
    mcp_path_secret: secret, read_only: false, backup_before_write: true,
    servers: [{ id: "target", name: "Target", url: target.url, auth_mode: "none", read_only: false }],
  })));
  t.after(gateway.close);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());
  const response = await client.callTool({ name: "create_flow", arguments: { server_id: "target", flow: { id: "must-not-run" } } });
  assert.equal(response.isError, true);
  assert.match((response.content as { text: string }[])[0].text, /BACKUP_FAILED/);
  assert.equal(writes, 0);
});

test("native writes preserve payloads, redeploy the modified flow, and expose Node-RED revision conflicts", async (t) => {
  const seen: { method?: string; path?: string; body?: unknown; deployment?: string }[] = [];
  const target = await start(createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.push({ method: request.method, path: request.url, body, deployment: request.headers["node-red-deployment-type"] as string | undefined });
    if (request.url === "/flows" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rev: "server-rev", flows: [] }));
      return;
    }
    // Only the deliberately stale rev used below should conflict; the client's own post-write redeploy uses a freshly fetched rev.
    if (request.url === "/flows" && (body as { rev?: string } | undefined)?.rev === "old-rev") {
      response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ message: "stale" }));
      return;
    }
    response.writeHead(204).end();
  }));
  t.after(target.close);
  const client = new NodeRedClient({ id: "fixture", name: "Fixture", baseUrl: new URL(target.url), authMode: "none", readOnly: false, disabledTools: new Set() });
  const flow = { id: "tab-1", label: "Custom", custom_property: { retained: true }, credentials: { unchanged: true } };
  await client.updateFlow("tab-1", flow);
  assert.deepEqual(seen[0], { method: "PUT", path: "/flow/tab-1", body: flow, deployment: undefined });
  assert.deepEqual(seen[1], { method: "GET", path: "/flows", body: undefined, deployment: undefined });
  assert.deepEqual(seen[2], { method: "POST", path: "/flows", body: { flows: [], rev: "server-rev" }, deployment: "flows" });
  await assert.rejects(() => client.deployFlows([], "old-rev", "flows"), (error: unknown) => error instanceof UpstreamError && error.status === 409);
  assert.deepEqual(seen.at(-1), { method: "POST", path: "/flows", body: { flows: [], rev: "old-rev" }, deployment: "flows" });
});

test("credentials are cached, known credential fields are redacted, and invalid write replies are uncertain", async (t) => {
  let tokenRequests = 0;
  let flowRequests = 0;
  const target = await start(createServer((request, response) => {
    if (request.url === "/auth/token") {
      tokenRequests += 1;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "fixture", expires_in: 3600 }));
      return;
    }
    if (request.url === "/flows") {
      flowRequests += 1;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rev: "r1", flows: [{ id: "x", credentials: { password: "never-return" }, api_key: "also-never-return" }] }));
      return;
    }
    if (request.url === "/flow") {
      response.writeHead(200, { "content-type": "application/json" }).end("not-json");
      return;
    }
    response.writeHead(404).end();
  }));
  t.after(target.close);
  const client = new NodeRedClient({ id: "fixture", name: "Fixture", baseUrl: new URL(target.url), authMode: "credentials", username: "u", password: "p", readOnly: false, disabledTools: new Set() });
  const reads = await Promise.all(Array.from({ length: 12 }, () => client.getFlows()));
  assert.equal(tokenRequests, 1);
  assert.equal(flowRequests, 12);
  const redacted = reads[0] as { redacted_credentials: boolean; redacted_secrets: boolean; suitable_for_unchanged_round_trip: boolean; data: unknown };
  assert.equal(redacted.redacted_credentials, true);
  assert.equal(redacted.redacted_secrets, true);
  assert.equal(redacted.suitable_for_unchanged_round_trip, false);
  assert.doesNotMatch(JSON.stringify(redacted.data), /never-return/);
  await assert.rejects(() => client.getFlow(".."), /Invalid flow ID/);
  await assert.rejects(() => client.createFlow({ id: "write" }), (error: unknown) => error instanceof UpstreamError && error.outcomeUnknown);
});

test("a rejected credential-mode write clears its token without being replayed", async (t) => {
  let tokenRequests = 0;
  let writes = 0;
  const target = await start(createServer((request, response) => {
    if (request.url === "/auth/token") {
      tokenRequests += 1;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: `fixture-${tokenRequests}`, expires_in: 3600 }));
      return;
    }
    if (request.url === "/flow") {
      writes += 1;
      response.writeHead(401).end();
      return;
    }
    response.writeHead(404).end();
  }));
  t.after(target.close);
  const client = new NodeRedClient({ id: "fixture", name: "Fixture", baseUrl: new URL(target.url), authMode: "credentials", username: "u", password: "p", readOnly: false, disabledTools: new Set() });
  await assert.rejects(() => client.createFlow({ id: "one" }), (error: unknown) => error instanceof UpstreamError && error.status === 401);
  await assert.rejects(() => client.createFlow({ id: "two" }), (error: unknown) => error instanceof UpstreamError && error.status === 401);
  assert.equal(tokenRequests, 2);
  assert.equal(writes, 2);
});

test("gateway permits at most twenty simultaneous upstream calls", async (t) => {
  let active = 0;
  let peak = 0;
  const target = await start(createServer((_request, response) => {
    active += 1;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active -= 1;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rev: "r1", flows: [] }));
    }, 50);
  }));
  t.after(target.close);
  const secret = "d".repeat(64);
  const gateway = await start(createGateway(parseConfig({
    mcp_path_secret: secret, read_only: true,
    servers: [{ id: "target", name: "Target", url: target.url, auth_mode: "none", read_only: false }],
  })));
  t.after(gateway.close);
  const clients: Client[] = [];
  for (let index = 0; index < 30; index += 1) clients.push(await mcp(gateway.url, secret));
  t.after(() => Promise.all(clients.map((client) => client.close())));
  const responses = await Promise.allSettled(
    clients.map((client) => client.callTool({ name: "get_flows", arguments: { server_id: "target" } })),
  );
  assert.equal(peak, 20);
  const rejected = responses.filter((response) => response.status === "rejected").length;
  const busyResults = responses.filter((response) => response.status === "fulfilled" && response.value.isError && (response.value.content as { text: string }[])[0].text.includes("Gateway is busy")).length;
  assert.equal(rejected + busyResults, 10);
});
