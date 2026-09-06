# Changelog

## Unreleased

### Changed

- Documented the official Home Assistant Node-RED app as a manually configured
  HTTP Basic-authenticated target.
- Kept `credentials`, `bearer`, `basic`, and `none` authentication modes for
  additional, externally managed Node-RED servers.

### Fixed

- Clarified that Home Assistant long-lived access tokens authenticate Home
  Assistant's REST API but are not accepted by the Node-RED app's Admin API
  proxy.
- Documented that the automatic Home Assistant Node-RED discovery target should
  be disabled for the official app until it supports Basic authentication.

### Security

- Updated the first-run configuration examples to enable global and target
  read-only mode.
