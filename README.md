# Node-RED MCP Hub

A small Home Assistant app wrapping multiple Node-RED Admin APIs through one MCP endpoint.

HTTP port **51844** references Morse's 1844 Washington–Baltimore telegraph demonstration. [Library of Congress](https://www.loc.gov/item/mcc00054/)

Planned URL: http://192.168.3.57:51844/private_<secret>, with URL-only access for trusted LAN clients.

- [Simple architecture and API tool mapping](BUILDING_A_MULTI_NODE_RED_MCP_HOME_ASSISTANT_APP.md)
- [Developer instructions](DEVELOPER_GUIDE.md)
- [What was simplified](ARCHITECTURE_REVIEW.md)

No database, flow history or approval workflow. Node-RED owns the flows; the hub forwards requests.

Slug: node_red_mcp_hub. Repository: home-assistant-node-red-mcp-hub. Configure the final GHCR image name when publishing.

Status: implementation complete. The Home Assistant add-on, strict TypeScript
gateway, focused integration tests, and CI workflow are included. See the
[add-on documentation](node_red_mcp_hub/DOCS.md) for installation and client
configuration.

## Installation

### Before you begin

You need a working Home Assistant instance, at least one Node-RED instance with
its **Admin API** reachable from Home Assistant, and an MCP client that supports
remote Streamable HTTP servers. The hub connects to Node-RED's admin endpoint;
it does not use Home Assistant ingress URLs.

For each Node-RED target, collect:

- A short unique identifier, such as `home` or `lab`.
- Its direct Admin API URL, for example `http://192.168.3.57:1880`. Include the
  Node-RED `httpAdminRoot` path if you configured one, for example
  `https://node-red.example.internal/admin`.
- The authentication method required by that Admin API: native credentials,
  bearer token, HTTP Basic authentication, or none for an isolated test target.

Do not point the add-on at a public URL unless it uses valid TLS and is intended
for administrator access. Start with a read-only target or a disposable
Node-RED instance.

### Add the repository and install the app

1. In Home Assistant, open **Settings → Apps → App store**.
2. Select the three-dot menu, choose **Repositories**, paste this repository's
   GitHub URL, and select **Add**.
3. Close the repository dialog, find **Node-RED MCP Hub** in the App store, and
   select **Install**. Home Assistant builds the image from the repository.
4. Leave port `51844` at its default mapping unless it conflicts with another
   service on the Home Assistant host. If you change it, use that host port in
   the MCP URL later.

### Configure the app

Open the installed app, select the **Configuration** tab, and use this as a
starting point. Replace every placeholder before saving.

```yaml
mcp_path_secret: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
read_only: true
servers:
  - id: home
    name: Home Node-RED
    url: http://192.168.3.57:1880
    auth_mode: credentials
    username: CHANGE_ME
    password: CHANGE_ME
    read_only: false
```

Generate `mcp_path_secret` as 32 random bytes encoded as 64 hexadecimal
characters. On macOS/Linux, `openssl rand -hex 32` produces a valid value. Keep
it in a password manager: it is part of the MCP endpoint URL and grants access
to the hub.

Choose `auth_mode` for each server:

| Mode | Required fields | Use when |
| --- | --- | --- |
| `credentials` | `username`, `password` | Node-RED's native Admin API authentication is enabled. |
| `bearer` | `token` | A reverse proxy or Node-RED accepts a bearer token. |
| `basic` | `username`, `password` | A reverse proxy explicitly requires HTTP Basic authentication. |
| `none` | none | Only for an isolated, otherwise protected Admin API. |

The global `read_only: true` hides every write tool. A server-level
`read_only: true` remains protective after you enable global writes, so it is a
useful way to keep selected Node-RED instances permanently read-only.

Select **Save**, then open the **Info** tab and select **Start**. The app starts
only when the configuration has one to twenty valid servers and a valid path
secret. If it fails to start, open the app log: configuration errors identify
the exact invalid field without printing passwords, tokens, flow content, or
the private endpoint.

### Connect your MCP client

Configure a remote Streamable HTTP MCP server with this exact URL, replacing
the address, port mapping, and secret:

```
http://HOME_ASSISTANT_LAN_ADDRESS:51844/private_YOUR_64_HEX_SECRET
```

For example:

```
http://192.168.3.57:51844/private_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Do not add an Authorization header or a trailing slash. The private URL is the
credential. Store it in the MCP client's secret store when available, restrict
access to a trusted LAN or VPN, and use HTTPS through a trusted reverse proxy
if the client connects over an untrusted network. Browser origins are rejected
and CORS is disabled by design.

### First-run check

1. With `read_only: true`, connect the MCP client and call `list_servers`.
2. Call `get_flows` for a non-production or read-only server and confirm the
   returned server and flow revision are expected.
3. Review the add-on log for connection errors. A target failure does not make
   the app health endpoint fail, so investigate each target independently.
4. Before enabling writes, take a Home Assistant/Node-RED backup and test
   `create_flow`, `update_flow`, and `deploy_flows` only against a disposable
   Node-RED flow. Set global `read_only: false`, save, and restart the app to
   expose write tools.

Writes take effect immediately. For a timeout or network failure after a write,
read the target's current state before taking another action: Node-RED may have
accepted the first request. The hub does not retry writes, create backups, or
maintain a rollback history.
