# Changelog

## 0.3.9 - 2026-09-06

### Added

- Added `create_subflow`, a dedicated tool for creating an empty native
  Node-RED subflow container (with `in`/`out` port arrays and optional `env`
  vars) after a configured pre-write backup. Internal nodes and wiring are
  then added with `patch_flow`/`update_flow` scoped to the returned subflow
  id.
- Exposed flows as MCP resources under `flow://{server_id}/{flow_id}`, listed
  from every configured target, redacted the same way as `get_flow`.
- Added two MCP prompt templates, `add_inject_debug_pair` and
  `diagnose_silent_failure`, covering common flow-authoring and
  troubleshooting workflows.
- Backups can now also be pruned by age via the new `backup_max_age_days`
  option, in addition to the existing count-based `backup_retain` limit.
- `/healthz` now accepts `?targets=<mcp_path_secret>` to return per-target
  reachability and Node-RED version, alongside the existing fast
  unauthenticated `{"status":"ok"}` liveness response.

## 0.3.8 - 2026-09-06

### Added

- `create_flow`, `update_flow`, and `deploy_flows` now validate the payload
  before writing anything to Node-RED, rejecting it with a `VALIDATION_FAILED`
  error instead of letting Node-RED silently accept a broken write: a
  flattened `wires` value, a duplicate node id within the payload, a wire
  that targets an id that does not exist anywhere in the current graph or
  the payload, and a literal `"[redacted]"` string anywhere in the payload
  are all now caught server-side.
- Added `patch_flow`, a safer alternative to `update_flow` for incremental
  changes. It takes `add`/`update`/`remove` node lists, merges them
  server-side against a freshly read, unredacted copy of the target tab
  (preserving every node and config node not mentioned), validates the
  merged result the same way as the tools above, and writes it back. Its
  response is only a compact `{ added, updated, removed, node_count_before,
  node_count_after }` diff of node ids — never full flow content — so secret
  values read internally for the merge are never echoed back to the calling
  agent.
- Updated the MCP server `instructions` and tool descriptions to mention the
  new validation and to recommend `patch_flow` over `update_flow` for
  incremental changes.

## 0.3.7 - 2026-09-06

### Added

- Substantially expanded the MCP server `instructions` with the flow-authoring
  rules whose violations fail silently: `update_flow` replaces a tab's entire
  contents (so any omitted node is deleted, and dropping the separate
  `configs` array breaks every node referencing those config nodes), a
  `[redacted]` value from a read must never be written back (it would replace
  the real secret with that literal string), node ids must be unique across
  the whole runtime, and a node's `z` must match its tab. Added guidance to
  verify writes by re-reading, to not blindly retry a timed-out write, and to
  build more reliable flows using catch nodes, `node.error(err, msg)` in
  function nodes, and `"d": true` to disable rather than delete a node.
- `update_flow`'s tool description now also carries the tab-replacement and
  redaction warnings, so they are visible at the call site.

## 0.3.6 - 2026-09-06

### Added

- The MCP server `instructions` and each write tool's description now also
  warn that a node's `wires` property must be an array of arrays, one per
  output port (e.g. `[["targetId"]]`), not a flattened array. A flattened
  `wires` value is accepted by Node-RED without any error, but the source
  node fires while nothing downstream ever receives a message — discovered
  live this session when a manually-built test node exhibited exactly this
  silent failure.

## 0.3.5 - 2026-09-06

### Added

- The MCP server now advertises `instructions` guiding a connecting agent to
  develop and modify flows following best practices (inspect current state
  first, only use installed node types, prefer scoped updates, keep new nodes
  clearly named and laid out) and to always confirm the exact change with the
  user before any `create_flow`, `update_flow`, `delete_flow`, or
  `deploy_flows` call. The same reminder was added to each write tool's
  description.

## 0.3.4 - 2026-09-06

### Fixed

- `create_flow` and `update_flow` created/updated nodes that stayed visible in
  the editor but never actually ran (no debug output, no status) until the
  user nudged a node and clicked Deploy. Node-RED's single-flow endpoints
  only perform a targeted reload of the affected tab and don't reliably start
  newly added nodes' message/status routing. Both tools now automatically
  redeploy the modified flow (equivalent to the editor's "Modified Flows"
  deploy) immediately after the write.

## 0.3.3 - 2026-09-06

### Fixed

- Home Assistant Node-RED discovery failed with "could not find an installed
  Node-RED app" even with a correct `host_network` fallback, because the
  add-on's Supervisor role (`default`) is not permitted to call `GET /addons`
  to list other installed apps; only `manager` and `admin` roles can. Added
  `hassio_role: manager` to `config.yaml` so discovery can enumerate apps.

## 0.3.2 - 2026-09-06

### Fixed

- Home Assistant Node-RED discovery still failed to start without an explicit
  `home_assistant_node_red.url` for host-networked add-ons: Docker publishes no
  container-to-host port mappings in host network mode, so Supervisor reports
  an empty `network` map even though Node-RED is reachable on its fixed port.
  Discovery now falls back to Node-RED's container port as the published port
  when Supervisor reports `host_network: true` and no port mappings.

## 0.3.1 - 2026-09-06

### Fixed

- Home Assistant Node-RED discovery read the published host port from a `80/tcp`
  mapping and required a non-empty container address, so it failed for the
  Community app and forced an explicit `home_assistant_node_red.url`. Discovery
  now resolves Node-RED's own `1880/tcp` mapping, prefers the Home Assistant LAN
  address with the published host port, and falls back to the Supervisor
  internal address with Node-RED's container port.
- Startup failures now report the rejected add-on option instead of a generic
  message, and Supervisor discovery errors name the setting that resolves them.

### Changed

- `home_assistant_node_red.read_only` is now present in the default options so
  the per-target write gate is visible and editable in the Configuration tab.
- Documented that write tools require both the global and per-target
  `read_only` to be `false`, that `home_assistant_node_red` is a required key,
  that every `servers` entry needs `id`, `name`, `url`, and `auth_mode`, and
  that the Community Node-RED app requires `auth_mode: basic` rather than
  `credentials`.
- Added a troubleshooting section covering restart-to-apply behavior,
  `AUTH_FAILED`, and `READ_ONLY` results.

## 0.3.0 - 2026-09-06

### Added

- Automatic discovery of the Home Assistant Community Node-RED app with
  user-supplied HTTP Basic credentials and an optional direct-URL override.
- `check_servers`, `list_flows`, and `search_nodes` tools for compact discovery
  without exporting the complete flow graph.
- Structured MCP results and errors plus explicit read-only, destructive,
  idempotent, and open-world tool annotations.
- Configurable secret redaction for detailed flow reads.
- Fail-closed, atomic pre-write flow snapshots with per-server retention.
- Global and per-target comma-separated tool disabling with strict validation.
- English Home Assistant configuration translations.

### Changed

- Synchronized the app, package, runtime, and image version at `0.3.0`.
- Switched to a multi-stage, digest-pinned Home Assistant Alpine build that
  leaves compilers, npm, and development dependencies out of the runtime image.
- Added inbound HTTP timeouts, bounded socket reuse, graceful shutdown, and
  stable upstream error codes.
- Full flow reads now always remove Node-RED `credentials` objects and warn that
  Function code and arbitrary properties may still contain secrets.
- CI now audits production dependencies, checks version consistency, builds
  both supported architectures, pins third-party actions, and runs CodeQL.

### Fixed

- Corrected local Node-RED authentication to use Home Assistant HTTP Basic
  credentials instead of an incompatible long-lived bearer token.
- Corrected Supervisor endpoint discovery to combine the Home Assistant LAN
  address with Node-RED's published port, with an internal-port fallback.
- Made concurrent backups collision-safe and retention cleanup race-safe.

### Security

- Write tools are backed up by default and are blocked if their pre-write
  snapshot cannot be created.
- The MCP path secret remains auto-generated, hidden from logs, and exposed as
  a copyable managed URL only in app configuration.
- Read-only mode remains enabled by default globally and for the discovered
  local Node-RED target.
