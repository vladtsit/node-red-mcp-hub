# Changelog

## 0.4.3

### Fixed

- `update_flow`/`delete_flow` now check `expected_rev` before taking a
  pre-write backup, instead of after, so a stale revision is rejected
  without wasting (or failing on) a backup write.
- Fixed a CI-only test failure caused by a hardcoded default backup path.

## 0.4.2

### Fixed

- `trigger_inject` fired `.receive()` on any existing node id regardless of
  type (matching Node-RED's own route, which does the same). It now checks
  the node's type first and rejects a non-`inject` target with
  `INVALID_ARGUMENT`; unknown ids still fall through to a 404.

## 0.4.1

### Fixed

- `trigger_inject` failed every real call with `UPSTREAM_INVALID_RESPONSE`
  because Node-RED's `POST /inject/:id` replies with a plain-text `"OK"`
  body, not JSON, and the gateway rejected any non-JSON response body.
- `create_subflow` always returned HTTP 400: Node-RED's `POST /flow` cannot
  create a subflow (it always wraps payloads as a `"tab"` and rejects
  nested `"tab"`/`"subflow"` nodes). It now appends the subflow definition
  to the full flows document and deploys it via `POST /flows`.
- `preview_flow_change` (full-flow mode) never reported a changed node as
  `updated`, always classifying it as `kept`. It now deep-compares node
  content to distinguish the two.

## 0.4.0

### Added

- `trigger_inject` fires an inject node's `input` event on demand, with an
  optional `override_props` to replace its configured payload/topic for one
  trigger.
- `get_context` reads Node-RED's `global`/`flow`/`node` context stores.
- `preview_flow_change` dry-runs an `update_flow` or `patch_flow` change
  (added/updated/removed node IDs) without writing anything.
- `list_backups` lists retained pre-write backup snapshots for a server
  (filename/tool/size only, never content).
- `update_flow` and `delete_flow` accept an optional `expected_rev` for
  optimistic-concurrency conflict detection (`REV_CONFLICT`).
- Write failures that occur after a successful save but during the automatic
  post-write redeploy are now reported distinctly as `REDEPLOY_FAILED`.
- `create_flow`, `update_flow`, `patch_flow`, and `deploy_flows` now validate
  that every node `type` is installed (per `get_installed_modules`) or is a
  subflow instance referencing an existing subflow, rejecting unknown types
  before writing.
- `get_flow` now also returns the current `rev`.
- Every write tool call appends a JSON-lines entry to a private audit log
  (`/data/audit.log` by default, `AUDIT_LOG_PATH` env override).
- Backups can now also be pruned by total size via `backup_max_size_mb`, in
  addition to the existing count- and age-based retention.
- `get_flows`/internal flow reads are now served from a short-lived
  (~1.5s) in-memory cache to reduce redundant upstream calls from bursts of
  concurrent reads; pre-write backups and post-write redeploys always bypass
  this cache to see truly current state.

## 0.3.9

### Added

- Added `create_subflow` for creating an empty native subflow container
  (in/out ports, optional env vars) after a pre-write backup.
- Exposed flows as MCP resources (`flow://{server_id}/{flow_id}`) and added
  two prompt templates: `add_inject_debug_pair` and
  `diagnose_silent_failure`.
- Backups can now be pruned by age via `backup_max_age_days`, in addition to
  the existing count-based retention.
- `/healthz?targets=<mcp_path_secret>` returns per-target reachability and
  version; the default unauthenticated `/healthz` is unchanged.

## 0.3.8

### Added

- `create_flow`, `update_flow`, and `deploy_flows` validate write payloads
  before touching Node-RED, rejecting flattened `wires`, duplicate node ids,
  dangling wire targets, and `[redacted]` value round-trips with a
  `VALIDATION_FAILED` error instead of a silent failure.
- Added `patch_flow`: add/update/remove specific nodes in one tab without
  resending the whole thing. Merges against a fresh unredacted read
  server-side and returns only an id-level diff, never full flow content.

## 0.3.7

### Added

- Expanded the agent instructions with the flow-authoring rules that fail
  silently when broken: `update_flow` replaces a tab wholesale so omitted
  nodes and a dropped `configs` array are deleted, `[redacted]` values from a
  read must never be written back, node ids must be unique runtime-wide, and
  writes should be verified by re-reading. Added reliability guidance on catch
  nodes, function node error reporting, and disabling nodes instead of
  deleting them.

## 0.3.6

### Added

- Agent instructions and write-tool descriptions now also warn that a node's
  `wires` must be an array of arrays (one per output port), since a flattened
  array is accepted without error but silently drops all messages to that
  node's targets.

## 0.3.5

### Added

- MCP server `instructions` and write-tool descriptions now tell a connecting
  agent to read current flow state first, use only installed node types,
  prefer scoped `update_flow` over a full `deploy_flows`, and always confirm
  the exact change with the user before calling `create_flow`, `update_flow`,
  `delete_flow`, or `deploy_flows`.

## 0.3.4

- Fixed `create_flow`/`update_flow` leaving newly added nodes (e.g. a new
  debug node) visible but not actually running: Node-RED's single-flow
  `POST /flow`/`PUT /flow/:id` endpoints only do a targeted reload and don't
  reliably wire newly added nodes into message/status routing until a
  "Modified Flows" deploy runs. Both tools now automatically follow up with
  that redeploy so new nodes work immediately, without a manual editor
  deploy and without restarting unrelated flows.

## 0.3.3

- Fixed Home Assistant Node-RED discovery failing with "could not find an
  installed Node-RED app" because the add-on lacked the `manager` Supervisor
  role needed to call `GET /addons`; the default role can only read the
  add-on's own Supervisor data. Added `hassio_role: manager` to the manifest.

## 0.3.2

- Fixed Home Assistant Node-RED discovery for host-networked add-ons: Docker
  publishes no port mappings in host network mode, so discovery now falls
  back to the container's fixed port when Supervisor reports `host_network`
  and no mappings, instead of failing to start without an explicit `url`.

## 0.3.1

- Fixed Home Assistant Node-RED discovery, which read the wrong container port
  mapping and required a container address, so an explicit `url` was needed.
- Discovery now prefers the Home Assistant LAN address with Node-RED's
  published host port and falls back to its internal address and port `1880`.
- Startup failures now log the rejected option instead of a generic message,
  and discovery errors name the setting that resolves them.
- Surfaced `home_assistant_node_red.read_only` in the default options so the
  per-target write gate is visible in the Configuration tab.
- Documented that writes need both the global and target `read_only` to be
  `false`, which keys are required, and how to add manual targets.

## 0.3.0

- Added Basic-authenticated automatic discovery for the Home Assistant
  Community Node-RED app while retaining support for additional targets.
- Added compact server checks, flow summaries, and node search tools.
- Added structured results, MCP safety annotations, stronger redaction, and
  global/per-target tool policy controls.
- Added private atomic pre-write backups with bounded retention.
- Hardened HTTP lifecycle handling, image construction, and CI supply-chain
  checks.
