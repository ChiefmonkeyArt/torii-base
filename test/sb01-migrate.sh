#!/usr/bin/env bash
# Live SB-01 migration for an existing torii-base install on a Torii VPS.
#
# Applies the v0.1.11 ownership hardening + state/ relocation WITHOUT running
# the full bootstrap.sh (no apt/certbot/npm re-install). Run as root (or with
# passwordless sudo) on the VPS.
#
# Order matters: copy state FIRST (both old and new locations hold the data),
# then deploy the new sidecar code + nginx include + unit, restart, verify,
# and only THEN root-own /opt/torii and remove the old root-level files.
#
#   sudo -E bash sb01-migrate.sh
set -euo pipefail

TORII_ROOT="${TORII_ROOT:-/opt/torii}"
TORII_USER="torii"
STATE_DIR="$TORII_ROOT/state"
VER="v0.1.12"
RAW="https://raw.githubusercontent.com/ChiefmonkeyArt/torii-base/$VER"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[31mxx  %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
[[ -d "$TORII_ROOT" ]] || die "$TORII_ROOT not found"

# ── 1. Deploy v0.1.11 files (sidecar code, nginx unit, CLI) ────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for f in "sidecar/index.mjs" "systemd/torii-base-sidecar.service" "bin/torii"; do
  base="$(basename "$f")"
  curl -fsSL "$RAW/$f" -o "$TMP/$base" || die "failed to fetch $f"
done

# ── 2. Seed state/ with the current runtime state (copy, keep old in place) ─
install -d -m 0750 -o "$TORII_USER" -g "$TORII_USER" "$STATE_DIR"
for f in registry.json root_app.conf homepage.json; do
  if [[ -f "$TORII_ROOT/$f" && ! -f "$STATE_DIR/$f" ]]; then
    cp -a "$TORII_ROOT/$f" "$STATE_DIR/$f"
  fi
done
if [[ -d "$TORII_ROOT/homepage" && ! -d "$STATE_DIR/homepage" ]]; then
  cp -a "$TORII_ROOT/homepage" "$STATE_DIR/homepage"
fi
chown -R "$TORII_USER:$TORII_USER" "$STATE_DIR"

# ── 3. Deploy new code + config + unit ─────────────────────────────────────
install -m 0644 -o root -g root "$TMP/index.mjs" "$TORII_ROOT/sidecar/index.mjs"
install -m 0644 -o root -g root "$TMP/torii-base-sidecar.service" /etc/systemd/system/torii-base-sidecar.service
install -m 0755 -o root -g root "$TMP/torii" /usr/local/bin/torii
# Point the live nginx conf's root include at state/ (idempotent).
sed -i 's#/opt/torii/root_app\.conf#/opt/torii/state/root_app.conf#' /etc/nginx/sites-available/torii.conf

systemctl daemon-reload
systemctl restart torii-base-sidecar.service

# ── 4. Verify sidecar + registry BEFORE touching nginx/ownership ───────────
sleep 2
curl -fsS http://127.0.0.1:8780/torii/healthz >/dev/null || die "sidecar unhealthy after restart"
curl -fsS http://127.0.0.1:8780/torii/apps.json >/dev/null || die "apps.json unreachable"
log "sidecar healthy; registry served from state/"

# ── 5. Reload nginx against the new include path ───────────────────────────
nginx -t >/dev/null || die "nginx -t failed"
systemctl reload nginx
log "nginx reloaded with state/root_app.conf"

# ── 6. Ownership hardening (root-own) + remove legacy root-level files ─────
chown root:root "$TORII_ROOT"
chown -R root:root "$TORII_ROOT/launcher" "$TORII_ROOT/sidecar" "$TORII_ROOT/nginx-fragments" "$TORII_ROOT/bin"
chmod 0640 "$TORII_ROOT/env"
chown root:root "$TORII_ROOT/env"
for f in registry.json root_app.conf homepage.json; do
  [[ -f "$TORII_ROOT/$f" ]] && rm -f "$TORII_ROOT/$f"
done
[[ -d "$TORII_ROOT/homepage" ]] && rm -rf "$TORII_ROOT/homepage"

# ── 7. Final verification ──────────────────────────────────────────────────
curl -fsS http://127.0.0.1:8780/torii/healthz >/dev/null || die "sidecar unhealthy after ownership change"
stat -c '  /opt/torii -> %U:%G' "$TORII_ROOT"
stat -c '  env       -> %U:%G (%a)' "$TORII_ROOT/env"
stat -c '  state     -> %U:%G' "$STATE_DIR"
log "SB-01 migration complete. Verify https://<domain>/ still serves correctly."