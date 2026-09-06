import test from "node:test";
import assert from "node:assert/strict";
import { discoverHomeAssistantNodeRed, parseConfig } from "../src/config.js";
import { publishedMcpUrl } from "../src/mcp-url.js";

const options = {
  mcp_path_secret: "a".repeat(64), read_only: true,
  servers: [{ id: "home", name: "Home", url: "http://node-red.local:1880/admin", auth_mode: "none", read_only: false }],
};

test("parses an admin-root prefix without accepting destination escape hatches", () => {
  const config = parseConfig(options);
  assert.equal(config.servers.get("home")?.baseUrl.toString(), "http://node-red.local:1880/admin");
  assert.throws(() => parseConfig({ ...options, servers: [{ ...options.servers[0], url: "http://u:p@node-red.local:1880" }] }), /credentials/);
  assert.throws(() => parseConfig({ ...options, mcp_path_secret: "short" }), /64 hexadecimal/);
});

test("validates authentication requirements and unique IDs", () => {
  assert.throws(() => parseConfig({ ...options, servers: [{ ...options.servers[0], auth_mode: "bearer" }] }), /requires token/);
  assert.throws(() => parseConfig({ ...options, servers: [options.servers[0], options.servers[0]] }), /duplicates/);
});

test("discovers the local Home Assistant Node-RED target without replacing manual targets", async () => {
  const urls: string[] = [];
  const discovered = await discoverHomeAssistantNodeRed({
    mcp_path_secret: "a".repeat(64), read_only: true, servers: [options.servers[0]],
    home_assistant_node_red: { enabled: true, token: "home-assistant-token" },
  }, async (url) => {
    urls.push(url);
    if (url.endsWith("/addons")) {
      return new Response(JSON.stringify({ addons: [{ name: "Node-RED", slug: "a0d7b954_nodered", state: "started" }] }));
    }
    return new Response(JSON.stringify({ name: "Node-RED", ip_address: "172.30.32.1", host_network: true, network: { "80/tcp": 1880 } }));
  }, "supervisor-token");
  const config = parseConfig(discovered);
  assert.equal(config.servers.get("home_assistant_node_red")?.baseUrl.toString(), "http://172.30.32.1:1880/");
  assert.equal(config.servers.get("home_assistant_node_red")?.authMode, "bearer");
  assert.equal(config.servers.get("home_assistant_node_red")?.readOnly, true);
  assert.deepEqual(urls, ["http://supervisor/addons", "http://supervisor/addons/a0d7b954_nodered/info"]);
});

test("does not add a local target without a token or over a manual local target", async () => {
  const noToken = { ...options, home_assistant_node_red: { enabled: true } };
  const missingToken = await discoverHomeAssistantNodeRed(noToken, async () => {
    throw new Error("should not request Supervisor");
  }, "supervisor-token");
  assert.equal(missingToken, noToken);
  const manualLocal = { ...options, servers: [{ ...options.servers[0], id: "home_assistant_node_red" }], home_assistant_node_red: { token: "token" } };
  const unchanged = await discoverHomeAssistantNodeRed(manualLocal, async () => {
    throw new Error("should not request Supervisor");
  }, "supervisor-token");
  assert.equal(unchanged, manualLocal);
});

test("uses an explicit local HTTP URL without requiring Supervisor discovery", async () => {
  const configured = await discoverHomeAssistantNodeRed({
    mcp_path_secret: "a".repeat(64), read_only: true, servers: [],
    home_assistant_node_red: { token: "home-assistant-token", url: "http://192.168.3.57:1880" },
  }, async () => {
    throw new Error("should not request Supervisor");
  });
  const config = parseConfig(configured);
  assert.equal(config.servers.get("home_assistant_node_red")?.baseUrl.toString(), "http://192.168.3.57:1880/");
});

test("builds a copyable MCP URL from the primary Home Assistant LAN address", async () => {
  const url = await publishedMcpUrl("b".repeat(64), "51844", "supervisor-token", async () => new Response(JSON.stringify({
    data: { interfaces: [{ primary: false, ipv4: { address: ["10.0.0.2/24"] } }, { primary: true, ipv4: { address: ["192.168.3.57/24"] } }] },
  })));
  assert.equal(url, `http://192.168.3.57:51844/private_${"b".repeat(64)}`);
});
