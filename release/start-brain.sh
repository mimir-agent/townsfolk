#!/bin/sh
# Starts the townsfolk brain on macOS or Linux. Only the host runs this.
# Keep this terminal open while you play. Ctrl+C stops the brain.
set -eu
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed, or this terminal cannot find it."
  echo "Install the LTS version from https://nodejs.org, then run this again."
  exit 1
fi
exec node "$(dirname "$0")/brain/start.mjs"
