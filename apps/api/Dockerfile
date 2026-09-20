# syntax=docker/dockerfile:1
# Build context is the repo root so the shared workspace package is available.
#
# `@kisaesdevlab/vibe-auth` (single sign-on, Q57) comes from GitHub Packages, which wants a token
# with read:packages even to read. `.npmrc` maps the scope and holds no credential. The token
# arrives as a BuildKit secret, is written to a throwaway user npmrc and deleted in the same RUN:
# never an ARG or ENV, so it lands in no layer and no image history.
#   NODE_AUTH_TOKEN=$(gh auth token) docker compose build
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json* tsconfig.base.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=NODE_AUTH_TOKEN,required=true \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/NODE_AUTH_TOKEN)" > /root/.npmrc \
 && npm ci --workspaces --include-workspace-root \
  ; status=$? ; rm -f /root/.npmrc ; exit $status
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
# The CLI subcommands are handled by the entrypoint, but orchestrators run them with
# `docker exec <container> seed-admin`, which bypasses the entrypoint and needs a real
# executable on PATH (the Vibe Appliance seeds the first admin this way; Q47).
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data \
 && for cmd in seed-admin migrate rotate-master-key breakglass; do \
      printf '#!/bin/sh\nexec /usr/local/bin/docker-entrypoint.sh %s "$@"\n' "$cmd" > /usr/local/bin/$cmd && chmod +x /usr/local/bin/$cmd; \
    done
# Starts as root only to fix /data ownership on a fresh bind mount, then drops to uid 1000 (node).
# The worker container runs as the same uid so both can read the master key and blobs.
EXPOSE 3000
ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["serve"]
