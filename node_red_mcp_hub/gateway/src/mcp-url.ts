type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function supervisorData(value: unknown): Record<string, unknown> | undefined {
  const result = record(value);
  return record(result?.data) ?? result;
}

function ipv4Address(value: unknown): string | undefined {
  const ipv4 = record(value);
  const direct = typeof ipv4?.ip_address === "string" ? ipv4.ip_address : undefined;
  if (direct) return direct;
  const addresses = Array.isArray(ipv4?.address) ? ipv4.address : [];
  const candidate = addresses.find((entry) => typeof entry === "string" && /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/.test(entry));
  return typeof candidate === "string" ? candidate.split("/", 1)[0] : undefined;
}

/** Return the copyable LAN endpoint without logging the secret. */
export async function publishedMcpUrl(
  secret: string,
  port: string,
  supervisorToken = process.env.SUPERVISOR_TOKEN,
  request: FetchLike = fetch,
): Promise<string | undefined> {
  if (!/^[a-f0-9]{64}$/i.test(secret) || !/^\d{1,5}$/.test(port) || !supervisorToken) return undefined;
  const portNumber = Number(port);
  if (portNumber < 1 || portNumber > 65_535) return undefined;
  try {
    const response = await request("http://supervisor/network/info", {
      headers: { authorization: `Bearer ${supervisorToken}`, accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) return undefined;
    const data = supervisorData(await response.json());
    const interfaces = Array.isArray(data?.interfaces) ? data.interfaces : [];
    const primary = interfaces.map(record).find((network) => network?.primary === true);
    const address = ipv4Address(primary?.ipv4);
    return address ? `http://${address}:${portNumber}/private_${secret}` : undefined;
  } catch {
    return undefined;
  }
}

if (process.argv[1]?.endsWith("mcp-url.js")) {
  const url = await publishedMcpUrl(process.env.MCP_HUB_PATH_SECRET ?? "", process.env.MCP_HUB_PORT ?? "");
  if (url) process.stdout.write(url);
}
