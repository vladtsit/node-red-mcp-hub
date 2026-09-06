import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { connect } from "node:net";
import { mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../src/config.js";
import type { TargetConfig } from "../src/config.js";
import { createGateway } from "../src/index.js";
import { NodeRedClient, UpstreamError, FlowValidationError } from "../src/node-red.js";
import { BackupManager } from "../src/backup.js";

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
    if (request.url === `/admin/flow/${label}-tab`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: `${label}-tab`, label: `Flow ${label}`, nodes: [{ id: label, type: "inject", name: `Hello ${label}`, z: `${label}-tab` }] }));
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
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["check_servers", "get_context", "get_diagnostics", "get_flow", "get_flow_state", "get_flows", "get_installed_modules", "get_settings", "list_backups", "list_flows", "list_servers", "preview_flow_change", "search_nodes"]);
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

  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "flow://one/one-tab"));
  const read = await client.readResource({ uri: "flow://one/one-tab" });
  assert.match((read.contents[0] as { text: string }).text, /Hello one/);

  const prompts = await client.listPrompts();
  assert.deepEqual(prompts.prompts.map((prompt) => prompt.name).sort(), ["add_inject_debug_pair", "diagnose_silent_failure"]);
  const prompt = await client.getPrompt({ name: "diagnose_silent_failure", arguments: { server_id: "one", flow_id: "one-tab" } });
  assert.match((prompt.messages[0].content as { text: string }).text, /wires/);
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
  // backup GET /flows, node-type validation GET /nodes, create POST /flow, then the redeploy's GET /flows + POST /flows.
  assert.deepEqual(authorizations, ["Basic aGE6c2VjcmV0", "Basic aGE6c2VjcmV0", "Basic aGE6c2VjcmV0", "Basic aGE6c2VjcmV0", "Basic aGE6c2VjcmV0"]);
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
  // Node-type validation checks GET /nodes before the write; redeploy re-reads /flows before its own POST.
  assert.deepEqual(seen[0], { method: "GET", path: "/nodes", body: undefined, deployment: undefined });
  assert.deepEqual(seen[1], { method: "PUT", path: "/flow/tab-1", body: flow, deployment: undefined });
  assert.deepEqual(seen[2], { method: "GET", path: "/flows", body: undefined, deployment: undefined });
  assert.deepEqual(seen[3], { method: "POST", path: "/flows", body: { flows: [], rev: "server-rev" }, deployment: "flows" });
  await assert.rejects(() => client.deployFlows([], "old-rev", "flows"), (error: unknown) => error instanceof UpstreamError && error.status === 409);
  assert.deepEqual(seen.at(-1), { method: "POST", path: "/flows", body: { flows: [], rev: "old-rev" }, deployment: "flows" });
});

test("server-side validation rejects malformed wires, duplicate ids, and redacted-value round-trips before writing", async (t) => {
  let writes = 0;
  const target = await start(createServer((request, response) => {
    if (request.url === "/flows" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rev: "r1", flows: [{ id: "tab-1", type: "tab" }] }));
      return;
    }
    if (request.url === "/nodes") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ name: "node-red", enabled: true, types: ["inject", "debug"] }])); return; }
    writes += 1;
    response.writeHead(204).end();
  }));
  t.after(target.close);
  const client = new NodeRedClient({ id: "fixture", name: "Fixture", baseUrl: new URL(target.url), authMode: "none", readOnly: false, disabledTools: new Set() });

  await assert.rejects(
    () => client.updateFlow("tab-1", { id: "tab-1", nodes: [{ id: "a", type: "inject", z: "tab-1", wires: ["b"] }] }),
    (error: unknown) => error instanceof FlowValidationError && /flattened/.test(error.message),
  );
  await assert.rejects(
    () => client.updateFlow("tab-1", { id: "tab-1", nodes: [{ id: "a", type: "inject", z: "tab-1" }, { id: "a", type: "debug", z: "tab-1" }] }),
    (error: unknown) => error instanceof FlowValidationError && /Duplicate node id/.test(error.message),
  );
  await assert.rejects(
    () => client.updateFlow("tab-1", { id: "tab-1", nodes: [{ id: "a", type: "inject", z: "tab-1", topic: "[redacted]" }] }),
    (error: unknown) => error instanceof FlowValidationError && /\[redacted\]/.test(error.message),
  );
  await assert.rejects(
    () => client.updateFlow("tab-1", { id: "tab-1", nodes: [{ id: "a", type: "inject", z: "tab-1", wires: [["missing-target"]] }] }),
    (error: unknown) => error instanceof FlowValidationError && /unknown node id/.test(error.message),
  );
  assert.equal(writes, 0);

  await client.updateFlow("tab-1", { id: "tab-1", nodes: [{ id: "a", type: "inject", z: "tab-1", wires: [["b"]] }, { id: "b", type: "debug", z: "tab-1" }] });
  assert.ok(writes > 0);
});

test("patch_flow merges add/update/remove against an unredacted read and never returns flow content", async (t) => {
  const flowStore: Record<string, unknown> = {
    id: "tab-1", label: "Test",
    nodes: [
      { id: "keep", type: "debug", z: "tab-1", x: 100, y: 100 },
      { id: "gone", type: "debug", z: "tab-1", x: 100, y: 200 },
      { id: "old", type: "inject", z: "tab-1", x: 100, y: 300, name: "Old Name" },
    ],
    configs: [{ id: "cfg-1", type: "mqtt-broker", credentials: { password: "real-secret" } }],
  };
  const target = await start(createServer(async (request, response) => {
    if (request.url === "/flow/tab-1" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(flowStore));
      return;
    }
    if (request.url === "/flow/tab-1" && request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      Object.assign(flowStore, JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(204).end();
      return;
    }
    if (request.url === "/flows" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rev: "r1", flows: [] }));
      return;
    }
    response.writeHead(204).end();
  }));
  t.after(target.close);
  const client = new NodeRedClient({ id: "fixture", name: "Fixture", baseUrl: new URL(target.url), authMode: "none", readOnly: false, disabledTools: new Set() });

  const diff = await client.patchFlow("tab-1", {
    remove: ["gone"],
    update: [{ id: "old", name: "New Name" }],
    add: [{ type: "debug", x: 100, y: 400 }],
  }) as { added: string[]; updated: string[]; removed: string[]; node_count_before: number; node_count_after: number };

  assert.equal(diff.removed.length, 1);
  assert.equal(diff.updated.length, 1);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.node_count_before, 4);
  assert.equal(diff.node_count_after, 4);
  assert.doesNotMatch(JSON.stringify(diff), /real-secret/);
  const nodeIds = (flowStore.nodes as Record<string, unknown>[]).map((node) => node.id);
  assert.deepEqual(nodeIds.sort(), ["keep", "old", diff.added[0]].sort());
  assert.equal((flowStore.configs as Record<string, unknown>[])[0].id, "cfg-1");
  const updatedNode = (flowStore.nodes as Record<string, unknown>[]).find((node) => node.id === "old");
  assert.equal(updatedNode?.name, "New Name");

  await assert.rejects(
    () => client.patchFlow("tab-1", { remove: ["does-not-exist"] }),
    (error: unknown) => error instanceof FlowValidationError && /not found/.test(error.message),
  );
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
  // Concurrent get_flows reads within the short-lived flows cache TTL share a single upstream call.
  assert.equal(flowRequests, 1);
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
  // Uses get_settings rather than get_flows: get_flows is served from a short-lived
  // in-memory cache, which would collapse these concurrent calls into one upstream request.
  const target = await start(createServer((_request, response) => {
    active += 1;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active -= 1;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: "4.0.0" }));
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
    clients.map((client) => client.callTool({ name: "get_settings", arguments: { server_id: "target" } })),
  );
  assert.equal(peak, 20);
  const rejected = responses.filter((response) => response.status === "rejected").length;
  const busyResults = responses.filter((response) => response.status === "fulfilled" && response.value.isError && (response.value.content as { text: string }[])[0].text.includes("Gateway is busy")).length;
  assert.equal(rejected + busyResults, 10);
});

test("BackupManager prunes stale backups by age in addition to count", async (t) => {
  const backupDir = await mkdtemp(join(tmpdir(), "node-red-mcp-backup-age-"));
  t.after(() => rm(backupDir, { recursive: true, force: true }));
  const target: TargetConfig = { id: "target", name: "Target", baseUrl: new URL("http://127.0.0.1:1/admin"), authMode: "none", readOnly: false, disabledTools: new Set() };
  const client = { getFlowsForBackup: async () => ({ rev: "r1", flows: [] }) } as unknown as NodeRedClient;
  const manager = new BackupManager(backupDir, 10, 1);
  await manager.capture(target, client, "seed");
  const targetDir = join(backupDir, "target");
  const [seeded] = await readdir(targetDir);
  await utimes(join(targetDir, seeded), new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
  await manager.capture(target, client, "fresh");
  const files = await readdir(targetDir);
  assert.equal(files.length, 1);
  assert.doesNotMatch(files[0], /seed/);
  assert.match(files[0], /fresh/);
});

test("create_subflow posts a native subflow container with in/out port arrays", async (t) => {
  const seen: { path?: string; body?: unknown }[] = [];
  const target = await start(createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.push({ path: request.url, body });
    if (request.url === "/flows") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rev: "r1", flows: [] })); return; }
    if (request.url === "/flow") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "new-subflow" })); return; }
    response.writeHead(404).end();
  }));
  t.after(target.close);
  const secret = "e".repeat(64);
  const gateway = await start(createGateway(parseConfig({
    mcp_path_secret: secret, read_only: false,
    servers: [{ id: "target", name: "Target", url: target.url, auth_mode: "none", read_only: false }],
  })));
  t.after(gateway.close);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());
  const response = await client.callTool({ name: "create_subflow", arguments: { server_id: "target", name: "My Subflow", inputs: 1, outputs: 2 } });
  assert.equal(response.isError, undefined);
  const posted = seen.find((entry) => entry.path === "/flow")?.body as Record<string, unknown>;
  assert.equal(posted.type, "subflow");
  assert.equal(posted.name, "My Subflow");
  assert.equal((posted.in as unknown[]).length, 1);
  assert.equal((posted.out as unknown[]).length, 2);
  assert.ok((posted.out as { id: string }[]).every((port) => typeof port.id === "string" && port.id.length > 0));
});

test("/healthz exposes per-target status only when the path secret is supplied", async (t) => {
  const target = await start(createServer((request, response) => {
    if (request.url === "/settings") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: "4.0.1" })); return; }
    response.writeHead(404).end();
  }));
  t.after(target.close);
  const secret = "c".repeat(64);
  const gateway = await start(createGateway(parseConfig({
    mcp_path_secret: secret, read_only: true,
    servers: [{ id: "target", name: "Target", url: target.url, auth_mode: "none", read_only: false }],
  })));
  t.after(gateway.close);
  const plain = await fetch(`${gateway.url}/healthz`);
  assert.equal(plain.status, 200);
  assert.deepEqual(await plain.json(), { status: "ok" });
  const withTargets = await fetch(`${gateway.url}/healthz?targets=${secret}`);
  assert.equal(withTargets.status, 200);
  const body = await withTargets.json() as { status: string; targets: { id: string; ok: boolean }[] };
  assert.equal(body.status, "ok");
  assert.equal(body.targets.length, 1);
  assert.equal(body.targets[0].id, "target");
  assert.equal(body.targets[0].ok, true);
});

test("trigger_inject fires an inject node with an optional property override", async (t) => {
  const seen: { path?: string; body?: unknown }[] = [];
  const target = await start(createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.push({ path: request.url, body });
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  }));
  t.after(target.close);
  const secret = "1".repeat(64);
  const gateway = await start(createGateway(parseConfig({
    mcp_path_secret: secret, read_only: false,
    servers: [{ id: "target", name: "Target", url: target.url, auth_mode: "none", read_only: false }],
  })));
  t.after(gateway.close);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());
  const response = await client.callTool({ name: "trigger_inject", arguments: { server_id: "target", node_id: "inject-1" } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(seen[0], { path: "/inject/inject-1", body: undefined });

  const withProps = await client.callTool({ name: "trigger_inject", arguments: { server_id: "target", node_id: "inject-1", override_props: [{ p: "payload", v: "hello", vt: "str" }] } });
  assert.equal(withProps.isError, undefined);
  assert.deepEqual(seen[1], { path: "/inject/inject-1", body: { __user_inject_props__: [{ p: "payload", v: "hello", vt: "str" }] } });
});

test("get_context reads global, flow, and node scoped context with query params", async (t) => {
  const seen: string[] = [];
  const target = await start(createServer((request, response) => {
    seen.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ format: "string", msg: "value" }));
  }));
  t.after(target.close);
  const secret = "2".repeat(64);
  const gateway = await start(createGateway(parseConfig({
    mcp_path_secret: secret, read_only: true,
    servers: [{ id: "target", name: "Target", url: target.url, auth_mode: "none", read_only: false }],
  })));
  t.after(gateway.close);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());

  await client.callTool({ name: "get_context", arguments: { server_id: "target", scope: "global" } });
  assert.equal(seen[0], "/context/global");

  await client.callTool({ name: "get_context", arguments: { server_id: "target", scope: "global", key: "counter" } });
  assert.equal(seen[1], "/context/global/counter");

  await client.callTool({ name: "get_context", arguments: { server_id: "target", scope: "flow", id: "tab-1", key: "counter", store: "file", keys_only: true } });
  assert.equal(seen[2], "/context/flow/tab-1/counter?store=file&keysOnly=true");

  const missingId = await client.callTool({ name: "get_context", arguments: { server_id: "target", scope: "node" } });
  assert.equal(missingId.isError, true);
  assert.match((missingId.content as { text: string }[])[0].text, /INVALID_ARGUMENT/);
});

test("list_backups reports retained backups newest-first without their content", async (t) => {
  const target = await start(createServer((request, response) => {
    if (request.url === "/flows") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rev: "r1", flows: [{ id: "tab", type: "tab", label: "Main" }] })); return; }
    response.writeHead(204).end();
  }));
  t.after(target.close);
  const backupDir = await mkdtemp(join(tmpdir(), "node-red-mcp-list-backups-"));
  t.after(() => rm(backupDir, { recursive: true, force: true }));
  const secret = "3".repeat(64);
  const config = parseConfig({
    mcp_path_secret: secret, read_only: false, backup_before_write: true,
    servers: [{ id: "target", name: "Target", url: target.url, auth_mode: "none", read_only: false }],
  });
  config.backupDir = backupDir;
  const gateway = await start(createGateway(config));
  t.after(gateway.close);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());

  const empty = await client.callTool({ name: "list_backups", arguments: { server_id: "target" } });
  assert.equal(empty.isError, undefined);
  assert.match((empty.content as { text: string }[])[0].text, /\[\]/);

  await client.callTool({ name: "create_flow", arguments: { server_id: "target", flow: { id: "new" } } });
  const listed = await client.callTool({ name: "list_backups", arguments: { server_id: "target" } });
  const parsed = JSON.parse((listed.content as { text: string }[])[0].text) as { name: string; tool?: string; size_bytes: number }[];
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].tool, "create_flow");
  assert.ok(parsed[0].size_bytes > 0);
  assert.doesNotMatch(JSON.stringify(parsed), /"flows"/);
});

test("preview_flow_change diffs a would-be update without writing", async (t) => {
  const writeAttempts: string[] = [];
  const target = await start(createServer(async (request, response) => {
    if (request.url === "/flow/tab-1" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "tab-1", label: "Main", nodes: [{ id: "keep", type: "debug", z: "tab-1" }, { id: "drop", type: "debug", z: "tab-1" }], configs: [] }));
      return;
    }
    writeAttempts.push(request.method ?? "");
    response.writeHead(204).end();
  }));
  t.after(target.close);
  const secret = "4".repeat(64);
  const gateway = await start(createGateway(parseConfig({
    mcp_path_secret: secret, read_only: true,
    servers: [{ id: "target", name: "Target", url: target.url, auth_mode: "none", read_only: false }],
  })));
  t.after(gateway.close);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());

  const flowPreview = await client.callTool({ name: "preview_flow_change", arguments: { server_id: "target", flow_id: "tab-1", flow: { id: "tab-1", nodes: [{ id: "keep", type: "debug", z: "tab-1" }, { id: "added", type: "debug", z: "tab-1" }] } } });
  assert.equal(flowPreview.isError, undefined);
  const flowDiff = JSON.parse((flowPreview.content as { text: string }[])[0].text) as { added: string[]; removed: string[]; would_delete: boolean };
  assert.deepEqual(flowDiff.added, ["added"]);
  assert.deepEqual(flowDiff.removed, ["drop"]);
  assert.equal(flowDiff.would_delete, true);

  const patchPreview = await client.callTool({ name: "preview_flow_change", arguments: { server_id: "target", flow_id: "tab-1", patch: { remove: ["drop"], add: [{ type: "debug" }] } } });
  const patchDiff = JSON.parse((patchPreview.content as { text: string }[])[0].text) as { removed: string[]; added: string[] };
  assert.deepEqual(patchDiff.removed, ["drop"]);
  assert.equal(patchDiff.added.length, 1);

  const both = await client.callTool({ name: "preview_flow_change", arguments: { server_id: "target", flow_id: "tab-1", flow: { id: "tab-1" }, patch: { remove: ["drop"] } } });
  assert.equal(both.isError, true);
  assert.match((both.content as { text: string }[])[0].text, /INVALID_ARGUMENT/);

  assert.equal(writeAttempts.length, 0);
});

test("update_flow rejects a stale expected_rev before writing", async (t) => {
  let writes = 0;
  const target = await start(createServer((request, response) => {
    if (request.url === "/flows" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rev: "current-rev", flows: [] }));
      return;
    }
    if (request.url === "/nodes") { response.writeHead(200, { "content-type": "application/json" }).end("[]"); return; }
    writes += 1;
    response.writeHead(204).end();
  }));
  t.after(target.close);
  const secret = "5".repeat(64);
  const gateway = await start(createGateway(parseConfig({
    mcp_path_secret: secret, read_only: false,
    servers: [{ id: "target", name: "Target", url: target.url, auth_mode: "none", read_only: false }],
  })));
  t.after(gateway.close);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());
  const response = await client.callTool({ name: "update_flow", arguments: { server_id: "target", flow_id: "tab-1", flow: { id: "tab-1" }, expected_rev: "stale-rev" } });
  assert.equal(response.isError, true);
  assert.match((response.content as { text: string }[])[0].text, /REV_CONFLICT/);
  assert.equal(writes, 0);
});

test("BackupManager prunes stale backups once retained backups exceed a size budget", async (t) => {
  const backupDir = await mkdtemp(join(tmpdir(), "node-red-mcp-backup-size-"));
  t.after(() => rm(backupDir, { recursive: true, force: true }));
  const target: TargetConfig = { id: "target", name: "Target", baseUrl: new URL("http://127.0.0.1:1/admin"), authMode: "none", readOnly: false, disabledTools: new Set() };
  const bigFlows = { rev: "r1", flows: Array.from({ length: 1000 }, (_, index) => ({ id: `n${index}`, type: "debug", info: "x".repeat(500) })) };
  const client = { getFlowsForBackup: async () => bigFlows } as unknown as NodeRedClient;
  const manager = new BackupManager(backupDir, 10, 0, 0.6);
  await manager.capture(target, client, "one");
  await manager.capture(target, client, "two");
  const targetDir = join(backupDir, "target");
  const files = await readdir(targetDir);
  assert.ok(files.length < 2, "oldest backup should have been pruned once the 1MB budget was exceeded");
  assert.ok(files.some((name) => name.includes("two")), "the just-written backup must never be pruned by size retention");
});

test("write tool calls append an audit log entry recording outcome and backup file", async (t) => {
  const target = await start(createServer((request, response) => {
    if (request.url === "/flows") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rev: "r1", flows: [] })); return; }
    if (request.url === "/nodes") { response.writeHead(200, { "content-type": "application/json" }).end("[]"); return; }
    response.writeHead(204).end();
  }));
  t.after(target.close);
  const backupDir = await mkdtemp(join(tmpdir(), "node-red-mcp-backup-audit-"));
  t.after(() => rm(backupDir, { recursive: true, force: true }));
  const auditDir = await mkdtemp(join(tmpdir(), "node-red-mcp-audit-"));
  t.after(() => rm(auditDir, { recursive: true, force: true }));
  const secret = "6".repeat(64);
  const config = parseConfig({
    mcp_path_secret: secret, read_only: false, backup_before_write: true,
    servers: [{ id: "target", name: "Target", url: target.url, auth_mode: "none", read_only: false }],
  });
  config.backupDir = backupDir;
  config.auditLogPath = join(auditDir, "audit.log");
  const gateway = await start(createGateway(config));
  t.after(gateway.close);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());

  await client.callTool({ name: "create_flow", arguments: { server_id: "target", flow: { id: "new" } } });
  const lines = (await readFile(config.auditLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].server_id, "target");
  assert.equal(lines[0].tool, "create_flow");
  assert.equal(lines[0].outcome, "ok");
  assert.match(lines[0].backup_file, /create_flow/);

  await client.callTool({ name: "list_flows", arguments: { server_id: "target" } });
  const stillOne = (await readFile(config.auditLogPath, "utf8")).trim().split("\n");
  assert.equal(stillOne.length, 1, "read-only tool calls must not be audited");
});


