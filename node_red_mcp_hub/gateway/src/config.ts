import { readFile } from "node:fs/promises";

export const PORT = 51844;
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_IN_FLIGHT = 20;
const SUPERVISOR_DISCOVERY_TIMEOUT_MS = 5_000;
const NODE_RED_INTERNAL_PORT = 1880;
export const DEFAULT_BACKUP_DIR = "/data/backups";

export type AuthMode = "credentials" | "bearer" | "basic" | "none";

export interface TargetConfig {
  id: string;
  name: string;
  /** Admin API origin plus optional admin-root prefix, with no trailing slash. */
  baseUrl: URL;
  authMode: AuthMode;
  username?: string;
  password?: string;
  token?: string;
  readOnly: boolean;
  disabledTools: Set<string>;
}

export interface GatewayConfig {
  pathSecret: string;
  readOnly: boolean;
  redactSecrets: boolean;
  backupBeforeWrite: boolean;
  backupRetain: number;
  backupDir: string;
  disabledTools: Set<string>;
  servers: Map<string, TargetConfig>;
}

type RawOptions = {
  mcp_path_secret?: unknown;
  read_only?: unknown;
  servers?: unknown;
  home_assistant_node_red?: unknown;
  redact_secrets?: unknown;
  backup_before_write?: unknown;
  backup_retain?: unknown;
  disabled_tools?: unknown;
};

type LocalNodeRedOptions = {
  enabled: boolean;
  url?: string;
  username?: string;
  password?: string;
  readOnly: boolean;
};

type SupervisorFetch = (input: string, init?: RequestInit) => Promise<Response>;

const ID = /^[a-z][a-z0-9_-]{0,31}$/;
const SECRET = /^[a-f0-9]{64}$/i;
const AUTH_MODES = new Set<AuthMode>(["credentials", "bearer", "basic", "none"]);
const TOOL_NAMES = new Set([
  "list_servers", "check_servers", "list_flows", "search_nodes", "get_flows", "get_flow",
  "get_settings", "get_diagnostics", "get_flow_state", "get_installed_modules", "create_flow",
  "update_flow", "delete_flow", "deploy_flows",
]);

function fail(message: string): never {
  throw new Error(`Invalid add-on options: ${message}`);
}

function stringField(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") fail(`${field} must be a string`);
  return value;
}

function targetUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(`${field} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(`${field} must use http or https`);
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    fail(`${field} must not contain credentials, query parameters, or a fragment`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "";
  return url;
}

function optionalString(value: unknown, field: string): string | undefined {
  return stringField(value, field, false);
}

function localNodeRedOptions(input: RawOptions): LocalNodeRedOptions {
  if (input.home_assistant_node_red === undefined || input.home_assistant_node_red === null) {
    return { enabled: false, readOnly: true };
  }
  if (typeof input.home_assistant_node_red !== "object" || Array.isArray(input.home_assistant_node_red)) {
    fail("home_assistant_node_red must be an object");
  }
  const value = input.home_assistant_node_red as Record<string, unknown>;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    fail("home_assistant_node_red.enabled must be a boolean");
  }
  if (value.read_only !== undefined && typeof value.read_only !== "boolean") {
    fail("home_assistant_node_red.read_only must be a boolean");
  }
  return {
    enabled: value.enabled === true,
    url: optionalString(value.url, "home_assistant_node_red.url"),
    username: optionalString(value.username, "home_assistant_node_red.username"),
    password: optionalString(value.password, "home_assistant_node_red.password"),
    readOnly: value.read_only !== false,
  };
}

function boolOption(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(`${field} must be a boolean`);
  return value;
}

function intOption(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function toolSet(value: unknown, field: string): Set<string> {
  if (value === undefined || value === null || value === "") return new Set();
  if (typeof value !== "string") fail(`${field} must be a comma-separated string`);
  const tools = new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
  for (const tool of tools) {
    if (!TOOL_NAMES.has(tool)) fail(`${field} contains unknown tool ${tool}`);
    if (tool === "list_servers") fail(`${field} cannot disable the mandatory list_servers tool`);
  }
  return tools;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function supervisorData(value: unknown): Record<string, unknown> | undefined {
  const result = record(value);
  return record(result?.data) ?? result;
}

function localNodeRedCandidate(addons: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(addons)) return undefined;
  const candidates = addons.filter(record).filter((addon) => {
    const name = typeof addon.name === "string" ? addon.name.toLowerCase() : "";
    const slug = typeof addon.slug === "string" ? addon.slug.toLowerCase() : "";
    return name === "node-red" || slug === "nodered" || slug.endsWith("_nodered");
  });
  return candidates.find((addon) => addon.state === "started") ?? candidates[0];
}

function primaryIpv4(info: Record<string, unknown> | undefined): string | undefined {
  const interfaces = Array.isArray(info?.interfaces) ? info.interfaces.map(record) : [];
  const primary = interfaces.find((item) => item?.primary === true);
  const ipv4 = record(primary?.ipv4);
  const addresses = Array.isArray(ipv4?.address) ? ipv4.address : [];
  const value = addresses.find((item) => typeof item === "string" && /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/.test(item));
  return typeof value === "string" ? value.split("/", 1)[0] : undefined;
}

function portNumber(value: unknown): number | undefined {
  const port = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * Supervisor reports a container-port to host-port map such as
 * `{ "1880/tcp": 1880 }`. Node-RED's own port is preferred; any other single
 * mapping is accepted so a relocated Admin API still resolves.
 */
function networkPorts(info: Record<string, unknown>): { internal: number; published?: number } {
  const network = record(info.network) ?? {};
  const mappings: { internal: number; published?: number }[] = [];
  for (const [container, host] of Object.entries(network)) {
    const internal = portNumber(container.split("/", 1)[0]);
    if (internal !== undefined) mappings.push({ internal, published: portNumber(host) });
  }
  return mappings.find((mapping) => mapping.internal === NODE_RED_INTERNAL_PORT)
    ?? mappings[0]
    ?? { internal: NODE_RED_INTERNAL_PORT };
}

/**
 * Prefer the Home Assistant LAN address plus Node-RED's published host port so
 * the target stays reachable from an app container, and fall back to the
 * Supervisor-internal address when Node-RED publishes no host port.
 */
function discoveredUrl(info: Record<string, unknown>, hostAddress?: string): string | undefined {
  const { internal, published } = networkPorts(info);
  if (hostAddress && published !== undefined) return `http://${hostAddress}:${published}`;
  const address = typeof info.ip_address === "string" && info.ip_address ? info.ip_address : undefined;
  return address ? `http://${address}:${internal}` : undefined;
}

async function supervisorJson(path: string, token: string, request: SupervisorFetch): Promise<Record<string, unknown> | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPERVISOR_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await request(`http://supervisor${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return undefined;
    return supervisorData(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Add the Home Assistant Community Node-RED app as a read-only target when it
 * is available. Supervisor metadata supplies only the URL; the user supplies
 * Home Assistant Basic credentials because the official proxy does not accept
 * long-lived bearer tokens.
 */
export async function discoverHomeAssistantNodeRed(
  input: RawOptions,
  request: SupervisorFetch = fetch,
  supervisorToken = process.env.SUPERVISOR_TOKEN,
): Promise<RawOptions> {
  const local = localNodeRedOptions(input);
  if (!local.enabled) return input;
  if (!local.username || !local.password) {
    fail("home_assistant_node_red requires username and password when enabled");
  }
  const manualServers = Array.isArray(input.servers) ? input.servers : [];
  const ids = new Set(manualServers.flatMap((server) => {
    const value = record(server);
    return typeof value?.id === "string" ? [value.id] : [];
  }));
  if (ids.has("home_assistant_node_red")) return input;
  if (manualServers.length >= 20) fail("home_assistant_node_red cannot be added because servers already contains 20 targets");

  let baseUrl = local.url;
  let name = "Home Assistant Node-RED";
  if (!baseUrl) {
    if (!supervisorToken) fail("home_assistant_node_red could not discover Node-RED; set its url explicitly");
    const addons = await supervisorJson("/addons", supervisorToken, request);
    const addon = localNodeRedCandidate(addons?.addons);
    const slug = typeof addon?.slug === "string" ? addon.slug : undefined;
    if (!slug) fail("home_assistant_node_red could not find an installed Node-RED app; set home_assistant_node_red.url instead");
    const info = await supervisorJson(`/addons/${encodeURIComponent(slug)}/info`, supervisorToken, request);
    if (!info) fail("home_assistant_node_red could not read Node-RED app metadata; set home_assistant_node_red.url instead");
    const network = await supervisorJson("/network/info", supervisorToken, request);
    baseUrl = discoveredUrl(info, primaryIpv4(network));
    if (typeof info.name === "string" && info.name) name = info.name;
  }
  if (!baseUrl) fail("home_assistant_node_red could not determine the Node-RED Admin API URL; set home_assistant_node_red.url instead");

  return {
    ...input,
    servers: [
      ...manualServers,
      {
        id: "home_assistant_node_red",
        name,
        url: baseUrl,
        auth_mode: "basic",
        username: local.username,
        password: local.password,
        read_only: local.readOnly,
      },
    ],
  };
}

export function parseConfig(input: RawOptions): GatewayConfig {
  const pathSecret = stringField(input.mcp_path_secret, "mcp_path_secret")!;
  if (!SECRET.test(pathSecret)) fail("mcp_path_secret must be 64 hexadecimal characters (32 random bytes)");
  if (typeof input.read_only !== "boolean") fail("read_only must be a boolean");
  if (!Array.isArray(input.servers) || input.servers.length < 1 || input.servers.length > 20) {
    fail("servers must contain between 1 and 20 targets");
  }

  const servers = new Map<string, TargetConfig>();
  for (const [index, raw] of input.servers.entries()) {
    const field = `servers[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${field} must be an object`);
    const row = raw as Record<string, unknown>;
    const id = stringField(row.id, `${field}.id`)!;
    if (!ID.test(id)) fail(`${field}.id must match ${ID}`);
    if (servers.has(id)) fail(`${field}.id duplicates ${id}`);
    const name = stringField(row.name, `${field}.name`)!;
    const authMode = stringField(row.auth_mode, `${field}.auth_mode`)! as AuthMode;
    if (!AUTH_MODES.has(authMode)) fail(`${field}.auth_mode is unsupported`);
    if (row.read_only !== undefined && typeof row.read_only !== "boolean") fail(`${field}.read_only must be a boolean`);
    const username = stringField(row.username, `${field}.username`, false);
    const password = stringField(row.password, `${field}.password`, false);
    const token = stringField(row.token, `${field}.token`, false);
    const disabledTools = toolSet(row.disabled_tools, `${field}.disabled_tools`);
    if ((authMode === "credentials" || authMode === "basic") && (!username || !password)) {
      fail(`${field} requires username and password for ${authMode} authentication`);
    }
    if (authMode === "bearer" && !token) fail(`${field} requires token for bearer authentication`);
    servers.set(id, {
      id, name, baseUrl: targetUrl(stringField(row.url, `${field}.url`)!, `${field}.url`), authMode,
      username, password, token, readOnly: row.read_only === true, disabledTools,
    });
  }
  return {
    pathSecret,
    readOnly: input.read_only,
    redactSecrets: boolOption(input.redact_secrets, "redact_secrets", true),
    backupBeforeWrite: boolOption(input.backup_before_write, "backup_before_write", true),
    backupRetain: intOption(input.backup_retain, "backup_retain", 20, 1, 1000),
    backupDir: process.env.BACKUP_DIR ?? DEFAULT_BACKUP_DIR,
    disabledTools: toolSet(input.disabled_tools, "disabled_tools"),
    servers,
  };
}

export async function loadConfig(optionsPath = process.env.OPTIONS_PATH ?? "/run/node-red-mcp-hub/options.json"): Promise<GatewayConfig> {
  let input: RawOptions;
  try {
    input = JSON.parse(await readFile(optionsPath, "utf8")) as RawOptions;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Could not load add-on options: ${detail}`);
  }
  return parseConfig(await discoverHomeAssistantNodeRed(input));
}
