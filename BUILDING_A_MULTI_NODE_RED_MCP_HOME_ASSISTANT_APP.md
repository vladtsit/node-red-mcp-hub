# Node-RED MCP Hub: simple architecture

Status: design ready for implementation. This document supersedes the earlier storage and change-management design. The application has not been implemented yet.

## Purpose

A small Home Assistant app that exposes several configured Node-RED Admin APIs through one MCP endpoint.

| Item | Value |
| --- | --- |
| Display name | Node-RED MCP Hub |
| Slug / app directory | node_red_mcp_hub |
| Repository | home-assistant-node-red-mcp-hub |
| Image | ghcr.io/<username>/node-red-mcp-hub |
| Description | Secure multi-server MCP gateway for managing Node-RED flows |
| Platform | Home Assistant OS; amd64 and aarch64 |
| Endpoint | http://192.168.3.57:51844/private_<secret> |
| Client authentication | Private URL only, trusted LAN; no bearer header |

Port **51844** includes the year of Samuel Morse's Washington–Baltimore telegraph demonstration on 24 May 1844 and is in IANA's dynamic/private-use range (49152–65535); check availability on the deployment host. Keep the slug, repository and image names above unchanged. [Library of Congress](https://www.loc.gov/item/mcc00054/), [IANA port registry](https://www.iana.org/assignments/service-names-port-numbers)

## Design

```text
MCP client → private HTTP endpoint → tool handler → selected Node-RED Admin API
```

One TypeScript process using the official MCP SDK, a small HTTP server and an HTTP client. A map of configured servers holds a separate client and in-memory authentication token for each server. Every target tool requires server_id. Node-RED remains the source of truth.

No database, saved flows, history, snapshots, rollback, proposal tokens, approval workflow, job journal or custom versioning. Nothing is persisted by the gateway beyond Home Assistant's configuration. Restart simply reloads configuration and reconnects when requested. Logs go to stdout.

Use direct endpoint mappings rather than a graph planner. Validate request shape and required IDs; let Node-RED validate and deploy its own flow configuration. Preserve native payload fields, including custom-node properties. Do not implement graph merging, semantic diffs or a node-type permission engine.

## Configuration

Use Home Assistant app options as the configuration UI. Changes require restart.

```yaml
mcp_path_secret: REPLACE_WITH_64_RANDOM_HEX_CHARACTERS
read_only: true
servers:
  - id: home
    name: Home Node-RED
    url: http://192.168.3.57:1880
    auth_mode: credentials
    username: REPLACE_ME
    password: REPLACE_ME
    token: ""
    read_only: false
```

The target URL is an example; configure the actual direct Admin API URL, including any admin-root prefix. It is not a Home Assistant ingress URL.

Options: mcp_path_secret, read_only (default true), and servers (required, 1–20 entries). Target fields: unique id, name, url, auth_mode, username/password/token (empty when unused), read_only (default false). Global read_only overrides every target. IDs match `^[a-z][a-z0-9_-]{0,31}$`.

Outbound auth modes: credentials (native Node-RED token exchange), bearer (configured token), basic (only for a proxy explicitly using HTTP Basic), none (explicitly selected). Validate required fields; store secrets as password fields in HA options. Cache native tokens only in memory, refreshing before expiry; a failed read may refresh once on 401. Do not retry writes automatically. Follow [Node-RED authentication](https://nodered.org/docs/api/admin/oauth).

## MCP tools

All tools except list_servers require server_id. Tool arguments closely follow the Node-RED request bodies. No tool accepts arbitrary URLs, HTTP methods or API paths.

| Tool | Additional arguments | Admin API |
| --- | --- | --- |
| list_servers | None | Configured IDs, names and effective read_only |
| get_flows | None | GET /flows with API v2; returns rev and flows |
| get_flow | flow_id | GET /flow/:id |
| create_flow | flow | POST /flow |
| update_flow | flow_id, flow | PUT /flow/:id; body ID must match |
| delete_flow | flow_id | DELETE /flow/:id |
| deploy_flows | flows, rev, deployment_type=flows | POST /flows with API v2 |
| get_settings | None | GET /settings; return selected non-secret fields |
| get_diagnostics | None | GET /diagnostics; omit sensitive host/path fields |
| get_flow_state | None | GET /flows/state |
| get_installed_modules | None | GET /nodes |

The flow parameter uses Node-RED's native single-flow format; deploy_flows uses its native full graph array. Handle native empty success responses without attempting JSON parsing. Return an error when an optional diagnostic endpoint is unsupported. The [Admin API method catalog](https://nodered.org/docs/api/admin/methods/) is the implementation reference.

Writes execute immediately when read_only permits them. The MCP client's own confirmation UI can ask before a write; the hub adds no confirmation machinery. Hide mutation tools when global read_only is true and also reject direct calls; check per-target read_only on each call.

Individual-flow operations use Node-RED's native behavior: no gateway revision checking. Updating a flow restarts that flow and can overwrite concurrent edits to it. Avoid editing the same flow in the editor and MCP at the same time. [PUT /flow](https://nodered.org/docs/api/admin/methods/put/flow/)

For full-runtime deploy_flows only, require the rev returned by get_flows and pass it unchanged to Node-RED. On 409, return the conflict; do not fetch a newer revision and silently retry. This is a native API precondition, with no gateway history or version store. Accept deployment_type nodes, flows or full, default flows. [POST /flows](https://nodered.org/docs/api/admin/methods/post/flows/)

Do not automatically retry a write after a timeout or lost connection: return outcome_unknown and ask the caller to read current state. There is no durable recovery, deduplication or exactly-once guarantee. Backups and restore belong to Node-RED/Home Assistant.

Start with these tools only. Search, prompts, resources, WebSockets, context access, module installation and custom enable/disable helpers are outside the initial scope.

## Essential safeguards

- Serve exactly /private_<secret> on internal port 51844. Generate a fresh 32-byte secret; do not copy the conversation's example. Wrong paths return 404; no public /mcp alias.
- Treat the URL as a credential: never log it, headers, credentials or flow bodies. Use constant-time secret comparison. Rotate by replacing the option and restarting.
- Trusted LAN HTTP only for this first implementation. Do not expose it publicly. HTTPS termination/private tunneling can be provided outside the app when needed.
- Use SDK stateless Streamable HTTP with JSON responses. Let the SDK handle lifecycle and protocol negotiation. GET/DELETE may return 405 where streaming/sessions are not offered. No browser UI: reject requests with an Origin header, while allowing machine clients without one; CORS stays off.
- Targets come only from administrator configuration. Allow http(s), reject URL userinfo/query/fragment, encode IDs as individual path segments, disable redirects and implicit proxies. Tools cannot change target destinations. HTTPS targets must verify certificates. Do not add a custom subnet/DNS policy engine for this trusted-admin configuration model.
- Fixed limits: 15-second outbound timeout, 10 MiB request/response cap (including decompression), and 20 in-flight calls; reject excess work promptly. Keep errors bounded and sanitized.
- Preserve known credential fields privately when needed for forwarding; never log them or return them from read tools. If a response must be redacted, flag it as unsuitable for an unchanged round trip. Arbitrary flow code can still contain hard-coded secrets; detailed flow access is trusted administrative access.

## Home Assistant packaging

Use the current HA app template. Map 51844/tcp to host 51844 and expose GET /healthz returning only status:ok for a healthy gateway process. Target outages must not fail process health. Watchdog uses http://[HOST]:[PORT:51844]/healthz.

Keep protection and AppArmor enabled; no host networking, Docker socket, hardware or Supervisor/HA API permissions. Run Node as an unprivileged user. If /data/options.json is root-only, the small initializer copies it to a service-owned 0600 file under /run; do not change Supervisor's original permissions. No /ssl mount or database directory is needed.

Pin dependencies with a lockfile and publish amd64/aarch64 images. HA still needs an app release version and image tag for installation/updates; that ordinary package metadata is unrelated to the removed flow-history system. Test with two disposable Node-RED servers before household use.

Implementation steps and checks: [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md).
