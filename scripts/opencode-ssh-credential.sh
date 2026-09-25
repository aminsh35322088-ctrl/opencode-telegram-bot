#!/bin/sh
set -eu
exec /usr/sbin/runuser -u node -- node /app/scripts/ssh-credential-admin.mjs "$@"
