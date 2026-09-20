#!/bin/sh
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  if [ "$(stat -c %u /data)" = "0" ]; then chown node:node /data; fi
  for d in /data/keys /data/blobs /data/orphans; do
    if [ -e "$d" ] && [ "$(stat -c %u "$d")" = "0" ]; then chown -R node:node "$d"; fi
  done
  exec gosu node "$0" "$@"
fi
cd /app/apps/api
case "$1" in
  serve|"") exec node dist/index.js ;;
  seed-admin) shift; exec node dist/cli/seed-admin.js "$@" ;;
  migrate) shift; exec node dist/cli/migrate.js "$@" ;;
  rotate-master-key) shift; exec node dist/cli/rotate-master-key.js "$@" ;;
  # Single sign-on emergency account (Q57): breakglass ensure|rotate|status [--json]. The CLI reads
  # "vibeAuth".adapter from ./package.json, so it must run from here; modules live at /app only.
  breakglass) exec node /app/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js "$@" ;;
  *) exec "$@" ;;
esac
