# Developer instructions

Build a thin Node-RED Admin API wrapper following the [architecture](BUILDING_A_MULTI_NODE_RED_MCP_HOME_ASSISTANT_APP.md). Keep endpoint behavior close to Node-RED. The earlier database, versioning and proposal design is superseded.

## Name and port

Use **Node-RED MCP Hub** as the Home Assistant display name. Keep the telegraph reference as a code comment explaining port **51844**, which embeds the year of Morse's Washington–Baltimore telegraph demonstration on 24 May 1844. [Historical source](https://www.loc.gov/item/mcc00054/)

Keep `node_red_mcp_hub` as the slug/app directory and
`https://github.com/vladtsit/node-red-mcp-hub` as the repository.

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
  CHANGELOG.md
  DOCS.md
  run.sh                  # HA startup and managed options
  translations/
  gateway/
    package.json
    package-lock.json
    tsconfig.json
    src/
      index.ts           # HTTP, SDK, private route, health
      config.ts          # options parsing and validation
      backup.ts          # atomic, bounded pre-write snapshots
      node-red.ts        # per-server clients, auth, fixed API methods
      tools.ts           # schemas, annotations, policies, structured results
      version.ts         # runtime version injected by image metadata
    test/
```

Add files when needed; do not prebuild storage, planners, repositories, queues or framework layers. Use TypeScript strict mode, the official MCP SDK and normal HTTP/schema libraries. No SQLite dependency or replacement JSON-file database.

## Implementation order

1. Scaffold the HA app and container. Fix internal port at 51844. Load options; validate secret and configured targets. Implement private URL authentication and /healthz.
2. Create one HTTP client per server. Support native credential exchange, bearer, explicit Basic proxy and no-auth modes. Preserve admin-root prefixes, encode IDs and disable redirects. Keep tokens in memory only.
3. Register annotated read tools, including compact health, flow-summary and
   node-search paths. Each target call resolves its own `server_id`; never use a
   mutable global selected server. Return structured sanitized errors and handle
   empty responses.
4. Register direct write tools from the architecture table. Global read-only
   mode hides and blocks them; target policy blocks that target. Capture a
   private snapshot before each write and fail closed on backup errors. Forward
   native payloads without graph reconstruction. Only `deploy_flows` requires
   Node-RED's supplied `rev`; there is no custom revision tracking.
5. Add focused tests, audit dependencies, run CodeQL, build both architectures
   and test local HA installation. Document URL setup, discovery,
   authentication, redaction, tool policy, backups and uncertain writes.

Do not implement proposal/apply phases, automatic rollback, persistent audit,
background jobs, node-type policies, graph validation engines or compatibility
frameworks. The bounded pre-write snapshot layer is the deliberate exception.

## Required checks

- An actual MCP client initializes and lists/calls tools through the private URL without a bearer header. Wrong paths fail; private URLs/secrets never appear in logs.
- Two disposable Node-RED targets return different fixtures correctly, including simultaneous calls. A failure on one does not break the other or /healthz.
- Global and per-target read-only modes reject writes even when called directly;
  global tools disappear and target-disabled tools reject calls.
- Read tools have correct MCP annotations, return structured content and redact
  known credential/secret fields without claiming an altered export is safe for
  round-trip deployment.
- Create/update/delete uses the documented individual-flow API; unrelated tabs are unaffected. Unknown custom-node properties survive forwarding and unchanged node credentials remain usable.
- Full deploy forwards the caller's rev, passes the deployment header and returns a real Node-RED 409 on stale input. No force-retry.
- Every write captures a private atomic snapshot first. Backup failure blocks
  the write and retention is bounded per target.
- A write timeout/lost reply is reported as uncertain and never automatically
  replayed. Restart needs no recovery or migration.
- Requests cannot override configured origin/admin root through IDs, redirects or arbitrary paths. Check timeout, body caps, TLS verification and sanitized upstream errors.
- HA installation, managed secret/URL updates, local Node-RED discovery, port
  remapping, watchdog, protected root configuration access, AppArmor and restart
  work on the supported architectures.

Use disposable servers for write tests. Do not modify household flows as part
of implementation testing. Run dependency audit, typecheck, focused tests,
CodeQL and builds in CI. Keep actual passwords/private URLs out of fixtures and
source.

## Deployment inputs

Actual target addresses/authentication are entered in Home Assistant options.
The private URL secret is generated automatically unless deliberately
overridden. Client authentication remains URL-only; no bearer header is used.
