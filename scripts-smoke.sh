#!/usr/bin/env sh
set -eu
curl -fsS http://localhost:${PORT:-3000}/health
echo
