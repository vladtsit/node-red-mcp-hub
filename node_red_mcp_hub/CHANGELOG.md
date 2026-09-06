# Changelog

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
