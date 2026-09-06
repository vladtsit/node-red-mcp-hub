# Node-RED MCP Hub

Node-RED MCP Hub exposes the configured Node-RED **Admin APIs** as one MCP
endpoint. It is a trusted-administrator tool: flows can contain code and
credentials, and write tools take effect immediately.

## Install and configure

1. Add this repository to Home Assistant as a local or Git repository, then
   install the app. The repository build creates the image locally. Leave its internal port at
   `51844`. If the host port is occupied, change only the host mapping in the
   add-on's Network options.
2. Leave `mcp_path_secret` as `auto` for the first start. The app generates and
   saves a 64-character hexadecimal secret in the Configuration tab without
   writing it to the log. It also shows the complete copyable `mcp_url` in that
   tab. You can instead provide a value from
   `openssl rand -hex 32`.
3. Add one to twenty Node-RED Admin API targets. Use the direct Admin URL,
   including its admin-root prefix when it has one; do not use a Home Assistant
   ingress URL. The local Home Assistant Node-RED target can be discovered
   automatically; additional targets remain manually configurable. Changes
   take effect after restarting the app.
4. Start with `read_only: true`. Set it to `false` only when the MCP client
   should be permitted to alter flows. Writes require **both** gates to be open:
   the global `read_only` and the target's own `read_only` must each be `false`.
   Either one left at `true` blocks every write tool for that target.

`home_assistant_node_red` is a required key. Leave it as `enabled: false` when
you configure every target manually; do not delete the key.

Each entry under `servers` requires `id`, `name`, `url`, and `auth_mode`. A
missing `name` is the most common reason the Configuration tab refuses to save.

Example options (replace every example value except the first-start `auto`):

```yaml
mcp_path_secret: auto
read_only: true
redact_secrets: true
backup_before_write: true
backup_retain: 20
disabled_tools: ''
home_assistant_node_red:
  enabled: true
  username: YOUR_HOME_ASSISTANT_USERNAME
  password: YOUR_HOME_ASSISTANT_PASSWORD
  read_only: true
servers: []
```

`credentials` exchanges the supplied Node-RED username and password for a
native Admin API token, retained in memory only. `bearer` uses `token`; `basic`
is for a proxy that explicitly uses HTTP Basic authentication; `none` sends no
authentication. The add-on validates the fields required by the selected mode.

### Local Home Assistant Node-RED app

Enable `home_assistant_node_red` and provide the Home Assistant username and
password that can open the Community Node-RED app. The hub uses Supervisor to
locate the installed app, prefers the Home Assistant LAN address with Node-RED's
published host port, and falls back to the Supervisor-internal address and
Node-RED's own port when no host port is published. It then authenticates the
Admin API using HTTP Basic, because the Community app fronts Node-RED with an
HTTP Basic proxy. Supervisor does not provide or replace the credentials.
Discovery requires the `manager` Supervisor role to list and read other apps;
this is granted automatically by the add-on manifest.

Use `auth_mode: basic` for this app. `auth_mode: credentials` targets Node-RED's
native `adminAuth` login and is rejected by that proxy. A Home Assistant
long-lived access token is not accepted either, even though it works with Home
Assistant's REST API. For a trusted-LAN HTTP setup, publish Node-RED on port
`1880` and disable SSL in the Node-RED app. If discovery cannot resolve an
endpoint, the app stops with an error naming the setting to add; provide the
direct URL explicitly:

```yaml
home_assistant_node_red:
  enabled: true
  username: YOUR_HOME_ASSISTANT_USERNAME
  password: YOUR_HOME_ASSISTANT_PASSWORD
  url: http://192.168.3.57:1880
  read_only: true
```

The Home Assistant frontend route such as
`http://192.168.3.57:8123/app/a0d7b954_nodered` is not an Admin API URL and
cannot be used as a hub target.

Use `servers` for other Node-RED instances. The discovered local target has the
fixed ID `home_assistant_node_red`; manual target IDs must be unique. To manage
the local app as a manual entry instead, keep `home_assistant_node_red.enabled`
at `false` and give the manual entry a different ID:

```yaml
home_assistant_node_red:
  enabled: false
  read_only: true
servers:
  - id: local_node_red
    name: Home Assistant Node-RED
    url: http://192.168.3.57:1880
    auth_mode: basic
    username: YOUR_HOME_ASSISTANT_USERNAME
    password: YOUR_HOME_ASSISTANT_PASSWORD
    read_only: false
```

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

`list_servers` and `check_servers` operate across targets; other tools require
`server_id`. Prefer `list_flows` for compact tab/subflow summaries and
`search_nodes` for compact metadata. `get_flow` and `get_flows` return detailed
definitions and can expose sensitive Function code or arbitrary node
properties. `get_flows` returns Node-RED's `rev` alongside the graph.

With `redact_secrets: true`, detailed reads remove all `credentials` objects and
redact properties with recognized password, token, secret, authorization, or
API-key names. This is defense in depth, not a guarantee that arbitrary flow
content is safe to share.

When global write access is enabled, `create_flow`, `update_flow`,
`delete_flow`, and `deploy_flows` are available. They map directly to the
Node-RED APIs. `update_flow` requires `flow.id` to match `flow_id`; it forwards
the native object so custom node properties and existing credential references
are not reconstructed by the hub. `create_flow` and `update_flow` also redeploy
the modified flow immediately afterward, so newly added or changed nodes start
running right away instead of only appearing in the editor until a manual
deploy.

The server advertises MCP `instructions` telling a connected agent to read
current flow state before writing, use only node types confirmed installed,
prefer scoped `update_flow` over a full `deploy_flows`, and — most importantly —
always describe the exact change and get explicit user confirmation before
calling `create_flow`, `update_flow`, `delete_flow`, or `deploy_flows`. This is
guidance surfaced to the connecting agent, not a technical restriction enforced
by the hub; `read_only` remains the actual access control.

The instructions also call out a specific, easy-to-get-wrong node property:
`wires` must be an array of arrays, one per output port (e.g. `[["targetId"]]`
for a single output wired to one target, `[]` for none). A flattened
`["targetId"]` is accepted by Node-RED without error, but the source node
fires while nothing downstream ever receives a message — this fails
completely silently with no error anywhere.

`deploy_flows` needs the `rev` returned by `get_flows` and passes it straight
to Node-RED. A stale revision is returned as Node-RED's HTTP 409; the hub never
forces or retries a deploy. Individual-flow operations use Node-RED's native
concurrency behavior and have no hub-side revision control.

Writes are immediate. Before each write, `backup_before_write: true` stores an
atomic, unredacted v2 flow snapshot in `/data/backups/<server-id>/`; it blocks
the write if the backup fails. At most `backup_retain` snapshots are kept per
server. These files are private but sensitive and are intended for deliberate
manual recovery, not automatic rollback.

If the network fails or a write times out after it may have reached Node-RED,
the structured error marks the outcome as unknown. Do not retry automatically—
read the target first to determine its actual state.

Use the optional comma-separated `disabled_tools` setting to remove tools
globally, or the same field on a manual server to block operations only for
that target. Unknown names are rejected and `list_servers` is always present.

## Operational notes

- Target failures never make `/healthz` fail; each target is isolated.
- The gateway runs as the app's root user inside its custom AppArmor profile;
  Home Assistant's restricted app environment does not permit the ownership
  changes needed to drop to a separate Unix user.
- The gateway has a 15-second outbound timeout, hardened inbound timeouts,
  10 MiB request/response limits, a 20-call concurrency limit, TLS certificate
  verification, disabled redirects, and graceful SIGTERM/SIGINT shutdown.
- It uses no database and persists no target tokens. Add-on logs intentionally
  omit private URLs, headers, option secrets, and flow bodies.
- Tool responses include stable structured success/error objects and explicit
  MCP safety annotations in addition to text content for older clients.
- The runtime image uses a dated, digest-pinned Home Assistant Alpine base and
  contains only production Node.js dependencies. CI builds both `amd64` and
  `aarch64` images.

## Troubleshooting

- Options are read once at start. Save the Configuration tab and then restart
  the app; edits never take effect while it is running.
- If the app stops immediately, the log names the rejected option. Every target
  must be reachable in configuration terms before the MCP port opens, so a
  configuration error appears as a refused connection on port `51844`.
- `check_servers` reports per-target reachability, latency, and Node-RED
  version, and is the fastest way to confirm credentials after a change.
- `AUTH_FAILED` with HTTP 401 against the Community Node-RED app usually means
  `auth_mode` is `credentials` where the app's HTTP Basic proxy requires
  `basic`.
- A write tool returning `READ_ONLY` means the global `read_only` or the
  target's `read_only` is still `true`; both must be `false`.

