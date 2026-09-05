#!/bin/sh
# Drops from root to PUID:PGID (Unraid default nobody:users = 99:100) after fixing
# ownership of /config. /media is read-only by contract and is never touched;
# /output is only checked, never chowned recursively.
set -eu

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-022}"
CONFIG_PATH="${CONFIG_PATH:-/config}"
OUTPUT_PATH="${OUTPUT_PATH:-/output}"
MEDIA_PATH="${MEDIA_PATH:-/media}"

log() { echo "[entrypoint] $*"; }

umask "$UMASK"

if [ "$(id -u)" != "0" ]; then
  log "running as uid=$(id -u) gid=$(id -g) (started with --user); skipping user setup"
  [ -w "$CONFIG_PATH" ] || log "WARNING: $CONFIG_PATH is not writable; caches and transcodes fall back to a temporary directory"
  [ -w "$OUTPUT_PATH" ] || log "WARNING: $OUTPUT_PATH is not writable; screenshots and clips will fail"
  exec "$@"
fi

# Group: reuse an existing name for PGID (GID 100 is 'users' on Alpine), else create one.
GROUP_NAME="$(awk -F: -v g="$PGID" '$3==g{print $1; exit}' /etc/group || true)"
if [ -z "$GROUP_NAME" ]; then
  addgroup -g "$PGID" reelexporter
  GROUP_NAME=reelexporter
fi

# User: UID 99 does not exist on Alpine (nobody is 65534); create it if needed.
USER_NAME="$(awk -F: -v u="$PUID" '$3==u{print $1; exit}' /etc/passwd || true)"
if [ -z "$USER_NAME" ]; then
  adduser -D -H -u "$PUID" -G "$GROUP_NAME" -s /sbin/nologin reelexporter
  USER_NAME=reelexporter
fi
log "running as $USER_NAME($PUID):$GROUP_NAME($PGID) umask=$UMASK"

mkdir -p "$CONFIG_PATH" "$CONFIG_PATH/cache" "$CONFIG_PATH/transcode" 2>/dev/null || true
if [ -d "$CONFIG_PATH" ]; then
  if [ "$(stat -c %u "$CONFIG_PATH")" != "$PUID" ] || [ "$(stat -c %g "$CONFIG_PATH")" != "$PGID" ]; then
    # Top level belongs to someone else (first start or changed PUID): fix the whole tree once.
    chown -R "$PUID:$PGID" "$CONFIG_PATH" 2>/dev/null || log "WARNING: could not chown $CONFIG_PATH"
  else
    # Only the folders this script just created may still belong to root.
    chown "$PUID:$PGID" "$CONFIG_PATH/cache" "$CONFIG_PATH/transcode" 2>/dev/null || true
  fi
fi

if ! su-exec "$PUID:$PGID" sh -c "test -d '$OUTPUT_PATH' && test -w '$OUTPUT_PATH'"; then
  log "WARNING: $OUTPUT_PATH is NOT writable by $PUID:$PGID. Screenshots and clips will fail."
  log "         Fix on the host, e.g.: chown -R $PUID:$PGID <host path mapped to $OUTPUT_PATH>"
fi
# Media sources are added in the app; warn early about mounts the app user cannot read.
for m in "$MEDIA_PATH" /media*; do
  [ -d "$m" ] || continue
  if ! su-exec "$PUID:$PGID" sh -c "test -r '$m' && test -x '$m'"; then
    log "WARNING: $m is not readable by $PUID:$PGID"
  fi
done

exec su-exec "$PUID:$PGID" "$@"
