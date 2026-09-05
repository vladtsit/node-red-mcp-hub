# Node-RED MCP Hub

Node-RED MCP Hub exposes the configured Node-RED **Admin APIs** as one MCP
endpoint. It is a trusted-administrator tool: flows can contain code and
credentials, and write tools take effect immediately.

## Install and configure

1. Add this repository to Home Assistant as a local or Git repository, then
   install the app. The repository build creates the image locally. Leave its internal port at
   `51844`. If the host port is occupied, change only the host mapping in the
   add-on's Network options.
2. Generate a path secret locally, for example `openssl rand -hex 32`, and put
   the resulting 64 hexadecimal characters in `mcp_path_secret`.
3. Add one to twenty Node-RED Admin API targets. Use the direct Admin URL,
   including its admin-root prefix when it has one; do not use a Home Assistant
   ingress URL. Changes take effect after restarting the add-on.
4. Start with `read_only: true`. Set it to `false` only when the MCP client
   should be permitted to alter flows. A target's `read_only: true` protects
   that target even while global writes are enabled.

Example options (replace every example value):

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

`credentials` exchanges the supplied Node-RED username and password for a
native Admin API token, retained in memory only. `bearer` uses `token`; `basic`
is for a proxy that explicitly uses HTTP Basic authentication; `none` sends no
authentication. The add-on validates the fields required by the selected mode.

## Connect an MCP client

Configure the remote Streamable HTTP MCP URL exactly as:

```
http://HOME_ASSISTANT_LAN_ADDRESS:51844/private_YOUR_64_HEX_SECRET
```

Do not add a bearer token. The private URL is the credential: store it as a
secret, never expose the endpoint to the public internet, and rotate it by
changing `mcp_path_secret` and restarting the add-on. Browser requests are
rejected and CORS is intentionally disabled. `/healthz` is the only other
route; it contains no target health or configuration data.

## Tools and write behavior

Every tool except `list_servers` requires `server_id`. Read tools retrieve
flows, a single flow, selected settings, sanitized diagnostics, runtime flow
state, and installed modules. `get_flows` returns Node-RED's `rev` alongside
the graph.

When global write access is enabled, `create_flow`, `update_flow`,
`delete_flow`, and `deploy_flows` are available. They map directly to the
Node-RED APIs. `update_flow` requires `flow.id` to match `flow_id`; it forwards
the native object so custom node properties and existing credential references
are not reconstructed by the hub.

`deploy_flows` needs the `rev` returned by `get_flows` and passes it straight
to Node-RED. A stale revision is returned as Node-RED's HTTP 409; the hub never
forces or retries a deploy. Individual-flow operations use Node-RED's native
concurrency behavior and have no hub-side revision control.

Writes are immediate. If the network fails or a write times out after it may
have reached Node-RED, the response marks the outcome as unknown. Do not retry
automatically—read the target first to determine its actual state. The hub has
no rollback, snapshots, history, or recovery journal. Use Node-RED/Home
Assistant backups for backup and restore.

## Operational notes

- Target failures never make `/healthz` fail; each target is isolated.
- The gateway has a 15-second outbound timeout, 10 MiB request/response limits,
  20 in-flight call limit, TLS certificate verification, and disabled redirects.
- It uses no database and persists no target tokens. Add-on logs intentionally
  omit private URLs, headers, option secrets, and flow bodies.
- This package is tested with Node.js 20+ and MCP SDK 1.30.0. Build both `amd64`
  and `aarch64` images before publishing a release. To publish it to GHCR, set
  the real repository owner in the image and repository metadata first.
