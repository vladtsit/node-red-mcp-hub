# Security Policy

## Supported versions

Security fixes are applied to the latest released version. Upgrade the Home
Assistant app before reporting an issue that may already be fixed.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include MCP path
secrets, Node-RED credentials, tokens, flow exports, or private network details
in public reports. Use GitHub's **Report a vulnerability** function in the
repository Security tab. Include the affected version, impact, minimal
reproduction steps, and any relevant sanitized logs.

Rotate `mcp_path_secret` and any potentially exposed upstream credentials
immediately. Keep the MCP endpoint on a trusted LAN or VPN; use a trusted HTTPS
reverse proxy for access across an untrusted network.
