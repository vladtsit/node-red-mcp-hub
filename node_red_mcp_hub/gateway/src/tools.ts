import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AuditLog } from "./audit.js";
import { BackupError, BackupManager } from "./backup.js";
import { MAX_IN_FLIGHT, type GatewayConfig } from "./config.js";
import { FlowValidationError, NodeRedClient, UpstreamError } from "./node-red.js";

const serverId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const flowId = z.string().min(1).max(256).refine((id) => id !== "." && id !== "..", "flow_id must not be a dot segment");
const deploymentType = z.enum(["nodes", "flows", "full"]).default("flows");
const query = z.string().min(1).max(256);

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: { data: value } };
}

function error(code: string, message: string, options: { status?: number; outcomeUnknown?: boolean; retryable?: boolean; suggestions?: string[] } = {}) {
  const payload = { error: { code, message, ...(options.status ? { status: options.status } : {}), ...(options.outcomeUnknown ? { outcome_unknown: true } : {}), retryable: options.retryable === true, ...(options.suggestions ? { suggestions: options.suggestions } : {}) } };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

type Action = (client: NodeRedClient) => Promise<unknown> | unknown;
type Handler = (args: Record<string, any>) => unknown;
type Registration = { title: string; description: string; inputSchema?: Record<string, z.ZodTypeAny>; annotations: ToolAnnotations };

class GatewayBusyError extends Error {}

export class GatewayRuntime {
  readonly clients: Map<string, NodeRedClient>;
  readonly backups: BackupManager;
  readonly audit: AuditLog;
  #active = 0;

  constructor(readonly config: GatewayConfig) {
    this.clients = new Map([...config.servers.entries()].map(([id, target]) => [id, new NodeRedClient(target)]));
    this.backups = new BackupManager(config.backupDir, config.backupRetain, config.backupMaxAgeDays, config.backupMaxSizeMb);
    this.audit = new AuditLog(config.auditLogPath);
  }

  async run<T>(action: () => Promise<T> | T): Promise<T> {
    if (this.#active >= MAX_IN_FLIGHT) throw new GatewayBusyError();
    this.#active += 1;
    try { return await action(); }
    finally { this.#active -= 1; }
  }
}

const readAnnotations: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const createAnnotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const writeAnnotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function registerTools(server: McpServer, config: GatewayConfig, runtime: GatewayRuntime): void {
  const register = (name: string, registration: Registration, handler: Handler, mandatory = false) => {
    if (!mandatory && config.disabledTools.has(name)) return;
    (server.registerTool as unknown as (n: string, c: Registration, h: Handler) => void)(name, registration, handler);
  };

  async function call(toolName: string, id: string, action: Action, write = false, flowIdForAudit?: string) {
    const target = config.servers.get(id);
    if (!target) return error("UNKNOWN_SERVER", "Unknown server_id");
    if (target.disabledTools.has(toolName)) return error("TOOL_DISABLED", `${toolName} is disabled for this server`);
    if (write && (config.readOnly || target.readOnly)) return error("READ_ONLY", "Writes are disabled by read_only configuration");
    let backupFile: string | undefined;
    try {
      const value = await runtime.run(async () => {
        const client = runtime.clients.get(id)!;
        if (write && config.backupBeforeWrite) backupFile = await runtime.backups.capture(target, client, toolName);
        return action(client);
      });
      if (write) await runtime.audit.record({ server_id: id, tool: toolName, outcome: "ok", flow_id: flowIdForAudit, backup_file: backupFile });
      return result(value);
    } catch (caught) {
      if (write) await runtime.audit.record({ server_id: id, tool: toolName, outcome: "error", flow_id: flowIdForAudit, backup_file: backupFile, detail: caught instanceof Error ? caught.message : "unknown error" });
      if (caught instanceof GatewayBusyError) return error("BUSY", "Gateway is busy; retry later", { retryable: true });
      if (caught instanceof BackupError) return error("BACKUP_FAILED", caught.message, { suggestions: ["Resolve backup storage access or disable backup_before_write explicitly."] });
      if (caught instanceof FlowValidationError) return error("VALIDATION_FAILED", caught.message, { suggestions: caught.issues });
      if (caught instanceof UpstreamError) return error(caught.code, caught.message, { status: caught.status, outcomeUnknown: caught.outcomeUnknown, retryable: caught.retryable, suggestions: caught.code === "REDEPLOY_FAILED" && backupFile ? [`Pre-write backup saved as ${backupFile}.`] : undefined });
      return error("INTERNAL_ERROR", "Unexpected gateway error");
    }
  }

  register("list_servers", { title: "List Node-RED Servers", description: "List configured Node-RED targets and their effective safety settings.", inputSchema: {}, annotations: readAnnotations }, async () => result([...config.servers.values()].map((target) => ({ id: target.id, name: target.name, read_only: config.readOnly || target.readOnly, disabled_tools: [...target.disabledTools].sort() }))), true);

  register("check_servers", { title: "Check Node-RED Servers", description: "Check target reachability and authentication without returning flow content.", inputSchema: {}, annotations: readAnnotations }, async () => {
    const checks = await Promise.all([...config.servers.entries()].map(async ([id, target]) => {
      try { return { id, name: target.name, ...await runtime.run(() => runtime.clients.get(id)!.checkStatus()) }; }
      catch (caught) {
        if (caught instanceof GatewayBusyError) return { id, name: target.name, ok: false, error: { code: "BUSY", message: "Gateway is busy; retry later", retryable: true } };
        if (caught instanceof UpstreamError) return { id, name: target.name, ok: false, error: { code: caught.code, message: caught.message, ...(caught.status ? { status: caught.status } : {}) } };
        return { id, name: target.name, ok: false, error: { code: "INTERNAL_ERROR", message: "Unexpected gateway error" } };
      }
    }));
    return result(checks);
  });

  register("list_flows", { title: "List Flow Summaries", description: "List tabs and subflows with node counts without returning node configuration or Function code.", inputSchema: { server_id: serverId }, annotations: readAnnotations }, ({ server_id }) => call("list_flows", server_id, (client) => client.listFlows()));
  register("search_nodes", { title: "Search Nodes", description: "Search safe Node-RED node metadata without returning node configuration or Function code.", inputSchema: { server_id: serverId, query, flow_id: flowId.optional(), limit: z.number().int().min(1).max(100).default(25) }, annotations: readAnnotations }, ({ server_id, query: value, flow_id, limit }) => call("search_nodes", server_id, (client) => client.searchNodes(value, limit, flow_id)));
  register("get_flows", { title: "Export All Flows", description: "Get the complete Node-RED v2 flows document. Flow definitions and Function code may contain sensitive values; prefer list_flows or get_flow.", inputSchema: { server_id: serverId }, annotations: readAnnotations }, ({ server_id }) => call("get_flows", server_id, (client) => client.getFlows(config.redactSecrets)));
  register("get_flow", { title: "Get One Flow", description: "Get one Node-RED flow by ID. The definition may contain sensitive values.", inputSchema: { server_id: serverId, flow_id: flowId }, annotations: readAnnotations }, ({ server_id, flow_id }) => call("get_flow", server_id, (client) => client.getFlow(flow_id, config.redactSecrets)));
  register("get_settings", { title: "Get Node-RED Settings", description: "Get selected non-secret Node-RED settings.", inputSchema: { server_id: serverId }, annotations: readAnnotations }, ({ server_id }) => call("get_settings", server_id, (client) => client.getSettings()));
  register("get_diagnostics", { title: "Get Node-RED Diagnostics", description: "Get diagnostics with sensitive host, path, and credential values redacted.", inputSchema: { server_id: serverId }, annotations: readAnnotations }, ({ server_id }) => call("get_diagnostics", server_id, (client) => client.getDiagnostics()));
  register("get_flow_state", { title: "Get Runtime State", description: "Get the Node-RED runtime flow state.", inputSchema: { server_id: serverId }, annotations: readAnnotations }, ({ server_id }) => call("get_flow_state", server_id, (client) => client.getFlowState()));
  register("get_installed_modules", { title: "Get Installed Modules", description: "Get installed Node-RED modules.", inputSchema: { server_id: serverId }, annotations: readAnnotations }, ({ server_id }) => call("get_installed_modules", server_id, (client) => client.getInstalledModules()));

  register("get_context", { title: "Get Context", description: "Read Node-RED global/flow/node context store values. Context can hold arbitrary runtime state and may contain sensitive values.", inputSchema: { server_id: serverId, scope: z.enum(["global", "flow", "node"]), id: z.string().min(1).max(256).optional(), key: z.string().min(1).max(256).optional(), store: z.string().min(1).max(64).optional(), keys_only: z.boolean().default(false) }, annotations: readAnnotations }, ({ server_id, scope, id, key, store, keys_only }) => {
    if (scope !== "global" && !id) return error("INVALID_ARGUMENT", `Context scope "${scope}" requires id`);
    return call("get_context", server_id, (client) => client.getContext(scope, id, key, store, keys_only));
  });

  register("list_backups", { title: "List Backups", description: "List retained pre-write backup snapshots for a server, newest first. Does not return their content.", inputSchema: { server_id: serverId }, annotations: readAnnotations }, async ({ server_id }) => {
    const target = config.servers.get(server_id);
    if (!target) return error("UNKNOWN_SERVER", "Unknown server_id");
    try { return result(await runtime.run(() => runtime.backups.list(target))); }
    catch (caught) {
      if (caught instanceof GatewayBusyError) return error("BUSY", "Gateway is busy; retry later", { retryable: true });
      return error("INTERNAL_ERROR", "Unexpected gateway error");
    }
  });

  register("preview_flow_change", { title: "Preview Flow Change", description: "Dry-run diff of a would-be update_flow (full \"flow\") or patch_flow (\"patch\" add/update/remove) against the current tab. Writes nothing; use this to confirm the exact change with the user before calling update_flow/patch_flow, especially to catch accidental deletions.", inputSchema: { server_id: serverId, flow_id: flowId, flow: z.record(z.unknown()).optional(), patch: z.object({ add: z.array(z.record(z.unknown())).max(50).optional(), update: z.array(z.record(z.unknown())).max(50).optional(), remove: z.array(z.string().min(1)).max(200).optional() }).optional() }, annotations: readAnnotations }, ({ server_id, flow_id, flow, patch }) => {
    if (!flow === !patch) return error("INVALID_ARGUMENT", 'Provide exactly one of "flow" or "patch"');
    return call("preview_flow_change", server_id, (client) => client.previewFlowChange(flow_id, { flow, patch }));
  });

  if (config.readOnly) return;
  register("create_flow", { title: "Create Flow", description: "Immediately create one native Node-RED flow after taking a configured pre-write backup. Confirm the exact change with the user before calling this. Each node's wires must be an array of arrays (one per output port, e.g. [[\"targetId\"]]); a flattened [\"targetId\"] fails silently.", inputSchema: { server_id: serverId, flow: z.record(z.unknown()) }, annotations: createAnnotations }, ({ server_id, flow }) => call("create_flow", server_id, (client) => client.createFlow(flow), true, typeof flow.id === "string" ? flow.id : undefined));
  register("update_flow", { title: "Update Flow", description: "Immediately update one native Node-RED flow after taking a configured pre-write backup. flow.id must equal flow_id. Confirm the exact change with the user before calling this. This REPLACES the whole tab: get_flow first and send every node back, since any omitted node is deleted, and preserve the separate configs array. Each node's wires must be an array of arrays (one per output port, e.g. [[\"targetId\"]]); a flattened [\"targetId\"] fails silently. Never send back a \"[redacted]\" value from a read; omit that property instead. Optionally pass expected_rev (from get_flows) to reject the write if flows changed since you read them.", inputSchema: { server_id: serverId, flow_id: flowId, flow: z.record(z.unknown()), expected_rev: z.string().min(1).optional() }, annotations: writeAnnotations }, ({ server_id, flow_id, flow, expected_rev }) => {
    if (flow.id !== flow_id) return error("INVALID_ARGUMENT", "flow.id must match flow_id");
    return call("update_flow", server_id, (client) => client.updateFlow(flow_id, flow, expected_rev), true, flow_id);
  });
  register("patch_flow", { title: "Patch Flow", description: "Add, update, or remove specific nodes within one flow tab, without needing to resend the whole tab. Existing nodes not mentioned are preserved automatically, and stored secrets are never round-tripped through you. Confirm the exact change with the user before calling this. Not for adding groups or subflow definitions; use update_flow for those.", inputSchema: { server_id: serverId, flow_id: flowId, add: z.array(z.record(z.unknown())).max(50).optional(), update: z.array(z.record(z.unknown())).max(50).optional(), remove: z.array(z.string().min(1)).max(200).optional() }, annotations: writeAnnotations }, ({ server_id, flow_id, add, update, remove }) => call("patch_flow", server_id, (client) => client.patchFlow(flow_id, { add, update, remove }), true, flow_id));
  register("delete_flow", { title: "Delete Flow", description: "Immediately delete one native Node-RED flow after taking a configured pre-write backup. Confirm with the user, naming the exact flow, before calling this; deletions are destructive. Optionally pass expected_rev (from get_flows) to reject the delete if flows changed since you read them.", inputSchema: { server_id: serverId, flow_id: flowId, expected_rev: z.string().min(1).optional() }, annotations: writeAnnotations }, ({ server_id, flow_id, expected_rev }) => call("delete_flow", server_id, (client) => client.deleteFlow(flow_id, expected_rev), true, flow_id));
  register("deploy_flows", { title: "Deploy Full Flow Graph", description: "Immediately deploy a full Node-RED graph with revision protection after taking a configured pre-write backup. Confirm the exact change with the user before calling this. Each node's wires must be an array of arrays (one per output port, e.g. [[\"targetId\"]]); a flattened [\"targetId\"] fails silently.", inputSchema: { server_id: serverId, flows: z.array(z.record(z.unknown())), rev: z.string().min(1), deployment_type: deploymentType }, annotations: writeAnnotations }, ({ server_id, flows, rev, deployment_type }) => call("deploy_flows", server_id, (client) => client.deployFlows(flows, rev, deployment_type), true));
  register("trigger_inject", { title: "Trigger Inject Node", description: "Immediately fire one inject node's \"input\" event, the same as clicking its button in the editor, so a flow can be tested end-to-end without asking the user to click it. Confirm with the user before calling this if the flow has side effects (e.g. controls a device). Optional override_props replaces the node's own configured payload/topic for this one trigger only, using Node-RED's own {p,v,vt} property-override format.", inputSchema: { server_id: serverId, node_id: z.string().min(1).max(256), override_props: z.array(z.object({ p: z.string().min(1), v: z.string(), vt: z.string().min(1) })).max(20).optional() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }, ({ server_id, node_id, override_props }) => call("trigger_inject", server_id, (client) => client.triggerInject(node_id, override_props), false, node_id));
  register("create_subflow", { title: "Create Subflow", description: "Immediately create an empty native Node-RED subflow container (not its internal nodes) after taking a configured pre-write backup. Confirm with the user before calling this. Add internal nodes afterward with patch_flow/update_flow scoped to the returned subflow id, then update_flow again to wire the in/out ports to those nodes.", inputSchema: { server_id: serverId, name: z.string().min(1).max(256), category: z.string().min(1).max(64).optional(), info: z.string().max(10_000).optional(), inputs: z.number().int().min(0).max(10).default(0), outputs: z.number().int().min(0).max(10).default(1), env: z.array(z.object({ name: z.string().min(1), type: z.string().min(1), value: z.string() })).max(50).optional() }, annotations: createAnnotations }, ({ server_id, name, category, info, inputs, outputs, env }) => {
    const id = randomBytes(8).toString("hex");
    const flow = {
      id, type: "subflow", name, category: category ?? "subflows", info: info ?? "",
      in: Array.from({ length: inputs }, (_, index) => ({ x: 40, y: 40 + index * 60, wires: [] })),
      out: Array.from({ length: outputs }, (_, index) => ({ x: 300, y: 40 + index * 60, wires: [], id: randomBytes(8).toString("hex") })),
      env: env ?? [],
    };
    return call("create_subflow", server_id, (client) => client.createFlow(flow), true);
  });
}

export function registerResourcesAndPrompts(server: McpServer, config: GatewayConfig, runtime: GatewayRuntime): void {
  if (config.disabledTools.has("get_flow")) return;

  server.registerResource(
    "flow",
    new ResourceTemplate("flow://{server_id}/{flow_id}", {
      list: async () => {
        const perServer = await Promise.all([...config.servers.entries()].map(async ([id, target]) => {
          try {
            const summary = await runtime.run(() => runtime.clients.get(id)!.listFlows()) as { flows: { id: string; label: string }[] };
            return summary.flows.map((flow) => ({ uri: `flow://${id}/${flow.id}`, name: `${target.name}: ${flow.label || flow.id}`, mimeType: "application/json" }));
          } catch { return []; }
        }));
        return { resources: perServer.flat() };
      },
    }),
    { title: "Node-RED Flow", description: "A single Node-RED tab or subflow, redacted the same way as get_flow.", mimeType: "application/json" },
    async (uri, variables) => {
      const serverIdValue = String(variables.server_id);
      const flowIdValue = String(variables.flow_id);
      const client = runtime.clients.get(serverIdValue);
      if (!client) throw new Error(`Unknown server_id "${serverIdValue}"`);
      const data = await runtime.run(() => client.getFlow(flowIdValue, config.redactSecrets));
      return { contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(data) }] };
    },
  );

  server.registerPrompt(
    "add_inject_debug_pair",
    {
      title: "Add a manual test inject/debug pair",
      description: "Guides safely adding a manual-trigger inject node wired to a debug node for testing a flow.",
      argsSchema: { server_id: z.string(), flow_id: z.string() },
    },
    ({ server_id, flow_id }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Add a manual test inject/debug pair to flow "${flow_id}" on server "${server_id}".

Use patch_flow with two "add" entries: an inject node ("once": false, no "repeat"/"crontab" so it never fires on its own) and a debug node ("tostatus": true), both with "z" set to "${flow_id}". Wire the inject node to the debug node using "wires": [["<debugNodeId>"]] — this MUST be an array of arrays; a flattened ["<debugNodeId>"] fails silently. Give both nodes their own random 16-character lowercase hex "id" and a descriptive "name". Confirm the exact change with the user before calling patch_flow, then re-read with get_flow to confirm the wiring landed as intended.`,
        },
      }],
    }),
  );

  server.registerPrompt(
    "diagnose_silent_failure",
    {
      title: "Diagnose a flow that silently does nothing",
      description: "A checklist for diagnosing a Node-RED flow that appears to run but produces no visible effect.",
      argsSchema: { server_id: z.string(), flow_id: z.string() },
    },
    ({ server_id, flow_id }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Flow "${flow_id}" on server "${server_id}" appears to run without any visible effect. Use get_flow to read its current definition, then check, in order:
1. Every node's "wires" is an array of arrays (e.g. [["targetId"]]), not a flattened array of id strings — the single most common silent failure.
2. Every wire target id actually exists in this flow (a typo'd or stale id silently drops the message).
3. Every node's "z" equals "${flow_id}" and no node is unexpectedly "disabled"/"d": true.
4. Whether a catch node is present to surface runtime errors; if not, add one scoped to the relevant nodes so future failures are not silent either.
Report back which of these you found before proposing a fix, and confirm the exact change with the user before writing it.`,
        },
      }],
    }),
  );
}

