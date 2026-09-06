import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BackupError, BackupManager } from "./backup.js";
import { MAX_IN_FLIGHT, type GatewayConfig } from "./config.js";
import { NodeRedClient, UpstreamError } from "./node-red.js";

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
  #active = 0;

  constructor(readonly config: GatewayConfig) {
    this.clients = new Map([...config.servers.entries()].map(([id, target]) => [id, new NodeRedClient(target)]));
    this.backups = new BackupManager(config.backupDir, config.backupRetain);
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

  async function call(toolName: string, id: string, action: Action, write = false) {
    const target = config.servers.get(id);
    if (!target) return error("UNKNOWN_SERVER", "Unknown server_id");
    if (target.disabledTools.has(toolName)) return error("TOOL_DISABLED", `${toolName} is disabled for this server`);
    if (write && (config.readOnly || target.readOnly)) return error("READ_ONLY", "Writes are disabled by read_only configuration");
    try {
      return result(await runtime.run(async () => {
        const client = runtime.clients.get(id)!;
        if (write && config.backupBeforeWrite) await runtime.backups.capture(target, client, toolName);
        return action(client);
      }));
    } catch (caught) {
      if (caught instanceof GatewayBusyError) return error("BUSY", "Gateway is busy; retry later", { retryable: true });
      if (caught instanceof BackupError) return error("BACKUP_FAILED", caught.message, { suggestions: ["Resolve backup storage access or disable backup_before_write explicitly."] });
      if (caught instanceof UpstreamError) return error(caught.code, caught.message, { status: caught.status, outcomeUnknown: caught.outcomeUnknown, retryable: caught.retryable });
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

  if (config.readOnly) return;
  register("create_flow", { title: "Create Flow", description: "Immediately create one native Node-RED flow after taking a configured pre-write backup. Confirm the exact change with the user before calling this. Each node's wires must be an array of arrays (one per output port, e.g. [[\"targetId\"]]); a flattened [\"targetId\"] fails silently.", inputSchema: { server_id: serverId, flow: z.record(z.unknown()) }, annotations: createAnnotations }, ({ server_id, flow }) => call("create_flow", server_id, (client) => client.createFlow(flow), true));
  register("update_flow", { title: "Update Flow", description: "Immediately update one native Node-RED flow after taking a configured pre-write backup. flow.id must equal flow_id. Confirm the exact change with the user before calling this. Each node's wires must be an array of arrays (one per output port, e.g. [[\"targetId\"]]); a flattened [\"targetId\"] fails silently.", inputSchema: { server_id: serverId, flow_id: flowId, flow: z.record(z.unknown()) }, annotations: writeAnnotations }, ({ server_id, flow_id, flow }) => {
    if (flow.id !== flow_id) return error("INVALID_ARGUMENT", "flow.id must match flow_id");
    return call("update_flow", server_id, (client) => client.updateFlow(flow_id, flow), true);
  });
  register("delete_flow", { title: "Delete Flow", description: "Immediately delete one native Node-RED flow after taking a configured pre-write backup. Confirm with the user, naming the exact flow, before calling this; deletions are destructive.", inputSchema: { server_id: serverId, flow_id: flowId }, annotations: writeAnnotations }, ({ server_id, flow_id }) => call("delete_flow", server_id, (client) => client.deleteFlow(flow_id), true));
  register("deploy_flows", { title: "Deploy Full Flow Graph", description: "Immediately deploy a full Node-RED graph with revision protection after taking a configured pre-write backup. Confirm the exact change with the user before calling this. Each node's wires must be an array of arrays (one per output port, e.g. [[\"targetId\"]]); a flattened [\"targetId\"] fails silently.", inputSchema: { server_id: serverId, flows: z.array(z.record(z.unknown())), rev: z.string().min(1), deployment_type: deploymentType }, annotations: writeAnnotations }, ({ server_id, flows, rev, deployment_type }) => call("deploy_flows", server_id, (client) => client.deployFlows(flows, rev, deployment_type), true));
}
