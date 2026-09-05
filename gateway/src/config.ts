import { readFile } from "node:fs/promises";

export const PORT = 51844;
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_IN_FLIGHT = 20;

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
};

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
  return parseConfig(input);
}
