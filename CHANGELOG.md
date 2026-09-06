# Changelog

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
