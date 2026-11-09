# syntax=docker/dockerfile:1
# Pinned multi-architecture Home Assistant Alpine base image.
FROM ghcr.io/home-assistant/base:3.24-2026.11.0@sha256:58422480a299b16b6ea376c2167463206d430619ed02b40cd687c8bd6875519e AS builder

WORKDIR /build
RUN apk add --no-cache nodejs npm
COPY gateway/package.json gateway/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY gateway/ ./
RUN npm run build && npm prune --omit=dev

FROM ghcr.io/home-assistant/base:3.24-2026.11.0@sha256:58422480a299b16b6ea376c2167463206d430619ed02b40cd687c8bd6875519e

ARG BUILD_VERSION=0.4.4
ARG BUILD_ARCH=amd64
ENV NODE_RED_MCP_HUB_VERSION=${BUILD_VERSION}
LABEL io.hass.name="Node-RED MCP Hub" \
      io.hass.description="Secure multi-server MCP gateway for Node-RED" \
      io.hass.version=${BUILD_VERSION} \
      io.hass.type=app \
      io.hass.arch=${BUILD_ARCH} \
      org.opencontainers.image.source="https://github.com/vladtsit/node-red-mcp-hub" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
RUN apk add --no-cache nodejs
COPY --from=builder /build/package.json /build/package-lock.json ./
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY run.sh /run.sh
RUN chmod a+x /run.sh

EXPOSE 51844/tcp
CMD [ "/run.sh" ]
