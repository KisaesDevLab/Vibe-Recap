# syntax=docker/dockerfile:1
# Build context is the repo root so the shared workspace package is available.
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspaces --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w packages/shared && npm run build -w apps/api \
 && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini gosu && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /src/packages/shared/dist ./packages/shared/dist
COPY --from=build /src/apps/api/package.json ./apps/api/package.json
COPY --from=build /src/apps/api/dist ./apps/api/dist
COPY --from=build /src/apps/api/drizzle ./apps/api/drizzle
COPY --from=build /src/apps/api/data ./apps/api/data
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
# Starts as root only to fix /data ownership on a fresh bind mount, then drops to uid 1000 (node).
# The worker container runs as the same uid so both can read the master key and blobs.
EXPOSE 3000
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["serve"]
