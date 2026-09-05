#!/bin/sh
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data /models
  chown worker:worker /models
  # /data is shared with the api container (uid 1000). Only fix it if it is still root's,
  # which happens when Docker creates a fresh bind-mount directory on the host.
  if [ "$(stat -c %u /data)" = "0" ]; then chown worker:worker /data; fi
  exec gosu worker "$@"
fi
exec "$@"
