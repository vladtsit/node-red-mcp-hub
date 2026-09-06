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

function createMcpServer(config: GatewayConfig, runtime: GatewayRuntime): McpServer {
  const mcp = new McpServer({ name: "node-red-mcp-hub", version: APP_VERSION });
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
