import { REQUEST_TIMEOUT_MS, MAX_BODY_BYTES, type TargetConfig } from "./config.js";

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly outcomeUnknown = false,
  ) { super(message); }
}

type CachedToken = { value: string; expiresAt: number };

const SENSITIVE_KEY = /password|passphrase|token|secret|credential|authorization|api[_-]?key/i;
const SENSITIVE_PATH_KEY = /host|hostname|address|url|path|directory|dir|file/i;

function safeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) || SENSITIVE_PATH_KEY.test(key) ? "[redacted]" : safeJson(item),
  ]));
}

export class NodeRedClient {
  #token?: CachedToken;

  constructor(readonly target: TargetConfig) {}

  private endpoint(path: string): URL {
    const prefix = this.target.baseUrl.pathname === "/" ? "" : this.target.baseUrl.pathname.replace(/\/+$/, "");
    return new URL(`${prefix}${path}`, this.target.baseUrl.origin);
  }

  private async getCredentialsToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 30_000) return this.#token.value;
    const form = new URLSearchParams({
      grant_type: "password", client_id: "node-red-admin", scope: "*",
      username: this.target.username!, password: this.target.password!,
    });
    const response = await this.raw("/auth/token", {
      method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" }, skipAuth: true,
    });
    const payload = response.json as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (!payload || typeof payload.access_token !== "string") throw new UpstreamError("Node-RED authentication returned no access token");
    const seconds = typeof payload.expires_in === "number" ? payload.expires_in : 300;
    this.#token = { value: payload.access_token, expiresAt: Date.now() + Math.max(1, seconds) * 1000 };
    return this.#token.value;
  }

  private async authHeader(): Promise<string | undefined> {
    switch (this.target.authMode) {
      case "none": return undefined;
      case "bearer": return `Bearer ${this.target.token!}`;
      case "basic": return `Basic ${Buffer.from(`${this.target.username!}:${this.target.password!}`).toString("base64")}`;
      case "credentials": return `Bearer ${await this.getCredentialsToken()}`;
    }
  }

  private async readBody(response: Response): Promise<string> {
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new UpstreamError("Node-RED response exceeds size limit");
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new UpstreamError("Node-RED response exceeds size limit");
      }
      chunks.push(next.value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  private async raw(path: string, options: {
    method: string; body?: string; headers?: Record<string, string>; skipAuth?: boolean; write?: boolean;
  }, allowReadAuthRefresh = true): Promise<{ json: unknown; empty: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const authorization = options.skipAuth ? undefined : await this.authHeader();
      const response = await fetch(this.endpoint(path), {
        method: options.method, body: options.body, redirect: "error", signal: controller.signal,
        headers: { accept: "application/json", ...(authorization ? { authorization } : {}), ...options.headers },
      });
      const body = await this.readBody(response);
      if (response.status === 401 && this.target.authMode === "credentials" && !options.skipAuth && !options.write && allowReadAuthRefresh) {
        this.#token = undefined;
        return this.raw(path, options, false);
      }
      if (!response.ok) {
        // Upstream response bodies can contain target details or flow content.
        // Keep errors useful but never reflect untrusted upstream text to MCP.
        throw new UpstreamError(`Node-RED returned HTTP ${response.status}`, response.status);
      }
      if (!body) return { json: undefined, empty: true };
      try { return { json: JSON.parse(body), empty: false }; }
      catch { throw new UpstreamError("Node-RED returned an invalid JSON response"); }
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      const uncertain = options.write === true;
      if (error instanceof Error && error.name === "AbortError") {
        throw new UpstreamError(uncertain ? "Node-RED write timed out; outcome is unknown" : "Node-RED request timed out", undefined, uncertain);
      }
      throw new UpstreamError(uncertain ? "Node-RED write connection failed; outcome is unknown" : "Node-RED connection failed", undefined, uncertain);
    } finally { clearTimeout(timer); }
  }

  private async request(path: string, method = "GET", body?: unknown, extraHeaders?: Record<string, string>, write = false): Promise<unknown> {
    const result = await this.raw(path, {
      method, write, headers: body === undefined ? extraHeaders : { "content-type": "application/json", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return result.empty ? { ok: true } : result.json;
  }

  getFlows() { return this.request("/flows", "GET", undefined, { "Node-RED-API-Version": "v2" }); }
  getFlow(id: string) { return this.request(`/flow/${encodeURIComponent(id)}`); }
  createFlow(flow: unknown) { return this.request("/flow", "POST", flow, undefined, true); }
  updateFlow(id: string, flow: unknown) { return this.request(`/flow/${encodeURIComponent(id)}`, "PUT", flow, undefined, true); }
  deleteFlow(id: string) { return this.request(`/flow/${encodeURIComponent(id)}`, "DELETE", undefined, undefined, true); }
  deployFlows(flows: unknown, rev: string, deploymentType: "nodes" | "flows" | "full") {
    return this.request("/flows", "POST", { flows, rev }, { "Node-RED-API-Version": "v2", "Node-RED-Deployment-Type": deploymentType }, true);
  }
  async getSettings() {
    const settings = await this.request("/settings");
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
    const allowed = ["version", "flows", "contextStorage", "exportGlobalContextKeys", "runtimeState", "palette"];
    return Object.fromEntries(allowed.filter((key) => key in settings).map((key) => [key, safeJson((settings as Record<string, unknown>)[key])]));
  }
  async getDiagnostics() { return safeJson(await this.request("/diagnostics")); }
  getFlowState() { return this.request("/flows/state"); }
  getInstalledModules() { return this.request("/nodes"); }
}
