# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspaces --include-workspace-root
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w packages/shared && npm run build -w apps/web

# Unprivileged nginx (uid 101 by default; the Vibe Appliance pins every service to 1000:1000,
# which this image also supports since it writes only to /tmp). Listens on 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
