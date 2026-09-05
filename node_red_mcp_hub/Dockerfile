# Pinned multi-architecture Home Assistant base image; update deliberately.
FROM ghcr.io/home-assistant/base:3.24-2026.08.0

ARG BUILD_VERSION=0.1.0
ARG BUILD_ARCH=amd64
LABEL io.hass.version=${BUILD_VERSION} \
      io.hass.type=app \
      io.hass.arch=${BUILD_ARCH}

WORKDIR /app
RUN apk add --no-cache nodejs npm \
    && addgroup -S gateway \
    && adduser -S -D -H -G gateway gateway
COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci
COPY gateway/ ./
RUN npm run build && npm prune --omit=dev
COPY run.sh /run.sh
RUN chmod a+x /run.sh

EXPOSE 51844/tcp
CMD [ "/run.sh" ]
