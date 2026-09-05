import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

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
