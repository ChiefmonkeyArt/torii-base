#!/usr/bin/env bash
# torii-base bootstrap — establishes /opt/torii on a fresh Ubuntu 22.04/24.04 host.
#
# Usage (as root, from a checkout of the torii-base repo):
#   sudo TORII_DOMAIN=torii.example.com ./bootstrap.sh
#
# Or piped:
#   sudo TORII_DOMAIN=torii.example.com bash -c "$(curl -fsSL https://raw.githubusercontent.com/ChiefmonkeyArt/torii-base/main/bootstrap.sh)"
#
# What it does (idempotently):
#   1. apt-installs: nginx, certbot, python3-certbot-nginx, curl, jq, ca-certificates
#   2. Creates the `torii` system user and /opt/torii tree
#   3. Copies launcher/, nginx/, bin/torii, sidecar/ from the repo into /opt/torii
#   4. Generates TORII_ADMIN_TOKEN and writes /opt/torii/env (0600, root:torii)
#   5. Installs the sidecar's Node deps
#   6. Writes systemd unit for torii-base-sidecar.service and enables it
#   7. Writes /etc/nginx/sites-available/torii.conf, symlinks, removes default
#   8. Obtains a Let's Encrypt cert for $TORII_DOMAIN
#   9. Reloads nginx
#
# NOT done here (delegated to per-app installers): app builds, per-app systemd
# units, per-app nginx fragments.

set -euo pipefail

TORII_ROOT="${TORII_ROOT:-/opt/torii}"
TORII_USER="${TORII_USER:-torii}"
TORII_SIDECAR_PORT="${TORII_SIDECAR_PORT:-8780}"
TORII_DOMAIN="${TORII_DOMAIN:-}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
SKIP_CERTBOT="${SKIP_CERTBOT:-0}"

log()  { printf "\033[36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[33m--  %s\033[0m\n" "$*" >&2; }
die()  { printf "\033[31mxx  %s\033[0m\n" "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "bootstrap must run as root"
[[ -n "$TORII_DOMAIN" ]] || die "set TORII_DOMAIN=<yourdomain> in the environment"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -d "$SCRIPT_DIR/launcher" && -d "$SCRIPT_DIR/nginx" && -d "$SCRIPT_DIR/sidecar" && -f "$SCRIPT_DIR/bin/torii" && -f "$SCRIPT_DIR/lib/wait-for-sidecar.sh" ]] \
  || die "expected launcher/, nginx/, sidecar/, bin/torii, lib/wait-for-sidecar.sh under $SCRIPT_DIR"

log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx curl jq ca-certificates gnupg

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
  log "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

log "Creating $TORII_USER user"
id -u "$TORII_USER" >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --home "$TORII_ROOT" "$TORII_USER"

log "Laying down $TORII_ROOT"
install -d -m 0755 -o "$TORII_USER" -g "$TORII_USER" "$TORII_ROOT"
install -d -m 0755 -o "$TORII_USER" -g "$TORII_USER" "$TORII_ROOT/launcher" "$TORII_ROOT/launcher/assets"
install -d -m 0755 -o "$TORII_USER" -g "$TORII_USER" "$TORII_ROOT/nginx-fragments"
install -d -m 0755 -o "$TORII_USER" -g "$TORII_USER" "$TORII_ROOT/sidecar"
# Personal homepage: the sidecar renders index.html here; nginx serves it at /
# when the homepage is activated as root_app.
install -d -m 0755 -o "$TORII_USER" -g "$TORII_USER" "$TORII_ROOT/homepage"
install -d -m 0755 -o "root"        -g "root"        "$TORII_ROOT/bin"

cp -a "$SCRIPT_DIR/launcher/index.html"        "$TORII_ROOT/launcher/index.html"
cp -a "$SCRIPT_DIR/launcher/assets/."          "$TORII_ROOT/launcher/assets/"
cp -a "$SCRIPT_DIR/sidecar/."                  "$TORII_ROOT/sidecar/"
cp -a "$SCRIPT_DIR/bin/torii"                  "/usr/local/bin/torii"
chmod 0755 /usr/local/bin/torii

chown -R "$TORII_USER:$TORII_USER" "$TORII_ROOT/launcher" "$TORII_ROOT/sidecar" "$TORII_ROOT/nginx-fragments" "$TORII_ROOT/homepage"

log "Generating admin token (if missing)"
if [[ ! -f "$TORII_ROOT/env" ]]; then
  TOKEN="$(head -c 48 /dev/urandom | base64 | tr -d '=+/' | head -c 48)"
  cat > "$TORII_ROOT/env" <<EOF
TORII_ROOT=$TORII_ROOT
TORII_ADMIN_TOKEN=$TOKEN
TORII_SIDECAR_PORT=$TORII_SIDECAR_PORT
TORII_SIDECAR_HOST=127.0.0.1
EOF
  chmod 0640 "$TORII_ROOT/env"
  chown root:"$TORII_USER" "$TORII_ROOT/env"
fi

if [[ ! -f "$TORII_ROOT/registry.json" ]]; then
  echo '{"apps":[],"root_app":null}' > "$TORII_ROOT/registry.json"
  chown "$TORII_USER:$TORII_USER" "$TORII_ROOT/registry.json"
fi
[[ -f "$TORII_ROOT/root_app.conf" ]] || {
  # This include is the single owner of `location = /` (torii.conf has no
  # fallback). Default state serves the launcher; the sidecar rewrites it on
  # set-root / homepage activation and also reconciles it on boot.
  cat > "$TORII_ROOT/root_app.conf" <<EOF
# Written by torii-base bootstrap. root_app is unset; the launcher owns /.
location = / {
    root $TORII_ROOT/launcher;
    try_files /index.html =404;
}
EOF
  chown "$TORII_USER:$TORII_USER" "$TORII_ROOT/root_app.conf"
}

log "Installing sidecar deps"
(cd "$TORII_ROOT/sidecar" && sudo -u "$TORII_USER" npm ci --omit=dev --silent 2>/dev/null || sudo -u "$TORII_USER" npm install --omit=dev --silent)

log "Installing sudoers snippet for $TORII_USER -> nginx"
# The sidecar runs as the unprivileged 'torii' user but has to reload nginx
# after registering an app. Grant passwordless sudo for exactly two nginx
# invocations, nothing else. visudo -cf catches syntax errors before we
# clobber /etc/sudoers.d/.
NGINX_BIN="$(command -v nginx || echo /usr/sbin/nginx)"
SUDOERS_TMP="$(mktemp)"
cat > "$SUDOERS_TMP" <<EOF
# Written by torii-base bootstrap.sh. Do not edit by hand.
# Allows the '$TORII_USER' system user to test + reload nginx (and only that).
$TORII_USER ALL=(root) NOPASSWD: $NGINX_BIN -t, $NGINX_BIN -s reload
EOF
chmod 0440 "$SUDOERS_TMP"
if visudo -cf "$SUDOERS_TMP" >/dev/null; then
  install -m 0440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/torii-nginx
  rm -f "$SUDOERS_TMP"
else
  rm -f "$SUDOERS_TMP"
  echo "ERROR: generated sudoers snippet failed visudo validation" >&2
  exit 1
fi

log "Installing systemd unit"
install -m 0644 "$SCRIPT_DIR/systemd/torii-base-sidecar.service" /etc/systemd/system/torii-base-sidecar.service
systemctl daemon-reload
systemctl enable torii-base-sidecar.service
# restart (not `enable --now`) so upgrades actually load the new sidecar code:
# on an existing install the service is already running, and `enable --now`
# would be a no-op — the new reconcileRoot() would never run. Restarting here,
# before the final nginx validate/reload below, lets reconcileRoot() rewrite a
# stale comment-only root_app.conf into a valid `location = /` block so nginx
# validates against the correct include.
systemctl restart torii-base-sidecar.service

# `restart` returns at process exec, not readiness (the unit is Type=simple), so
# it does NOT guarantee reconcileRoot() has run yet. Block on /torii/healthz
# before touching nginx: the sidecar reconciles root_app.conf *before* it
# listens (see sidecar/index.mjs start()), so a healthy response is a hard
# guarantee the `/` include is correct. Fail closed — if the sidecar never comes
# up we abort here, before rewriting/reloading nginx, leaving the existing
# config and current owner of / intact rather than reloading an owner-less root.
log "Waiting for sidecar readiness (guarantees root_app.conf reconcile before nginx reload)"
"$SCRIPT_DIR/lib/wait-for-sidecar.sh" "http://127.0.0.1:${TORII_SIDECAR_PORT}/torii/healthz" \
  || die "sidecar did not become ready; aborting before nginx reload (existing nginx config left intact)"

log "Writing nginx config for $TORII_DOMAIN"
sed "s#TORII_DOMAIN#$TORII_DOMAIN#g" "$SCRIPT_DIR/nginx/torii.conf" > /etc/nginx/sites-available/torii.conf
ln -sf /etc/nginx/sites-available/torii.conf /etc/nginx/sites-enabled/torii.conf
rm -f /etc/nginx/sites-enabled/default

# Certbot HTTP-01 needs this webroot to exist before nginx reload succeeds.
install -d -m 0755 /var/www/certbot

# We need a temporary HTTP-only server block during first cert issuance,
# because torii.conf references certs that don't exist yet.
if [[ "$SKIP_CERTBOT" != "1" ]] && [[ ! -f "/etc/letsencrypt/live/$TORII_DOMAIN/fullchain.pem" ]]; then
  log "Issuing Let's Encrypt cert for $TORII_DOMAIN (temporarily serving HTTP-only)"
  cat > /etc/nginx/sites-enabled/torii-acme.conf <<EOF
server {
    listen 80;
    server_name $TORII_DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 200 "torii-base bootstrap in progress\n"; add_header Content-Type text/plain; }
}
EOF
  rm -f /etc/nginx/sites-enabled/torii.conf
  nginx -t && systemctl reload nginx
  CERTBOT_EMAIL_ARG=()
  if [[ -n "$LETSENCRYPT_EMAIL" ]]; then CERTBOT_EMAIL_ARG=(--email "$LETSENCRYPT_EMAIL"); else CERTBOT_EMAIL_ARG=(--register-unsafely-without-email); fi
  certbot certonly --webroot -w /var/www/certbot -d "$TORII_DOMAIN" \
    --non-interactive --agree-tos "${CERTBOT_EMAIL_ARG[@]}"
  rm -f /etc/nginx/sites-enabled/torii-acme.conf
  ln -sf /etc/nginx/sites-available/torii.conf /etc/nginx/sites-enabled/torii.conf
fi

log "Reloading nginx"
nginx -t
systemctl reload nginx

log "Done. Try:  https://$TORII_DOMAIN/"
log "Admin token lives at $TORII_ROOT/env (root:$TORII_USER, 0640)"
log "Health:     curl http://127.0.0.1:$TORII_SIDECAR_PORT/torii/healthz"
