#!/bin/sh
set -eu
exec su -s /bin/sh node -c 'exec node /app/scripts/ssh-credential-admin.mjs "$@"' -- "$@"
