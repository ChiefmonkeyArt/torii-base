#!/usr/bin/env bash
# Block until the torii-base sidecar is accepting requests, then exit 0. Exit 1
# if it never becomes ready within the retry budget.
#
# Why bootstrap needs this: the systemd unit is Type=simple, so
# `systemctl restart` returns at process exec — NOT at readiness. But the
# sidecar runs reconcileRoot() (which rewrites root_app.conf to match the
# registry, upgrading a pre-0.1.3 comment-only stub into a real `location = /`
# block) *before* it calls app.listen() — see sidecar/index.mjs start(). So a
# successful /torii/healthz response is a hard, timing-independent guarantee
# that `/`'s nginx include has already been reconciled. bootstrap.sh waits on
# this before it validates and reloads nginx, so an upgrade can never reload
# against a stale, owner-less root_app.conf and then silently report success.
#
# Usage: wait-for-sidecar.sh <health-url> [retries] [interval-seconds]
set -euo pipefail

URL="${1:?usage: wait-for-sidecar.sh <health-url> [retries] [interval-seconds]}"
RETRIES="${2:-50}"
INTERVAL="${3:-0.2}"

for ((i = 0; i < RETRIES; i++)); do
  if curl -fsS -o /dev/null "$URL" 2>/dev/null; then
    exit 0
  fi
  sleep "$INTERVAL"
done

exit 1
