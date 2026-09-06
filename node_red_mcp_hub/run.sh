#!/command/with-contenv bashio
set -eu

runtime_options=/run/node-red-mcp-hub/options.json
path_secret="$(bashio::config 'mcp_path_secret')"
generated_secret=false

# The Supervisor configuration schema cannot provide a random default. Persist
# one through its supported API so the secret survives restarts and is visible
# in the add-on Configuration tab without ever being written to the log.
if [ -z "${path_secret}" ] || [ "${path_secret}" = "null" ] || [ "${path_secret}" = "auto" ]; then
    path_secret="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"));')"
    bashio::addon.option 'mcp_path_secret' "${path_secret}"
    generated_secret=true
    bashio::log.info 'Generated and saved the MCP path secret. Copy it from the add-on Configuration tab.'
fi

# Supervisor owns /data/options.json. Copy only that configuration to a private,
# service-owned runtime file instead of weakening its permissions.
install -d -m 0700 -o gateway -g gateway /run/node-red-mcp-hub
install -m 0600 -o gateway -g gateway /data/options.json "${runtime_options}"

# Use the new secret immediately even if the Supervisor has not yet refreshed
# /data/options.json after bashio::addon.option returned.
if [ "${generated_secret}" = true ]; then
    MCP_HUB_PATH_SECRET="${path_secret}" node --input-type=module -e '
        import { readFileSync, writeFileSync } from "node:fs";
        const file = process.argv[1];
        const options = JSON.parse(readFileSync(file, "utf8"));
        options.mcp_path_secret = process.env.MCP_HUB_PATH_SECRET;
        writeFileSync(file, JSON.stringify(options));
    ' "${runtime_options}"
    chown gateway:gateway "${runtime_options}"
    chmod 0600 "${runtime_options}"
fi

exec s6-setuidgid gateway node /app/dist/index.js
