# syntax=docker/dockerfile:1

# --- build stage: compile the Angular SSR app (browser + server bundles) ---
FROM node:26-slim AS build
WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# Build the SSR output into dist/agent-board.
COPY . .
RUN npm run build

# --- runtime stage: just Node + the self-contained server bundle ---
# The Angular server bundle inlines all npm dependencies, so the runtime image
# needs no node_modules — only the built dist/ and a modern Node (for the
# built-in node:sqlite module).
FROM node:26-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4111 \
    AGENT_BOARD_DB=/data/board.db \
    AGENT_BOARD_FILES_DIR=/data/files

# Unprivileged user; /data (SQLite + attachments) must be writable by it.
RUN groupadd --system --gid 10001 board \
 && useradd --system --uid 10001 --gid board --home-dir /app --shell /usr/sbin/nologin board \
 && mkdir -p /data && chown board:board /data

COPY --from=build --chown=root:root /app/dist ./dist

USER 10001:10001
VOLUME ["/data"]
EXPOSE 4111

# Sign-in is required by default (fail closed). See README "Authentication".
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4111)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "dist/agent-board/server/server.mjs"]
