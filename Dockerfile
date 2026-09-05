# syntax=docker/dockerfile:1.7

# ---- web: build the React app ------------------------------------------------
FROM node:24-alpine3.24 AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- server: compile TypeScript and keep production deps only ----------------
FROM node:24-alpine3.24 AS server
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund --ignore-scripts
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# ---- runtime -----------------------------------------------------------------
FROM node:24-alpine3.24
# ffmpeg 8.x from Alpine (libx264, libzimg/zscale, tonemap), su-exec for PUID/PGID, tini to reap ffmpeg children.
# The grep lines fail the build early if the distro ffmpeg ever loses the tone-mapping filters.
RUN apk add --no-cache ffmpeg su-exec tini tzdata \
 && ffmpeg -hide_banner -version | head -n 1 \
 && ffmpeg -hide_banner -filters 2>/dev/null | grep -qE '^\s*\S+\s+zscale\s' \
 && ffmpeg -hide_banner -filters 2>/dev/null | grep -qE '^\s*\S+\s+tonemap\s'

WORKDIR /app
ENV NODE_ENV=production \
    PORT=7727 \
    MEDIA_PATH=/media \
    OUTPUT_PATH=/output \
    CONFIG_PATH=/config \
    PUID=99 \
    PGID=100 \
    LOG_LEVEL=info \
    SCAN_INTERVAL_MINUTES=60

COPY --from=server /app/node_modules ./node_modules
COPY --from=server /app/dist ./dist
COPY --from=server /app/package.json ./package.json
COPY --from=web /app/web/dist ./web/dist
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /media /output /config

# Stamped by the GitHub workflow so /api/health can report which build is running.
ARG GIT_SHA=dev
ARG BUILD_DATE=
ENV REEL_EXPORTER_BUILD=$GIT_SHA \
    REEL_EXPORTER_BUILD_DATE=$BUILD_DATE

EXPOSE 7727
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["node", "dist/index.js"]
