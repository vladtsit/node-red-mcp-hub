import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GatewayConfig } from "./config.js";
import { NodeRedClient, UpstreamError } from "./node-red.js";

const serverId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const flowId = z.string().min(1).max(256);
const deploymentType = z.enum(["nodes", "flows", "full"]).default("flows");

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function error(message: string, status?: number, outcomeUnknown = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: { message, ...(status ? { status } : {}), ...(outcomeUnknown ? { outcome_unknown: true } : {}) } }) }],
    isError: true,
  };
}

type Action = (client: NodeRedClient) => Promise<unknown> | unknown;

export function registerTools(server: McpServer, config: GatewayConfig): void {
  const clients = new Map([...config.servers.entries()].map(([id, target]) => [id, new NodeRedClient(target)]));
  // The SDK's public tool overloads deliberately infer complete JSON schemas.
  // Keep that expensive inference at this boundary; Zod still validates every
  // input at runtime and handlers are otherwise ordinary strict TypeScript.
  type Handler = (args: Record<string, any>) => unknown;
  const add = (name: string, description: string, schema: Record<string, z.ZodTypeAny>, handler: Handler) =>
    (server.tool as unknown as (n: string, d: string, s: Record<string, z.ZodTypeAny>, h: Handler) => void)(name, description, schema, handler);
  const addNoArgs = (name: string, description: string, handler: () => unknown) =>
    (server.tool as unknown as (n: string, d: string, h: () => unknown) => void)(name, description, handler);

  async function call(id: string, action: Action, write = false) {
    const target = config.servers.get(id);
    if (!target) return error("Unknown server_id");
    if (write && (config.readOnly || target.readOnly)) return error("Writes are disabled by read_only configuration");
    try { return result(await action(clients.get(id)!)); }
    catch (caught) {
      if (caught instanceof UpstreamError) return error(caught.message, caught.status, caught.outcomeUnknown);
      return error("Unexpected gateway error");
    }
  }

  addNoArgs("list_servers", "List configured Node-RED targets and their effective read-only state.", async () =>
    result([...config.servers.values()].map((target) => ({ id: target.id, name: target.name, read_only: config.readOnly || target.readOnly }))),
  );
  add("get_flows", "Get the Node-RED v2 flows document, including its rev.", { server_id: serverId }, ({ server_id }) => call(server_id, (client) => client.getFlows()));
  add("get_flow", "Get one Node-RED flow by ID.", { server_id: serverId, flow_id: flowId }, ({ server_id, flow_id }) => call(server_id, (client) => client.getFlow(flow_id)));
  add("get_settings", "Get selected non-secret Node-RED settings.", { server_id: serverId }, ({ server_id }) => call(server_id, (client) => client.getSettings()));
  add("get_diagnostics", "Get Node-RED diagnostics with sensitive host and path values redacted.", { server_id: serverId }, ({ server_id }) => call(server_id, (client) => client.getDiagnostics()));
  add("get_flow_state", "Get Node-RED runtime flow state.", { server_id: serverId }, ({ server_id }) => call(server_id, (client) => client.getFlowState()));
  add("get_installed_modules", "Get installed Node-RED modules.", { server_id: serverId }, ({ server_id }) => call(server_id, (client) => client.getInstalledModules()));

  // Global read-only omits mutation tools from discovery. Per-target protection
  // remains checked at invocation because a tool call selects its target.
  if (config.readOnly) return;
  add("create_flow", "Immediately create one native Node-RED flow.", { server_id: serverId, flow: z.record(z.unknown()) }, ({ server_id, flow }) => call(server_id, (client) => client.createFlow(flow), true));
  add("update_flow", "Immediately update one native Node-RED flow. flow.id must equal flow_id.", { server_id: serverId, flow_id: flowId, flow: z.record(z.unknown()) }, ({ server_id, flow_id, flow }) => {
    if (flow.id !== flow_id) return error("flow.id must match flow_id");
    return call(server_id, (client) => client.updateFlow(flow_id, flow), true);
  });
  add("delete_flow", "Immediately delete one native Node-RED flow.", { server_id: serverId, flow_id: flowId }, ({ server_id, flow_id }) => call(server_id, (client) => client.deleteFlow(flow_id), true));
  add("deploy_flows", "Immediately deploy a full Node-RED graph with the supplied Node-RED rev.", {
    server_id: serverId, flows: z.array(z.record(z.unknown())), rev: z.string().min(1), deployment_type: deploymentType,
  }, ({ server_id, flows, rev, deployment_type }) => call(server_id, (client) => client.deployFlows(flows, rev, deployment_type), true));
}
