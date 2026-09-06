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

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual(a[key], b[key]));
}

export class NodeRedClient {
  #token?: CachedToken;
  #tokenRefresh?: Promise<string>;
  #flowsCache?: { at: number; value: Promise<unknown> };
  static readonly FLOWS_CACHE_TTL_MS = 1_500;

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
    method: string; body?: string; headers?: Record<string, string>; skipAuth?: boolean; write?: boolean; expectJson?: boolean;
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
      // Some admin routes (e.g. POST /inject/:id) reply res.sendStatus(200) with a plain-text "OK" body, not JSON.
      if (options.expectJson === false) return { json: undefined, empty: true };
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

  private async request(path: string, method = "GET", body?: unknown, extraHeaders?: Record<string, string>, write = false, expectJson = true): Promise<unknown> {
    const result = await this.raw(path, {
      method, write, expectJson, headers: body === undefined ? extraHeaders : { "content-type": "application/json", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return result.empty ? { ok: true } : result.json;
  }

  private getFlowsRaw(bypassCache = false) {
    if (!bypassCache && this.#flowsCache && Date.now() - this.#flowsCache.at < NodeRedClient.FLOWS_CACHE_TTL_MS) {
      return this.#flowsCache.value;
    }
    const promise = this.request("/flows", "GET", undefined, { "Node-RED-API-Version": "v2" });
    this.#flowsCache = { at: Date.now(), value: promise };
    promise.catch(() => { this.#flowsCache = undefined; });
    return promise;
  }
  private invalidateFlowsCache() { this.#flowsCache = undefined; }
  /** Backups must reflect the exact pre-write state, never a cached copy. */
  getFlowsForBackup() { return this.getFlowsRaw(true); }
  async getFlows(redactSecrets = true) { return safeFlowRead(await this.getFlowsRaw(), redactSecrets); }
  async getFlow(id: string, redactSecrets = true) {
    const [flow, document] = await Promise.all([
      this.request(`/flow/${flowPathSegment(id)}`),
      this.getFlowsRaw().then(flowDocument).catch(() => undefined),
    ]);
    const safe = safeFlowRead(flow, redactSecrets) as Record<string, unknown>;
    return document?.rev ? { ...safe, rev: document.rev } : safe;
  }
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
  /** Resolves installed node types from get_installed_modules; returns undefined (skip check) if that call fails. */
  private async getKnownNodeTypes(): Promise<Set<string> | undefined> {
    try {
      const modules = await this.getInstalledModules();
      if (!Array.isArray(modules)) return undefined;
      const types = new Set<string>();
      for (const entry of modules) {
        if (!isPlainObject(entry) || entry.enabled === false) continue;
        if (Array.isArray(entry.types)) for (const type of entry.types) if (typeof type === "string") types.add(type);
      }
      return types;
    } catch { return undefined; }
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
    const needsKnownIds = this.hasWireTargets(nodes) || nodes.some((node) => typeof node.type === "string" && node.type.startsWith("subflow:"));
    const [knownIds, knownTypes] = await Promise.all([
      needsKnownIds ? this.getAllNodeIds() : Promise.resolve(undefined),
      this.getKnownNodeTypes(),
    ]);
    const issues = [...findRedactedLeaks(flow), ...validateNodes(nodes, { tabId, knownIds, knownTypes })].filter((issue) => issue.level === "error");
    if (issues.length) throw new FlowValidationError(issues.map((issue) => issue.message));
  }
  private async validateDeployPayload(flows: unknown): Promise<void> {
    const nodes = Array.isArray(flows) ? flows.filter(isPlainObject) : [];
    const knownIds = new Set(nodes.map((node) => (typeof node.id === "string" ? node.id : undefined)).filter((id): id is string => !!id));
    const knownTypes = await this.getKnownNodeTypes();
    const issues = [...findRedactedLeaks(flows), ...validateNodes(nodes, { knownIds, knownTypes, allowContainerTypes: true })].filter((issue) => issue.level === "error");
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
    const current = flowDocument(await this.getFlowsRaw(true));
    if (!current.rev) return;
    await this.request("/flows", "POST", { flows: current.flows, rev: current.rev }, { "Node-RED-API-Version": "v2", "Node-RED-Deployment-Type": "flows" }, true);
  }
  /** A saved-but-not-redeployed flow must be reported distinctly from an ordinary write failure. */
  private async completeWrite(writeResult: unknown): Promise<unknown> {
    this.invalidateFlowsCache();
    try { await this.redeployModifiedFlows(); }
    catch (caught) {
      const detail = caught instanceof Error ? caught.message : "unknown error";
      const id = isPlainObject(writeResult) && typeof writeResult.id === "string" ? writeResult.id : "unknown";
      throw new UpstreamError(`Flow "${id}" was saved but the follow-up redeploy failed, so new or changed nodes may not be running yet: ${detail}. Re-read the flow to confirm its actual state and retry only the redeploy (e.g. deploy_flows), not the original write.`, undefined, true, "REDEPLOY_FAILED", false);
    }
    return writeResult;
  }
  private async assertExpectedRev(expectedRev: string): Promise<void> {
    const document = flowDocument(await this.getFlowsRaw(true));
    if (document.rev !== expectedRev) {
      throw new UpstreamError(`Expected revision "${expectedRev}" but Node-RED is currently at "${document.rev ?? "unknown"}"; someone else may have changed flows. Re-read before writing.`, 409, false, "REV_CONFLICT");
    }
  }
  async createFlow(flow: unknown) {
    await this.validateTabWrite(flow);
    const result = await this.request("/flow", "POST", flow, undefined, true);
    return this.completeWrite(result);
  }
  /**
   * POST /flow (addFlow) always wraps its payload as a new "tab" with a
   * server-generated id and rejects any embedded "tab"/"subflow" node, so it
   * can never create a subflow definition. Subflow definitions instead live
   * as top-level entries in the full flows array, so append it there and
   * deploy the whole document like a "flows"-type deploy.
   */
  async createSubflow(subflow: Record<string, unknown>) {
    const leaks = findRedactedLeaks(subflow).filter((issue) => issue.level === "error");
    if (leaks.length) throw new FlowValidationError(leaks.map((issue) => issue.message));
    const document = flowDocument(await this.getFlowsRaw(true));
    if (document.flows.some((node) => node.id === subflow.id)) {
      throw new FlowValidationError([`Cannot add subflow "${subflow.id}": id already exists.`]);
    }
    const flows = [...document.flows, subflow];
    await this.request("/flows", "POST", { flows, rev: document.rev }, { "Node-RED-API-Version": "v2", "Node-RED-Deployment-Type": "flows" }, true);
    this.invalidateFlowsCache();
    return { id: subflow.id };
  }
  async updateFlow(id: string, flow: unknown, expectedRev?: string) {
    await this.validateTabWrite(flow, id);
    if (expectedRev !== undefined) await this.assertExpectedRev(expectedRev);
    const result = await this.request(`/flow/${flowPathSegment(id)}`, "PUT", flow, undefined, true);
    return this.completeWrite(result);
  }
  async deleteFlow(id: string, expectedRev?: string) {
    if (expectedRev !== undefined) await this.assertExpectedRev(expectedRev);
    const result = await this.request(`/flow/${flowPathSegment(id)}`, "DELETE", undefined, undefined, true);
    this.invalidateFlowsCache();
    return result;
  }
  async deployFlows(flows: unknown, rev: string, deploymentType: "nodes" | "flows" | "full") {
    await this.validateDeployPayload(flows);
    const result = await this.request("/flows", "POST", { flows, rev }, { "Node-RED-API-Version": "v2", "Node-RED-Deployment-Type": deploymentType }, true);
    this.invalidateFlowsCache();
    return result;
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
  /**
   * Dry-run diff against the current tab: never writes anything. Accepts
   * either a full replacement "flow" (update_flow style, flagging any node
   * present now but missing from the payload as an accidental deletion) or a
   * "patch" (patch_flow style add/update/remove lists).
   */
  async previewFlowChange(id: string, input: { flow?: unknown; patch?: { add?: unknown[]; update?: unknown[]; remove?: string[] } }) {
    const current = await this.getFlowRaw(id);
    const currentNodes = Array.isArray(current.nodes) ? current.nodes.filter(isPlainObject) : [];
    const currentConfigs = Array.isArray(current.configs) ? current.configs.filter(isPlainObject) : [];
    const currentIds = new Set([...currentNodes, ...currentConfigs].map((node) => String(node.id)));

    if (input.flow !== undefined) {
      const payloadNodes = this.collectNodesForTabPayload(input.flow);
      const payloadById = new Map(payloadNodes.map((node) => [String(node.id), node]));
      const currentById = new Map([...currentNodes, ...currentConfigs].map((node) => [String(node.id), node]));
      const added = [...payloadById.keys()].filter((nodeId) => !currentIds.has(nodeId));
      const removed = [...currentIds].filter((nodeId) => !payloadById.has(nodeId));
      const overlapping = [...payloadById.keys()].filter((nodeId) => currentIds.has(nodeId));
      const updated = overlapping.filter((nodeId) => !deepEqual(currentById.get(nodeId), payloadById.get(nodeId)));
      const kept = overlapping.filter((nodeId) => deepEqual(currentById.get(nodeId), payloadById.get(nodeId)));
      const issues = [...findRedactedLeaks(input.flow), ...validateNodes(payloadNodes, { tabId: id })].map((issue) => issue.message);
      return { mode: "flow" as const, added, updated, kept, removed, would_delete: removed.length > 0, issues, node_count_before: currentIds.size, node_count_after: payloadById.size };
    }

    const patch = input.patch ?? {};
    const notFound: string[] = [];
    const removed: string[] = [];
    for (const removeId of patch.remove ?? []) (currentIds.has(removeId) ? removed : notFound).push(removeId);
    const updated: string[] = [];
    for (const item of patch.update ?? []) {
      if (isPlainObject(item) && typeof item.id === "string") (currentIds.has(item.id) ? updated : notFound).push(item.id);
    }
    const added: string[] = [];
    const conflicts: string[] = [];
    for (const item of patch.add ?? []) {
      const nodeId = isPlainObject(item) && typeof item.id === "string" ? item.id : undefined;
      if (nodeId && currentIds.has(nodeId)) conflicts.push(nodeId);
      else added.push(nodeId ?? "(auto-generated id)");
    }
    return {
      mode: "patch" as const, added, updated, removed, not_found: notFound, add_id_conflicts: conflicts,
      node_count_before: currentIds.size,
      node_count_after: currentIds.size + added.length - removed.length,
    };
  }
  /**
   * POST /inject/:id. With no override, replays the node's own configured
   * payload/topic. __user_inject_props__ is Node-RED's own override
   * convention (an array of {p,v,vt} property descriptors) confirmed from
   * the inject node's admin route and its "input" handler.
   */
  triggerInject(id: string, overrideProps?: { p: string; v: string; vt: string }[]) {
    const body = overrideProps?.length ? { __user_inject_props__: overrideProps } : undefined;
    return this.request(`/inject/${flowPathSegment(id)}`, "POST", body, undefined, false, false);
  }
  /** GET /context/:scope[/:id][/key]; scope "global" has no id, "flow"/"node" require one. */
  async getContext(scope: "global" | "flow" | "node", id?: string, key?: string, store?: string, keysOnly?: boolean) {
    if (scope !== "global" && !id) throw new UpstreamError(`Context scope "${scope}" requires an id`, undefined, false, "INVALID_ARGUMENT");
    const base = scope === "global" ? "/context/global" : `/context/${scope}/${flowPathSegment(id!)}`;
    const path = key ? `${base}/${key.split("/").map(encodeURIComponent).join("/")}` : base;
    const params = new URLSearchParams();
    if (store) params.set("store", store);
    if (keysOnly) params.set("keysOnly", "true");
    const query = params.toString();
    return safeJson(await this.request(`${path}${query ? `?${query}` : ""}`));
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
