import { readFile } from "node:fs/promises";

export const PORT = 51844;
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_IN_FLIGHT = 20;
const SUPERVISOR_DISCOVERY_TIMEOUT_MS = 5_000;

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
}

export interface GatewayConfig {
  pathSecret: string;
  readOnly: boolean;
  servers: Map<string, TargetConfig>;
}

type RawOptions = {
  mcp_path_secret?: unknown;
  read_only?: unknown;
  servers?: unknown;
  home_assistant_node_red?: unknown;
};

type LocalNodeRedOptions = {
  enabled: boolean;
  token?: string;
  url?: string;
};

type SupervisorFetch = (input: string, init?: RequestInit) => Promise<Response>;

const ID = /^[a-z][a-z0-9_-]{0,31}$/;
const SECRET = /^[a-f0-9]{64}$/i;
const AUTH_MODES = new Set<AuthMode>(["credentials", "bearer", "basic", "none"]);

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
    return { enabled: true };
  }
  if (typeof input.home_assistant_node_red !== "object" || Array.isArray(input.home_assistant_node_red)) {
    fail("home_assistant_node_red must be an object");
  }
  const value = input.home_assistant_node_red as Record<string, unknown>;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    fail("home_assistant_node_red.enabled must be a boolean");
  }
  return {
    enabled: value.enabled !== false,
    token: optionalString(value.token, "home_assistant_node_red.token"),
    url: optionalString(value.url, "home_assistant_node_red.url"),
  };
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

function discoveredUrl(info: Record<string, unknown>): string | undefined {
  const address = typeof info.ip_address === "string" ? info.ip_address : undefined;
  if (!address) return undefined;
  const network = record(info.network);
  const configuredPort = network?.["80/tcp"];
  const port = typeof configuredPort === "number" || typeof configuredPort === "string"
    ? Number(configuredPort)
    : info.host_network === true ? 1880 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return `http://${address}:${port}`;
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
 * Add the official Home Assistant Node-RED app as a read-only target when it
 * is available. A user-provided Home Assistant access token is deliberately
 * required: the hub never reads another app's options or credentials.
 */
export async function discoverHomeAssistantNodeRed(
  input: RawOptions,
  request: SupervisorFetch = fetch,
  supervisorToken = process.env.SUPERVISOR_TOKEN,
): Promise<RawOptions> {
  const local = localNodeRedOptions(input);
  if (!local.enabled || !local.token) return input;
  const manualServers = Array.isArray(input.servers) ? input.servers : [];
  const ids = new Set(manualServers.flatMap((server) => {
    const value = record(server);
    return typeof value?.id === "string" ? [value.id] : [];
  }));
  if (ids.has("home_assistant_node_red") || manualServers.length >= 20) return input;

  let baseUrl = local.url;
  let name = "Home Assistant Node-RED";
  if (!baseUrl) {
    if (!supervisorToken) return input;
    const addons = await supervisorJson("/addons", supervisorToken, request);
    const addon = localNodeRedCandidate(addons?.addons);
    const slug = typeof addon?.slug === "string" ? addon.slug : undefined;
    if (!slug) return input;
    const info = await supervisorJson(`/addons/${encodeURIComponent(slug)}/info`, supervisorToken, request);
    if (!info) return input;
    baseUrl = discoveredUrl(info);
    if (typeof info.name === "string" && info.name) name = info.name;
  }
  if (!baseUrl) return input;

  return {
    ...input,
    servers: [
      ...manualServers,
      {
        id: "home_assistant_node_red",
        name,
        url: baseUrl,
        auth_mode: "bearer",
        token: local.token,
        read_only: true,
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
    if ((authMode === "credentials" || authMode === "basic") && (!username || !password)) {
      fail(`${field} requires username and password for ${authMode} authentication`);
    }
    if (authMode === "bearer" && !token) fail(`${field} requires token for bearer authentication`);
    servers.set(id, {
      id, name, baseUrl: targetUrl(stringField(row.url, `${field}.url`)!, `${field}.url`), authMode,
      username, password, token, readOnly: row.read_only === true,
    });
  }
  return { pathSecret, readOnly: input.read_only, servers };
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
