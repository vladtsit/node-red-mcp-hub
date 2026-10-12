# syntax=docker/dockerfile:1
# Pinned multi-architecture Home Assistant Alpine base image.
FROM ghcr.io/home-assistant/base:3.24-2026.10.0@sha256:8fde4170393bdf7a121ea4d6e34b417e1d0b90125948459f9f9f70cdf5d77c16 AS builder

WORKDIR /build
RUN apk add --no-cache nodejs npm
COPY gateway/package.json gateway/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY gateway/ ./
RUN npm run build && npm prune --omit=dev

FROM ghcr.io/home-assistant/base:3.24-2026.10.0@sha256:8fde4170393bdf7a121ea4d6e34b417e1d0b90125948459f9f9f70cdf5d77c16

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
