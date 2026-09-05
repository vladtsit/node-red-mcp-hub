# Node-RED MCP Hub

Secure multi-server MCP gateway for managing Node-RED flows, packaged as a Home Assistant app.

Status: architecture and developer handoff complete; application implementation has not started.

- [Architecture and configuration contract](BUILDING_A_MULTI_NODE_RED_MCP_HOME_ASSISTANT_APP.md)
- [Developer milestones and acceptance tests](DEVELOPER_GUIDE.md)
- [Architecture review and decisions](ARCHITECTURE_REVIEW.md)

Planned endpoint: `http://192.168.3.57:1899/private_<secret>`, using private-URL-only access for trusted LAN clients. No bearer header is required. Configure a fresh secret during installation.

App slug: `node_red_mcp_hub`. Repository: `home-assistant-node-red-mcp-hub`. Image: `ghcr.io/<username>/node-red-mcp-hub`.

Start implementation with milestone M0, followed by the read-only alpha in M1.
