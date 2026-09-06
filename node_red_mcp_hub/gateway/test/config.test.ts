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
  assert.throws(() => parseConfig({ ...options, disabled_tools: "get_flwo" }), /unknown tool get_flwo/);
  assert.throws(() => parseConfig({ ...options, disabled_tools: "list_servers" }), /cannot disable/);
});

test("discovers the local Home Assistant Node-RED target without replacing manual targets", async () => {
  const urls: string[] = [];
  const discovered = await discoverHomeAssistantNodeRed({
    mcp_path_secret: "a".repeat(64), read_only: true, servers: [options.servers[0]],
    home_assistant_node_red: { enabled: true, username: "ha-user", password: "ha-password" },
  }, async (url) => {
    urls.push(url);
    if (url.endsWith("/addons")) {
      return new Response(JSON.stringify({ addons: [{ name: "Node-RED", slug: "a0d7b954_nodered", state: "started" }] }));
    }
    if (url.endsWith("/network/info")) {
      return new Response(JSON.stringify({ interfaces: [{ primary: true, ipv4: { address: ["192.168.3.57/24"] } }] }));
    }
    return new Response(JSON.stringify({ name: "Node-RED", ip_address: "172.30.32.1", host_network: true, network: { "1880/tcp": 1880 } }));
  }, "supervisor-token");
  const config = parseConfig(discovered);
  assert.equal(config.servers.get("home_assistant_node_red")?.baseUrl.toString(), "http://192.168.3.57:1880/");
  assert.equal(config.servers.get("home_assistant_node_red")?.authMode, "basic");
  assert.equal(config.servers.get("home_assistant_node_red")?.readOnly, true);
  assert.deepEqual(urls, ["http://supervisor/addons", "http://supervisor/addons/a0d7b954_nodered/info", "http://supervisor/network/info"]);
});

test("requires local Basic credentials and does not replace a manual local target", async () => {
  const missingCredentials = { ...options, home_assistant_node_red: { enabled: true } };
  await assert.rejects(() => discoverHomeAssistantNodeRed(missingCredentials), /requires username and password/);
  const manualLocal = { ...options, servers: [{ ...options.servers[0], id: "home_assistant_node_red" }], home_assistant_node_red: { enabled: true, username: "u", password: "p" } };
  const unchanged = await discoverHomeAssistantNodeRed(manualLocal, async () => {
    throw new Error("should not request Supervisor");
  }, "supervisor-token");
  assert.equal(unchanged, manualLocal);
});

test("uses an explicit local HTTP URL without requiring Supervisor discovery", async () => {
  const configured = await discoverHomeAssistantNodeRed({
    mcp_path_secret: "a".repeat(64), read_only: true, servers: [],
    home_assistant_node_red: { enabled: true, username: "ha-user", password: "ha-password", url: "http://192.168.3.57:1880" },
  }, async () => {
    throw new Error("should not request Supervisor");
  });
  const config = parseConfig(configured);
  assert.equal(config.servers.get("home_assistant_node_red")?.baseUrl.toString(), "http://192.168.3.57:1880/");
});

test("falls back to the app-internal Node-RED port when it publishes no host port", async () => {
  const discovered = await discoverHomeAssistantNodeRed({
    mcp_path_secret: "a".repeat(64), read_only: true, servers: [],
    home_assistant_node_red: { enabled: true, username: "ha-user", password: "ha-password" },
  }, async (url) => {
    if (url.endsWith("/addons")) return new Response(JSON.stringify({ addons: [{ name: "Node-RED", slug: "a0d7b954_nodered" }] }));
    if (url.endsWith("/network/info")) return new Response(JSON.stringify({ interfaces: [] }));
    return new Response(JSON.stringify({ name: "Node-RED", ip_address: "172.30.32.9", network: { "1880/tcp": null } }));
  }, "supervisor-token");
  assert.equal(parseConfig(discovered).servers.get("home_assistant_node_red")?.baseUrl.toString(), "http://172.30.32.9:1880/");
});

test("discovers a host-networked Node-RED that reports no ports and no container address", async () => {
  const discovered = await discoverHomeAssistantNodeRed({
    mcp_path_secret: "a".repeat(64), read_only: true, servers: [],
    home_assistant_node_red: { enabled: true, username: "ha-user", password: "ha-password" },
  }, async (url) => {
    if (url.endsWith("/addons")) return new Response(JSON.stringify({ addons: [{ name: "Node-RED", slug: "a0d7b954_nodered" }] }));
    if (url.endsWith("/network/info")) {
      return new Response(JSON.stringify({ interfaces: [{ primary: true, ipv4: { address: ["192.168.3.57/24"] } }] }));
    }
    return new Response(JSON.stringify({ name: "Node-RED", ip_address: "", host_network: true, network: {} }));
  }, "supervisor-token");
  assert.equal(parseConfig(discovered).servers.get("home_assistant_node_red")?.baseUrl.toString(), "http://192.168.3.57:1880/");
});

test("reports an actionable error when no endpoint can be resolved", async () => {
  await assert.rejects(() => discoverHomeAssistantNodeRed({
    mcp_path_secret: "a".repeat(64), read_only: true, servers: [],
    home_assistant_node_red: { enabled: true, username: "ha-user", password: "ha-password" },
  }, async (url) => {
    if (url.endsWith("/addons")) return new Response(JSON.stringify({ addons: [{ name: "Node-RED", slug: "a0d7b954_nodered" }] }));
    if (url.endsWith("/network/info")) return new Response(JSON.stringify({ interfaces: [] }));
    return new Response(JSON.stringify({ name: "Node-RED", ip_address: "", network: {} }));
  }, "supervisor-token"), /set home_assistant_node_red\.url instead/);
});

test("builds a copyable MCP URL from the primary Home Assistant LAN address", async () => {
  const url = await publishedMcpUrl("b".repeat(64), "51844", "supervisor-token", async () => new Response(JSON.stringify({
    data: { interfaces: [{ primary: false, ipv4: { address: ["10.0.0.2/24"] } }, { primary: true, ipv4: { address: ["192.168.3.57/24"] } }] },
  })));
  assert.equal(url, `http://192.168.3.57:51844/private_${"b".repeat(64)}`);
});
