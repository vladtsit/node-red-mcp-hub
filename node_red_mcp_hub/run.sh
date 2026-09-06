#!/command/with-contenv bashio
set -eu

runtime_options=/run/node-red-mcp-hub/options.json
path_secret="$(bashio::config 'mcp_path_secret')"
generated_secret=false
umask 077

# The Supervisor configuration schema cannot provide a random default. Persist
# one through its supported API so the secret survives restarts and is visible
# in the add-on Configuration tab without ever being written to the log.
if [ -z "${path_secret}" ] || [ "${path_secret}" = "null" ] || [ "${path_secret}" = "auto" ]; then
    path_secret="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"));')"
    generated_secret=true
    if bashio::addon.option 'mcp_path_secret' "${path_secret}" 2>/dev/null; then
        bashio::log.info 'Generated and saved the MCP path secret. Copy it from the add-on Configuration tab.'
    else
        bashio::log.warning 'Generated an MCP path secret but could not persist it via the Supervisor API; it will be regenerated on next restart.'
    fi
fi

# bashio::addon.port and bashio::addon.option require a reachable Supervisor
# API. It is not available outside Home Assistant (e.g. the CI smoke test), so
# these are best-effort: the gateway itself does not depend on the persisted
# mcp_url option to function.
published_port="$(bashio::addon.port 51844 2>/dev/null || true)"
published_url="$(MCP_HUB_PATH_SECRET="${path_secret}" MCP_HUB_PORT="${published_port}" node /app/dist/mcp-url.js 2>/dev/null || true)"
bashio::addon.option 'mcp_url' "${published_url}" 2>/dev/null \
    || bashio::log.warning 'Could not update the mcp_url option via the Supervisor API.'

# Supervisor owns /data/options.json. Copy it into a private runtime file. The
# restricted Home Assistant app environment does not permit ownership changes,
# so this remains root-owned and the AppArmor-confined gateway runs as root.
mkdir -p /run/node-red-mcp-hub
cp /data/options.json "${runtime_options}"

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
fi

exec node /app/dist/index.js
