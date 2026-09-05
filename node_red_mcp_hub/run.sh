#!/command/with-contenv bashio
set -eu

# Supervisor owns /data/options.json. Copy only that configuration to a private,
# service-owned runtime file instead of weakening its permissions.
install -d -m 0700 -o gateway -g gateway /run/node-red-mcp-hub
install -m 0600 -o gateway -g gateway /data/options.json /run/node-red-mcp-hub/options.json
exec s6-setuidgid gateway node /app/dist/index.js
