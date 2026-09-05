# Node-RED MCP Hub

A small Home Assistant app wrapping multiple Node-RED Admin APIs through one MCP endpoint.

HTTP port **51844** references Morse's 1844 Washington–Baltimore telegraph demonstration. [Library of Congress](https://www.loc.gov/item/mcc00054/)

Planned URL: http://192.168.3.57:51844/private_<secret>, with URL-only access for trusted LAN clients.

- [Simple architecture and API tool mapping](BUILDING_A_MULTI_NODE_RED_MCP_HOME_ASSISTANT_APP.md)
- [Developer instructions](DEVELOPER_GUIDE.md)
- [What was simplified](ARCHITECTURE_REVIEW.md)

No database, flow history or approval workflow. Node-RED owns the flows; the hub forwards requests.

Slug: node_red_mcp_hub. Repository: home-assistant-node-red-mcp-hub. Image: ghcr.io/<username>/node-red-mcp-hub.

Status: implementation complete. The Home Assistant add-on, strict TypeScript
gateway, focused integration tests, and CI workflow are included. See the
[add-on documentation](node_red_mcp_hub/DOCS.md) for installation and client
configuration.
