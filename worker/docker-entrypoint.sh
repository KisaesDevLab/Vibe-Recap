#!/bin/sh
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data /models
  chown worker:worker /models
  # /data is shared with the api container (uid 1000). Only fix it if it is still root's,
  # which happens when Docker creates a fresh bind-mount directory on the host.
  if [ "$(stat -c %u /data)" = "0" ]; then chown worker:worker /data; fi
  exec gosu worker "$0" "$@"
fi
# Form profiles live on the shared volume so a firm can fix one without rebuilding the image.
# Seeded from the image on first start; existing files are never overwritten.
if [ ! -d /data/form-profiles ]; then
  cp -r /app/form-profiles /data/form-profiles
fi
exec "$@"
