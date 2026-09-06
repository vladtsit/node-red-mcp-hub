import { randomBytes } from "node:crypto";
import { REQUEST_TIMEOUT_MS, MAX_BODY_BYTES, type TargetConfig } from "./config.js";
import { findRedactedLeaks, isPlainObject, validateNodes } from "./flow-validate.js";

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly outcomeUnknown = false,
    readonly code = "UPSTREAM_ERROR",
    readonly retryable = false,
  ) { super(message); }
}

export class FlowValidationError extends Error {
  constructor(readonly issues: string[]) { super(`Flow validation failed: ${issues.join("; ")}`); }
}

type CachedToken = { value: string; expiresAt: number };

const SENSITIVE_KEY = /password|passphrase|token|secret|credential|authorization|api[_-]?key/i;
const SENSITIVE_PATH_KEY = /host|hostname|address|url|path|directory|dir|file/i;

function redactSensitiveKeys(value: unknown, redactPaths = true): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    const values = value.map((item) => redactSensitiveKeys(item, redactPaths));
    return { value: values.map((item) => item.value), changed: values.some((item) => item.changed) };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  let changed = false;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key) || (redactPaths && SENSITIVE_PATH_KEY.test(key))) {
      output[key] = "[redacted]";
      changed = true;
    } else {
      const child = redactSensitiveKeys(item, redactPaths);
      output[key] = child.value;
      changed ||= child.changed;
    }
  }
  return { value: output, changed };
}

function safeJson(value: unknown, redactPaths = true): unknown { return redactSensitiveKeys(value, redactPaths).value; }

function redactKnownCredentials(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    const values = value.map(redactKnownCredentials);
    return { value: values.map((item) => item.value), changed: values.some((item) => item.changed) };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  let changed = false;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase() === "credentials") {
      output[key] = "[redacted]";
      changed = true;
    } else {
      const child = redactKnownCredentials(item);
      output[key] = child.value;
      changed ||= child.changed;
    }
  }
  return { value: output, changed };
}

function safeFlowRead(value: unknown, redactSecrets: boolean): unknown {
  const credentials = redactKnownCredentials(value);
  const secrets = redactSecrets ? redactSensitiveKeys(credentials.value, false) : { value: credentials.value, changed: false };
  const changed = credentials.changed || secrets.changed;
  return {
    data: secrets.value,
    ...(credentials.changed ? { redacted_credentials: true } : {}),
    ...(secrets.changed ? { redacted_secrets: true } : {}),
    sensitive_content_warning: "Function code and arbitrary node properties may still contain secrets.",
    ...(changed ? { suitable_for_unchanged_round_trip: false } : {}),
  };
}

function flowDocument(value: unknown): { rev?: string; flows: Record<string, unknown>[] } {
  if (Array.isArray(value)) return { flows: value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    return {
      ...(typeof row.rev === "string" ? { rev: row.rev } : {}),
      flows: Array.isArray(row.flows) ? row.flows.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [],
    };
  }
  throw new UpstreamError("Node-RED returned an invalid flows document", undefined, false, "UPSTREAM_INVALID_RESPONSE");
}

function flowPathSegment(id: string): string {
  if (id === "." || id === "..") throw new UpstreamError("Invalid flow ID");
  return encodeURIComponent(id);
}

export class NodeRedClient {
  #token?: CachedToken;
  #tokenRefresh?: Promise<string>;

  constructor(readonly target: TargetConfig) {}

  private endpoint(path: string): URL {
    const prefix = this.target.baseUrl.pathname === "/" ? "" : this.target.baseUrl.pathname.replace(/\/+$/, "");
    return new URL(`${prefix}${path}`, this.target.baseUrl.origin);
  }

  private async getCredentialsToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 30_000) return this.#token.value;
    if (this.#tokenRefresh) return this.#tokenRefresh;
    this.#tokenRefresh = (async () => {
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
    })();
    try { return await this.#tokenRefresh; }
    finally { this.#tokenRefresh = undefined; }
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
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw new UpstreamError("Node-RED response exceeds size limit");
    }
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
      if (response.status === 401 && this.target.authMode === "credentials" && !options.skipAuth) {
        this.#token = undefined;
        if (!options.write && allowReadAuthRefresh) {
          await response.body?.cancel();
          return this.raw(path, options, false);
        }
      }
      if (!response.ok) {
        // Upstream response bodies can contain target details or flow content.
        // Keep errors useful but never reflect untrusted upstream text to MCP.
        void response.body?.cancel().catch(() => {});
        const code = response.status === 401 || response.status === 403 ? "AUTH_FAILED"
          : response.status === 409 ? "REV_CONFLICT" : "UPSTREAM_HTTP_ERROR";
        throw new UpstreamError(`Node-RED returned HTTP ${response.status}`, response.status, false, code, response.status >= 500);
      }
      const body = await this.readBody(response);
      if (!body) return { json: undefined, empty: true };
      try { return { json: JSON.parse(body), empty: false }; }
      catch { throw new UpstreamError("Node-RED returned an invalid JSON response", undefined, false, "UPSTREAM_INVALID_RESPONSE"); }
    } catch (error) {
      if (error instanceof UpstreamError) {
        if (options.write && error.status === undefined && !error.outcomeUnknown) {
          throw new UpstreamError("Node-RED write response was invalid; outcome is unknown", undefined, true, "OUTCOME_UNKNOWN");
        }
        throw error;
      }
      const uncertain = options.write === true;
      if (error instanceof Error && error.name === "AbortError") {
        throw new UpstreamError(uncertain ? "Node-RED write timed out; outcome is unknown" : "Node-RED request timed out", undefined, uncertain, uncertain ? "OUTCOME_UNKNOWN" : "UPSTREAM_TIMEOUT", !uncertain);
      }
      throw new UpstreamError(uncertain ? "Node-RED write connection failed; outcome is unknown" : "Node-RED connection failed", undefined, uncertain, uncertain ? "OUTCOME_UNKNOWN" : "UPSTREAM_CONNECTION_FAILED", !uncertain);
    } finally { clearTimeout(timer); }
  }

  private async request(path: string, method = "GET", body?: unknown, extraHeaders?: Record<string, string>, write = false): Promise<unknown> {
    const result = await this.raw(path, {
      method, write, headers: body === undefined ? extraHeaders : { "content-type": "application/json", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return result.empty ? { ok: true } : result.json;
  }

  private getFlowsRaw() { return this.request("/flows", "GET", undefined, { "Node-RED-API-Version": "v2" }); }
  getFlowsForBackup() { return this.getFlowsRaw(); }
  async getFlows(redactSecrets = true) { return safeFlowRead(await this.getFlowsRaw(), redactSecrets); }
  async getFlow(id: string, redactSecrets = true) { return safeFlowRead(await this.request(`/flow/${flowPathSegment(id)}`), redactSecrets); }
  async listFlows() {
    const document = flowDocument(await this.getFlowsRaw());
    const containers = document.flows.filter((item) => item.type === "tab" || item.type === "subflow");
    const summaries = containers.map((item) => ({
      id: item.id,
      type: item.type,
      label: typeof item.label === "string" ? item.label : typeof item.name === "string" ? item.name : "",
      disabled: item.disabled === true,
      node_count: document.flows.filter((node) => node.z === item.id).length,
    }));
    return { ...(document.rev ? { rev: document.rev } : {}), total_nodes: document.flows.length, flows: summaries };
  }
  async searchNodes(query: string, limit: number, flowId?: string) {
    const document = flowDocument(await this.getFlowsRaw());
    const needle = query.toLowerCase();
    const containers = new Map(document.flows.filter((item) => item.type === "tab" || item.type === "subflow").map((item) => [item.id, item]));
    const nodes = document.flows.filter((item) => item.type !== "tab" && item.type !== "subflow")
      .filter((item) => !flowId || item.z === flowId)
      .filter((item) => [item.id, item.type, item.name, item.label, item.topic].some((field) => typeof field === "string" && field.toLowerCase().includes(needle)))
      .slice(0, limit)
      .map((item) => ({ id: item.id, type: item.type, name: item.name ?? item.label ?? "", flow_id: item.z, flow_label: containers.get(item.z)?.label ?? "", disabled: item.disabled === true }));
    return { query, count: nodes.length, nodes };
  }
  async checkStatus() {
    const started = performance.now();
    const settings = await this.request("/settings");
    const version = settings && typeof settings === "object" && !Array.isArray(settings) && typeof (settings as Record<string, unknown>).version === "string"
      ? (settings as Record<string, unknown>).version : undefined;
    return { ok: true, latency_ms: Math.round(performance.now() - started), ...(version ? { version } : {}) };
  }
  async getAllNodeIds(): Promise<Set<string>> {
    const document = flowDocument(await this.getFlowsRaw());
    return new Set(document.flows.map((node) => (typeof node.id === "string" ? node.id : undefined)).filter((id): id is string => !!id));
  }
  private collectNodesForTabPayload(flow: unknown): Record<string, unknown>[] {
    if (!isPlainObject(flow)) return [];
    const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
    const configs = Array.isArray(flow.configs) ? flow.configs : [];
    return [...nodes, ...configs].filter(isPlainObject);
  }
  private hasWireTargets(nodes: Record<string, unknown>[]): boolean {
    return nodes.some((node) => Array.isArray(node.wires) && node.wires.some((port) => Array.isArray(port) && port.length > 0));
  }
  private async validateTabWrite(flow: unknown, tabId?: string): Promise<void> {
    const nodes = this.collectNodesForTabPayload(flow);
    const knownIds = this.hasWireTargets(nodes) ? await this.getAllNodeIds() : undefined;
    const issues = [...findRedactedLeaks(flow), ...validateNodes(nodes, { tabId, knownIds })].filter((issue) => issue.level === "error");
    if (issues.length) throw new FlowValidationError(issues.map((issue) => issue.message));
  }
  private validateDeployPayload(flows: unknown): void {
    const nodes = Array.isArray(flows) ? flows.filter(isPlainObject) : [];
    const knownIds = new Set(nodes.map((node) => (typeof node.id === "string" ? node.id : undefined)).filter((id): id is string => !!id));
    const issues = [...findRedactedLeaks(flows), ...validateNodes(nodes, { knownIds, allowContainerTypes: true })].filter((issue) => issue.level === "error");
    if (issues.length) throw new FlowValidationError(issues.map((issue) => issue.message));
  }
  /**
   * POST /flow and PUT /flow/:id only perform a targeted "nodes" reload of the
   * affected tab. In practice new nodes it adds (e.g. a new debug node) can be
   * created but not fully wired into the running flow's message/status
   * routing until a "Modified Flows" deploy runs, matching what the editor's
   * Deploy button does after any change. Follow every single-flow write with
   * a "flows"-type redeploy of the current config so newly added nodes
   * actually start, without restarting the whole runtime like a full deploy.
   */
  private async redeployModifiedFlows() {
    const current = flowDocument(await this.getFlowsRaw());
    if (!current.rev) return;
    await this.request("/flows", "POST", { flows: current.flows, rev: current.rev }, { "Node-RED-API-Version": "v2", "Node-RED-Deployment-Type": "flows" }, true);
  }
  async createFlow(flow: unknown) {
    await this.validateTabWrite(flow);
    const result = await this.request("/flow", "POST", flow, undefined, true);
    await this.redeployModifiedFlows();
    return result;
  }
  async updateFlow(id: string, flow: unknown) {
    await this.validateTabWrite(flow, id);
    const result = await this.request(`/flow/${flowPathSegment(id)}`, "PUT", flow, undefined, true);
    await this.redeployModifiedFlows();
    return result;
  }
  deleteFlow(id: string) { return this.request(`/flow/${flowPathSegment(id)}`, "DELETE", undefined, undefined, true); }
  deployFlows(flows: unknown, rev: string, deploymentType: "nodes" | "flows" | "full") {
    this.validateDeployPayload(flows);
    return this.request("/flows", "POST", { flows, rev }, { "Node-RED-API-Version": "v2", "Node-RED-Deployment-Type": deploymentType }, true);
  }
  private async getFlowRaw(id: string): Promise<Record<string, unknown>> {
    const data = await this.request(`/flow/${flowPathSegment(id)}`);
    if (!isPlainObject(data)) throw new UpstreamError("Node-RED returned an invalid flow document", undefined, false, "UPSTREAM_INVALID_RESPONSE");
    return data;
  }
  /**
   * Merges add/update/remove against a freshly (unredacted) read flow so
   * untouched nodes are preserved automatically and never round-trips actual
   * secret values through the caller: only an id-level diff is returned.
   */
  async patchFlow(id: string, patch: { add?: unknown[]; update?: unknown[]; remove?: string[] }) {
    const current = await this.getFlowRaw(id);
    const currentNodes = Array.isArray(current.nodes) ? current.nodes.filter(isPlainObject) : [];
    const currentConfigs = Array.isArray(current.configs) ? current.configs.filter(isPlainObject) : [];
    const nodesById = new Map(currentNodes.map((node) => [String(node.id), node]));
    const configsById = new Map(currentConfigs.map((node) => [String(node.id), node]));
    const existingIds = new Set([...nodesById.keys(), ...configsById.keys()]);

    const removed: string[] = [];
    const notFound: string[] = [];
    for (const removeId of patch.remove ?? []) {
      if (nodesById.delete(removeId) || configsById.delete(removeId)) removed.push(removeId);
      else notFound.push(`Cannot remove node "${removeId}": not found in this flow.`);
    }

    const updated: string[] = [];
    for (const item of patch.update ?? []) {
      if (!isPlainObject(item) || typeof item.id !== "string") throw new FlowValidationError(['Each "update" item must be an object with a string "id".']);
      const store = nodesById.has(item.id) ? nodesById : configsById.has(item.id) ? configsById : undefined;
      if (!store) { notFound.push(`Cannot update node "${item.id}": not found in this flow.`); continue; }
      store.set(item.id, { ...store.get(item.id), ...item });
      updated.push(item.id);
    }
    if (notFound.length) throw new FlowValidationError(notFound);

    const added: string[] = [];
    for (const item of patch.add ?? []) {
      if (!isPlainObject(item)) throw new FlowValidationError(['Each "add" item must be an object.']);
      const nodeId = typeof item.id === "string" && item.id ? item.id : randomBytes(8).toString("hex");
      if (existingIds.has(nodeId)) throw new FlowValidationError([`Cannot add node "${nodeId}": id already exists in this flow.`]);
      const node: Record<string, unknown> = { ...item, id: nodeId, z: id };
      const hasCoords = typeof node.x === "number" && typeof node.y === "number";
      (hasCoords ? nodesById : configsById).set(nodeId, node);
      existingIds.add(nodeId);
      added.push(nodeId);
    }

    const newFlow: Record<string, unknown> = { id, label: current.label };
    for (const key of ["info", "disabled", "env"]) if (key in current) newFlow[key] = current[key];
    newFlow.nodes = [...nodesById.values()];
    newFlow.configs = [...configsById.values()];

    await this.updateFlow(id, newFlow);
    return {
      added, updated, removed,
      node_count_before: currentNodes.length + currentConfigs.length,
      node_count_after: nodesById.size + configsById.size,
    };
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
