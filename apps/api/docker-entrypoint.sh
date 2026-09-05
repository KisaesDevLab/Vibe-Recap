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
  rotate-master-key) shift; exec node dist/cli/rotate-master-key.js "$@" ;;
  *) exec "$@" ;;
esac
