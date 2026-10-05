#!/bin/sh
set -eu
[ "$(id -u)" -eq 1000 ]
exec node /app/boundary-fixture.mjs
