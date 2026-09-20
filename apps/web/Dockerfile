# syntax=docker/dockerfile:1
# The install needs a GitHub Packages token as a BuildKit secret; see apps/api/Dockerfile.
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
COPY apps/web apps/web
RUN npm run build -w packages/shared && npm run build -w apps/web

# Unprivileged nginx (uid 101 by default; the Vibe Appliance pins every service to 1000:1000,
# which this image also supports since it writes only to /tmp). Listens on 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
