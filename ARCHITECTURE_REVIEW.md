# Architecture review — Node-RED MCP Hub

Reviewed 2026-09-05 against the supplied design guide and primary documentation. Scope: documentation review/update; no runtime or live installation testing. The only initial workspace artifact was the design guide.

The revised architecture is ready for phased implementation. Compatibility experiments remain release gates; this is not a production-readiness certification.

## Findings and resolutions

| Finding in v1 | Resolution in v2 |
| --- | --- |
| Product names, repository, image and ports differed from the request | Consistent Node-RED MCP Hub identifiers; fixed internal 1899 and direct private path |
| Bearer/Basic inbound model did not match clarified user preference | URL-only credential on trusted LAN; explicit rotation, log redaction and shared-principal limits |
| Individual-flow writes were paired with promises of revision safety | Use v2 full-graph conditional deployment with scoped planning; no raw individual write path |
| Preflight revision read did not close external-editor race | Node-RED's deploy-time revision check remains authoritative |
| Mutex appeared to span waiting for confirmation | Persist proposal and release; reacquire/revalidate only during apply |
| Multiple direct mutation tools could bypass prepare/apply | One prepare contract and one apply entry point |
| Confirmation token risked implying enforced human approval | Explicitly distinguish payload confirmation from independent human approval |
| Retry/crash behavior lacked durable at-most-once dispatch handling | Transactional intent, one-use claim, persistent status, UNKNOWN and local reconciliation |
| Flow snapshots implied broader rollback than available | Scoped topology rollback; no credentials, module/context or physical-effect rollback claims |
| Native Node-RED adminAuth conflated with Basic/direct HTTP node credentials | Explicit credentials/bearer/basic_proxy/none adapters and compatibility probes |
| Periodic DNS checks allowed validation/connect races | Validate and pin each connection address, preserve SNI, disable redirects/proxies |
| Private subnets alone were too broad an outbound rule | Per-target exact IP/CIDR allowlist plus private-range enforcement and fixed API methods |
| MCP lifecycle, Origin, HTTP methods and session behavior underdefined | Pinned protocol baseline, stateless JSON transport, exact Host/Origin and protocol tests |
| Global z/wire rules oversimplified Node-RED graphs | Fixture-backed rules for tabs, subflows, configs, links and groups |
| Dangerous-type denylist suggested stronger containment than possible | Explicit exact type allowlists and restart-impact analysis; no sandbox claim |
| Redacted data could accidentally become deployment data | Separate private round-trip graph from external projection; credential-retention gate |
| Non-root service assumed it could read Supervisor options and TLS keys | Protected runtime copies without changing Supervisor file ownership |
| TLS option conflicted with HTTP-only watchdog | Protocol-aware watchdog with HA integration tests |
| Snapshot filenames included opaque revision strings | UUID snapshots in SQLite with hashes and transactional journal |
| Optional context/comms/semantic/module features treated as uniformly available | Capability-gated extensions with distinct API, security and recovery requirements |
| Mandatory upstream fork/license assertion premature | Independent core; provenance/license check before selective reuse |
| Supervised listed as a production target | HA OS production target; standalone container for development |

## Decision records

- ADR-001: One process, explicit server_id, isolated target adapters and persistent generations.
- ADR-002: User-selected URL credential; no bearer requirement. The submitted sample secret is not copied into implementation examples.
- ADR-003: Scoped graph planning with revision-conditional deployment, rather than revisionless individual-flow writes.
- ADR-004: SQLite stores snapshots and intent together; no unsupported exactly-once execution claim.
- ADR-005: HA options supply the v1 UI; optional features are separate milestones.
- ADR-006: Read-only alpha precedes writes; exact compatibility is established by fixtures and HA acceptance testing.

## Evidence and limits

The sources below support API/platform facts; the design decisions, limits and milestone choices are engineering recommendations for this project.

- Conditional revisions/deployment behavior: [Node-RED POST /flows](https://nodered.org/docs/api/admin/methods/post/flows/); contrast the documented contract of [PUT /flow](https://nodered.org/docs/api/admin/methods/put/flow/).
- Native authentication: [Node-RED authentication](https://nodered.org/docs/api/admin/oauth) and [token exchange](https://nodered.org/docs/api/admin/methods/post/auth/token/).
- Supported method surface: [Node-RED Admin API methods](https://nodered.org/docs/api/admin/methods/). This catalog alone does not establish a context-write API or WebSocket compatibility.
- Protocol handling: [MCP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and [authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). URL-only access is a project-specific local credential model, not OAuth interoperability.
- Packaging/schema/watchdog: [HA app configuration](https://developers.home-assistant.io/docs/apps/configuration/), [repository](https://developers.home-assistant.io/docs/apps/repository/) and [security](https://developers.home-assistant.io/docs/apps/security/).
- Target package caveats: [HA Node-RED documentation](https://github.com/hassio-addons/app-node-red/blob/master/node-red/DOCS.md).
- Build workflow: [HA builder](https://github.com/home-assistant/builder).
- Platform support: [HA support transition](https://www.home-assistant.io/blog/2025/05/22/deprecating-core-and-supervised-installation-methods-and-32-bit-systems/).
- Capability comparison: [ziv-daniel/node-red-mcp](https://github.com/ziv-daniel/node-red-mcp); advertisements were reviewed, not independently tested.

Architecture options and limits are specified. Exact dependency versions, HA package behavior, intended client compatibility and credential-preserving deploy behavior require M0/M4 evidence. GHCR ownership and actual server addresses are deployment inputs. None requires reopening the user's URL-only decision.
