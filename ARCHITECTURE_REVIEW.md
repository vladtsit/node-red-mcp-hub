# Architecture simplification

The current design is a thin MCP wrapper around configured Node-RED Admin APIs. It supersedes the previous architecture review and its requirements.

Display name: **Node-RED MCP Hub**. Internal/default host HTTP port: **51844**, with a developer comment referencing the 1844 Washington–Baltimore telegraph demonstration. Slug, repository and image identifiers remain unchanged.

Removed: SQLite, flow version/history storage, automatic rollback, proposal
tokens, approval stages, durable operation journals, reconciliation commands,
graph planners, node-type permission engines and the six-stage delivery
process. The production implementation does keep bounded, private pre-write
snapshots as a simple recovery primitive.

Kept: one private URL on port 51844, explicit server_id, direct API tools,
read_only switches, separate target credentials, bounded requests, sanitized
logs and standard HA packaging. Added compact discovery tools, structured MCP
results, safety annotations, secret redaction and global/per-target tool policy.

Individual flow create/update/delete maps directly to Node-RED. These calls have native concurrency behavior, without gateway revision checks. The optional full-runtime deploy tool passes Node-RED's own rev field and reports conflicts; the hub stores no versions.

Writes execute immediately. If a connection fails after a write, the outcome
may be uncertain; read Node-RED to inspect it. By default the hub saves a raw,
atomic snapshot before each write and blocks the mutation if that snapshot
fails. Recovery remains a deliberate manual operation; there is no automatic
rollback.

[Architecture](BUILDING_A_MULTI_NODE_RED_MCP_HOME_ASSISTANT_APP.md) and
[developer instructions](DEVELOPER_GUIDE.md) describe this implemented scope.
