#!/usr/bin/env bash
# SB-01 container proof (run as root in an isolated container/VM).
#
# The historic layout owned /opt/torii by `torii` and `env` as root:torii 0640,
# so a compromised sidecar could rename/replace the root-consumed `env` and a
# later privileged `torii` CLI run that `source`d it would execute arbitrary
# code as root. The fix root-owns /opt/torii + `env`, moves runtime state into a
# torii-owned state/ dir, and parses env as fixed KV (systemd EnvironmentFile)
# instead of sourcing it.
#
# This script reproduces the exact post-bootstrap ownership and asserts the
# boundary: `torii` must NOT be able to rename/replace `env` (or write anything
# else under a root-owned parent) but MUST be able to write its state/ dir, and
# `bin/torii` must not `source` the env file.
#
#   sudo ./test/sb01-ownership.test.sh

set -euo pipefail

TORII_ROOT="${TORII_ROOT:-/opt/torii}"
TORII_USER="torii"

fail()  { echo "FAIL: $*" >&2; exit 1; }
pass()  { echo "  ok: $*"; }

echo "== SB-01 ownership boundary proof =="

# --- set up the minimal post-bootstrap layout bootstrap.sh now produces -----
id -u "$TORII_USER" >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --home "$TORII_ROOT" "$TORII_USER"

rm -rf "$TORII_ROOT"
install -d -m 0755 "$TORII_ROOT"
chown root:root "$TORII_ROOT"
install -d -m 0755 "$TORII_ROOT/launcher" "$TORII_ROOT/sidecar" "$TORII_ROOT/bin" "$TORII_ROOT/nginx-fragments"
install -d -m 0750 "$TORII_ROOT/state" "$TORII_ROOT/state/homepage"
chown -R root:root "$TORII_ROOT/launcher" "$TORII_ROOT/sidecar" "$TORII_ROOT/bin" "$TORII_ROOT/nginx-fragments"
chown -R "$TORII_USER:$TORII_USER" "$TORII_ROOT/state"

# env: root-consumed config, must be root-owned under a root-owned parent.
printf 'TORII_SESSION_SECRET=deadbeef\nTORII_ADMIN_NPUB=npub1test\n' > "$TORII_ROOT/env"
chmod 0640 "$TORII_ROOT/env"
chown root:root "$TORII_ROOT/env"

sentry() {
  # Run a command as the `torii` service user within a sandbox dir (its HOME).
  local dir; dir="$(mktemp -d)"
  chown "$TORII_USER:$TORII_USER" "$dir"
  # shellcheck disable=SC2016
  su -s /bin/bash "$TORII_USER" -c "$1" 2>/dev/null
  local rc=$?
  rm -rf "$dir"
  return $rc
}

echo "-- negative: /opt/torii must be root-owned"
[ "$(stat -c '%U:%G' "$TORII_ROOT")" = "root:root" ] || fail "/opt/torii not root-owned"
pass "/opt/torii is root:root"

echo "-- negative: env must be root-owned, not group-writable"
[ "$(stat -c '%U:%G' "$TORII_ROOT/env")" = "root:root" ] || fail "env not root-owned"
[ "$(stat -c '%a' "$TORII_ROOT/env")" = "640" ] || fail "env has wrong mode"
pass "env is root:root 0640"

echo "-- negative: torii cannot rename/replace env (parent not writable)"
if sentry "mv $TORII_ROOT/env $TORII_ROOT/env.evil"; then
  fail "torii renamed env — boundary broken"
fi
pass "rename/replace of env by torii is refused"

echo "-- negative: torii cannot write env in place"
if sentry "echo 'echo PWNED' >> $TORII_ROOT/env"; then
  fail "torii appended to env — boundary broken"
fi
pass "in-place env write by torii is refused"

echo "-- positive: torii CAN write its state/ dir"
if ! sentry "echo '{\"apps\":[],\"root_app\":null}' > $TORII_ROOT/state/registry.json"; then
  fail "torii could not write state/registry.json — over-restricted"
fi
pass "state/ remains writable by torii"

echo "-- negative: torii cannot write under root-owned deployment dirs"
if sentry "echo x > $TORII_ROOT/nginx-fragments/pwned.conf"; then
  fail "torii wrote into root-owned nginx-fragments"
fi
pass "nginx-fragments is not torii-writable"

echo "== bin/torii must not source env =="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if grep -nE '^[[:space:]]*(source|\.)[[:space:]]+.*(ENV_FILE|/env)' "$SCRIPT_DIR/bin/torii"; then
  fail "bin/torii sources the env file"
fi
pass "bin/torii reads env as config, never executes it"

echo "SB-01 boundary verified."