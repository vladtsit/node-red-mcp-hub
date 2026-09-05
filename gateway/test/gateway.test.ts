import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
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

test("actual MCP client initializes, discovers, and routes simultaneous target reads", async (t) => {
  const targets = await Promise.all(["one", "two"].map(async (label) => start(createServer((request, response) => {
    if (request.url === "/admin/flows") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ rev: label, flows: [{ id: label }] }));
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
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["get_diagnostics", "get_flow", "get_flow_state", "get_flows", "get_installed_modules", "get_settings", "list_servers"]);
  const [one, two] = await Promise.all(["one", "two"].map((server_id) => client.callTool({ name: "get_flows", arguments: { server_id } })));
  assert.match((one.content as { text: string }[])[0].text, /"one"/);
  assert.match((two.content as { text: string }[])[0].text, /"two"/);
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
  const browser = await fetch(`${gateway.url}/private_${secret}`, { method: "POST", headers: { origin: "http://evil.invalid" }, body: "{}" });
  assert.equal(browser.status, 403);
  const client = await mcp(gateway.url, secret);
  t.after(() => client.close());
  const response = await client.callTool({ name: "delete_flow", arguments: { server_id: "locked", flow_id: "x" } });
  assert.equal(response.isError, true);
  assert.match((response.content as { text: string }[])[0].text, /read_only/);
});

test("native writes preserve payloads and expose Node-RED revision conflicts", async (t) => {
  const seen: { method?: string; path?: string; body?: unknown; deployment?: string }[] = [];
  const target = await start(createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    seen.push({ method: request.method, path: request.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined, deployment: request.headers["node-red-deployment-type"] as string | undefined });
    if (request.url === "/flows") { response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ message: "stale" })); return; }
    response.writeHead(204).end();
  }));
  t.after(target.close);
  const client = new NodeRedClient({ id: "fixture", name: "Fixture", baseUrl: new URL(target.url), authMode: "none", readOnly: false });
  const flow = { id: "tab-1", label: "Custom", custom_property: { retained: true }, credentials: { unchanged: true } };
  await client.updateFlow("tab-1", flow);
  assert.deepEqual(seen[0], { method: "PUT", path: "/flow/tab-1", body: flow, deployment: undefined });
  await assert.rejects(() => client.deployFlows([], "old-rev", "flows"), (error: unknown) => error instanceof UpstreamError && error.status === 409);
  assert.deepEqual(seen[1], { method: "POST", path: "/flows", body: { flows: [], rev: "old-rev" }, deployment: "flows" });
});
