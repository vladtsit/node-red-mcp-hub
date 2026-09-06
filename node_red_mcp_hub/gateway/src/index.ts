import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MAX_BODY_BYTES, MAX_IN_FLIGHT, PORT, loadConfig, type GatewayConfig } from "./config.js";
import { GatewayRuntime, registerTools } from "./tools.js";
import { APP_VERSION } from "./version.js";

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function secretPathMatches(pathname: string, secret: string): boolean {
  const expected = Buffer.from(`/private_${secret}`);
  const actual = Buffer.from(pathname);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function parseJson(request: IncomingMessage): Promise<unknown> {
  const length = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("body_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("invalid_json"); }
}

const AGENT_INSTRUCTIONS = `This hub exposes Node-RED Admin APIs. Flows can contain code and credentials,
and every write takes effect immediately on a live system.

Confirm before writing
- Before any create_flow, update_flow, delete_flow, or deploy_flows call,
  describe the exact change (which nodes/tabs are added, modified, or
  removed) and get explicit confirmation from the user first. Never delete or
  overwrite a flow the user has not specifically agreed to change.

Read before you write
- Inspect current state with list_flows/get_flow/search_nodes first; avoid
  get_flows for a full export unless truly needed, since it is large and may
  contain sensitive Function code.
- Only use node "type"s confirmed available via get_installed_modules or
  search_nodes; never invent a type that may not be installed.
- Prefer update_flow scoped to the one affected tab over deploy_flows (a full
  graph deploy) unless the change genuinely spans multiple tabs. Prefer
  patch_flow over update_flow when you are only adding, changing, or removing
  a few nodes: it merges your add/update/remove lists against a fresh read
  server-side, so untouched nodes and config nodes are preserved
  automatically and its response never contains full flow content.

update_flow replaces the entire tab
- Every existing node whose "z" is that tab and that you omit from your
  payload is permanently deleted. Never send a partial node list: get_flow
  first, apply your change to the object it returns, and send every node
  back.
- Preserve the tab's other top-level properties ("label", "info", "disabled",
  "env") and its separate "configs" array. Dropping "configs" deletes the
  tab's config nodes (broker/server/credential nodes referenced by id from
  other nodes) and breaks everything that referenced them.

Never write back redacted values
- Reads redact secrets: "credentials" objects and password/token/secret-like
  properties come back as the literal string "[redacted]", and the response
  sets redacted_credentials/redacted_secrets when that happened. Sending that
  placeholder back would overwrite the real secret with the string
  "[redacted]". Remove those keys from your payload instead; Node-RED keeps
  the stored credentials of any node whose "credentials" property is absent.

Node object rules
- create_flow, update_flow, patch_flow, and deploy_flows validate the payload
  before writing and reject it with VALIDATION_FAILED (no request reaches
  Node-RED) if wires is not an array of arrays, a node id is duplicated, a
  wire targets an unknown id, or the literal string "[redacted]" appears
  anywhere in the payload. Still follow the rules below; validation catches
  the mistake but does not fix it for you.
- "wires" MUST be an array of arrays: one inner array per output port, each
  holding that port's target ids, e.g. [["<targetId>"]] for a single output
  wired to one target, or [] for no outputs. A flattened ["<targetId>"] is
  invalid and fails silently: Node-RED iterates the characters of the id
  string as targets, so the source node still fires but nothing downstream
  ever receives a message and no error is reported anywhere.
- Every node "id" must be unique across the whole runtime, not just the tab.
  Generate a fresh random 16-character lowercase hex id; never reuse or guess
  one.
- Set every node's "z" to the tab id, and forward properties you do not
  recognise unchanged rather than rebuilding nodes from scratch.
- Config nodes are the ones with no "x"/"y"; other nodes reference them by id.
- Give new nodes a descriptive "name" and lay them out left-to-right
  (increasing x) with clear y spacing so the flow stays readable.

Building reliable flows
- Add a catch node so runtime errors surface instead of failing silently, and
  scope it to the nodes it should cover.
- Keep function node code small, always return msg (or null to stop), and
  report failures with node.error(err, msg) so a catch node can handle them.
- For manual testing use an inject node with "once": false and no
  "repeat"/"crontab" so it never fires on its own; a debug node with
  "tostatus": true also shows its last value on the canvas.
- To take a node out of service temporarily set "d": true to disable it
  rather than deleting it.

After writing
- create_flow/update_flow already redeploy the modified flow automatically;
  no extra deploy step is needed.
- Re-read with get_flow and confirm the change landed as intended, especially
  "wires", which fails silently when malformed.
- If a write fails or times out, do NOT blindly retry: it may already have
  been applied. Read the flow first to establish the actual state.
- deploy_flows needs the "rev" from get_flows; a stale rev returns HTTP 409.
  Re-read and re-apply rather than trying to force it.`;

function createMcpServer(config: GatewayConfig, runtime: GatewayRuntime): McpServer {
  const mcp = new McpServer({ name: "node-red-mcp-hub", version: APP_VERSION }, { instructions: AGENT_INSTRUCTIONS });
  registerTools(mcp, config, runtime);
  return mcp;
}

export function createGateway(config: GatewayConfig) {
  const runtime = new GatewayRuntime(config);
  let inFlight = 0;
  const gateway = createServer(async (request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://gateway.invalid"); }
    catch { return json(response, 400, { error: "invalid_request_target" }); }
    if (url.pathname === "/healthz") {
      if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      return json(response, 200, { status: "ok" });
    }
    if (url.search) return json(response, 404, { error: "not_found" });
    if (!secretPathMatches(url.pathname, config.pathSecret)) return json(response, 404, { error: "not_found" });
    if (request.headers.origin) return json(response, 403, { error: "origin_not_allowed" });
    if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
    if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") return json(response, 415, { error: "unsupported_content_encoding" });
    if (inFlight >= MAX_IN_FLIGHT) return json(response, 503, { error: "busy" });
    inFlight += 1;
    try {
      const body = await parseJson(request);
      const mcp = createMcpServer(config, runtime);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        void transport.close();
        void mcp.close();
      };
      response.once("finish", cleanup);
      response.once("close", cleanup);
      request.once("aborted", cleanup);
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (caught) {
      if (!response.headersSent) {
        const reason = caught instanceof Error ? caught.message : "internal";
        json(response, reason === "body_too_large" ? 413 : reason === "invalid_json" ? 400 : 500, { error: reason === "body_too_large" ? "body_too_large" : reason === "invalid_json" ? "invalid_json" : "internal_error" });
      }
    } finally { inFlight -= 1; }
  });
  gateway.headersTimeout = 10_000;
  gateway.requestTimeout = 30_000;
  gateway.keepAliveTimeout = 5_000;
  gateway.maxRequestsPerSocket = 100;
  gateway.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  return gateway;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const gateway = createGateway(config);
  gateway.listen(PORT, "0.0.0.0", () => console.log(`Node-RED MCP Hub ${APP_VERSION} listening on ${PORT}`));
  const stop = (signal: string) => {
    console.log(`Received ${signal}; shutting down`);
    gateway.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Node-RED MCP Hub could not start; check add-on options: ${detail}`);
    process.exitCode = 1;
  });
}
