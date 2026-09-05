# Developer instructions

Build a thin Node-RED Admin API wrapper following the [architecture](BUILDING_A_MULTI_NODE_RED_MCP_HOME_ASSISTANT_APP.md). Keep endpoint behavior close to Node-RED. The earlier database, versioning and proposal design is superseded.

## Name and port

Use **Node-RED MCP Hub** as the Home Assistant display name. Keep the telegraph reference as a code comment explaining port **51844**, which embeds the year of Morse's Washington–Baltimore telegraph demonstration on 24 May 1844. [Historical source](https://www.loc.gov/item/mcc00054/)

Keep `node_red_mcp_hub` as the slug/app directory, `home-assistant-node-red-mcp-hub` as the repository, and `ghcr.io/<username>/node-red-mcp-hub` as the image.

Use these values consistently in the implementation:

```yaml
# Relevant Home Assistant config.yaml fields
name: Node-RED MCP Hub
slug: node_red_mcp_hub
ports:
  # 51844 references Morse's 1844 Washington–Baltimore telegraph demonstration.
  51844/tcp: 51844
ports_description:
  51844/tcp: MCP HTTP endpoint
watchdog: http://[HOST]:[PORT:51844]/healthz
```

Bind the app to `0.0.0.0:51844`; use `EXPOSE 51844/tcp` in the Dockerfile. Client example: `http://192.168.3.57:51844/private_<secret>`. Check host-port availability at installation; if occupied, change only the host mapping through HA Network options and update the client URL. Keep the internal listener and watchdog port at 51844.

## Small source layout

```text
repository.yaml
node_red_mcp_hub/
  config.yaml
  Dockerfile
  apparmor.txt
  DOCS.md
  rootfs/                 # HA startup service
  gateway/
    package.json
    package-lock.json
    tsconfig.json
    src/
      index.ts           # HTTP, SDK, private route, health
      config.ts          # options parsing and validation
      node-red.ts        # per-server clients, auth, fixed API methods
      tools.ts           # tool schemas, target selection, read_only
    test/
```

Add files when needed; do not prebuild storage, planners, repositories, queues or framework layers. Use TypeScript strict mode, the official MCP SDK and normal HTTP/schema libraries. No SQLite dependency or replacement JSON-file database.

## Implementation order

1. Scaffold the HA app and container. Fix internal port at 51844. Load options; validate secret and configured targets. Implement private URL authentication and /healthz.
2. Create one HTTP client per server. Support native credential exchange, bearer, explicit Basic proxy and no-auth modes. Preserve admin-root prefixes, encode IDs and disable redirects. Keep tokens in memory only.
3. Register list_servers and read tools. Each target call resolves its own server_id; never use a mutable global selected server. Return sanitized errors and handle empty responses.
4. Register direct write tools from the architecture table. Global read_only hides and blocks them; target read_only blocks that target. Forward native payloads without graph reconstruction. Only deploy_flows requires Node-RED's supplied rev; there is no custom revision tracking.
5. Add focused tests, build both architectures and test local HA installation. Document URL setup, target authentication, immediate-write behavior and native backup usage in DOCS.md.

Do not implement proposal/apply phases, snapshots, rollback, persistent audit, background jobs, node-type policies, graph validation engines or compatibility frameworks. Normal dependency pinning, a short tested-version note and HA package version metadata are sufficient.

## Required checks

- An actual MCP client initializes and lists/calls tools through the private URL without a bearer header. Wrong paths fail; private URLs/secrets never appear in logs.
- Two disposable Node-RED targets return different fixtures correctly, including simultaneous calls. A failure on one does not break the other or /healthz.
- Global and per-target read_only reject writes even when called directly.
- Create/update/delete uses the documented individual-flow API; unrelated tabs are unaffected. Unknown custom-node properties survive forwarding and unchanged node credentials remain usable.
- Full deploy forwards the caller's rev, passes the deployment header and returns a real Node-RED 409 on stale input. No force-retry.
- A write timeout/lost reply is reported as uncertain and never automatically replayed. Restart needs no recovery or migration.
- Requests cannot override configured origin/admin root through IDs, redirects or arbitrary paths. Check timeout, body caps, TLS verification and sanitized upstream errors.
- HA installation, port remapping, watchdog, non-root configuration access, protection/AppArmor and restart work on the supported architectures.

Use disposable servers for write tests. Do not modify household flows as part of implementation testing. Run lint, typecheck, focused tests and build in CI. Keep actual passwords/private URLs out of fixtures and source.

## Deployment inputs

The repository owner is needed when publishing. Actual target addresses/authentication and the private URL secret are entered in HA options. The user already chose URL-only client authentication; no further authentication decision is needed.
