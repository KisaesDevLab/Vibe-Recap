#!/bin/sh
set -e
cd /app/apps/api
case "$1" in
  serve|"") exec node dist/index.js ;;
  seed-admin) shift; exec node dist/cli/seed-admin.js "$@" ;;
  *) exec "$@" ;;
esac
