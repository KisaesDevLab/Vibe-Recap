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
# Every start reconciles the volume with the image: a file the firm has not touched (identical
# to what the image last installed, recorded under .seeded/) is replaced by the image's version;
# a file the firm edited is kept and the newer image version is reported. A volume from before
# .seeded/ existed is refreshed wholesale.
PROFILES=/data/form-profiles
SEED=$PROFILES/.seeded
sum() { sha256sum "$1" | cut -d' ' -f1; }
if [ ! -d "$PROFILES" ]; then
  cp -r /app/form-profiles "$PROFILES"
fi
fresh=0
[ -d "$SEED" ] || fresh=1
mkdir -p "$SEED"
for src in /app/form-profiles/*.yaml; do
  name=$(basename "$src")
  dst=$PROFILES/$name
  prev=$SEED/$name
  if [ ! -f "$dst" ] || [ "$fresh" = "1" ]; then
    cp "$src" "$dst"
  elif [ -f "$prev" ] && [ "$(sum "$dst")" = "$(sum "$prev")" ]; then
    cp "$src" "$dst"
  elif [ "$(sum "$dst")" != "$(sum "$src")" ]; then
    echo "form-profiles: keeping the local edit of $name; the image ships a newer version (see $SEED/$name for what it last installed)" >&2
  fi
  cp "$src" "$prev"
done
exec "$@"
