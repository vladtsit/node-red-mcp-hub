# Changelog

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
