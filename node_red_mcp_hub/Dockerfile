# syntax=docker/dockerfile:1
# Pinned multi-architecture Home Assistant Alpine base image.
FROM ghcr.io/home-assistant/base:3.24-2026.08.0@sha256:93ef607824e3f27e868f11b10938283a98bf880ed57bcf8eaa81c6c2d521f6f5 AS builder

WORKDIR /build
RUN apk add --no-cache nodejs npm
COPY gateway/package.json gateway/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY gateway/ ./
RUN npm run build && npm prune --omit=dev

FROM ghcr.io/home-assistant/base:3.24-2026.08.0@sha256:93ef607824e3f27e868f11b10938283a98bf880ed57bcf8eaa81c6c2d521f6f5

ARG BUILD_VERSION=0.3.3
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
