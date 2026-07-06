# torii-base

The host layer for a Torii VPS. Installs nginx, a launcher page at `/`,
and a small sidecar service so apps like [Torii Continuum](https://github.com/ChiefmonkeyArt/torii-continuum),
[Plebeian Market](https://plebeian.market), and Torii Quest can be
mounted side-by-side at fixed sub-paths on the same domain.

```
https://your-domain.com/                — Torii launcher (or promoted app)
https://your-domain.com/continuum/      — Continuum Console
https://your-domain.com/plebeian/       — Plebeian marketplace
https://your-domain.com/quest/          — Torii Quest (WebGL arena)
```

Only the launcher and sidecar ship in this repo. Individual apps register
themselves after they're installed.

---

## Install

**Requirements:** Ubuntu 22.04 or 24.04, a DNS A record pointing at the VPS,
and root (or a passwordless-sudo user).

```bash
git clone https://github.com/ChiefmonkeyArt/torii-base.git
cd torii-base
sudo ./bootstrap.sh --domain your-domain.com --email you@your-domain.com
```

What it does:

- Installs `nginx`, `certbot`, `node@22`, and common utilities.
- Creates a `torii` OS user for the sidecar.
- Writes `/opt/torii/env` with a generated `TORII_ADMIN_TOKEN`.
- Installs the launcher, the main nginx server block, and the sidecar.
- Obtains a Let's Encrypt certificate (skip with `--no-letsencrypt`).
- Enables `torii-base-sidecar.service`.

After it finishes, visit `https://your-domain.com/` — you'll see an empty
launcher waiting for apps to register.

---

## `torii` CLI

The sidecar exposes a small REST API on `127.0.0.1:8780`. Everything you
need day-to-day is wrapped by the `torii` CLI on the host.

```bash
sudo torii register continuum "Continuum" /continuum "App builder + agent"
sudo torii set-root continuum          # make /continuum the site homepage
sudo torii set-root launcher           # go back to the launcher at /
sudo torii unregister quest
sudo torii status
sudo torii doctor
sudo torii reload                      # re-validate + reload nginx
```

`torii doctor` verifies:

- Host layer (nginx config, sidecar reachability, launcher present).
- Registered apps respond on their mount paths.
- Continuum agent health, Routstr reachability, Ollama reachability, and
  the Cashu wallet directory (when Continuum is installed).

---

## Launcher

Static page at `/` that reads `/torii/apps.json` and renders one tile per
registered app. Each tile has an "Open" link and a "Set as homepage"
button; picking a homepage flips `root_app` in `registry.json` and the
next nginx reload swaps the `/` include from the launcher to a 302
redirect.

The launcher is dark-first (Torii vermilion `#d94f2c`) and has no
dependencies — vanilla HTML/CSS/JS.

---

## Layout

```
/opt/torii/
  env                            # TORII_ADMIN_TOKEN, TORII_DOMAIN, etc.
  registry.json                  # apps registered on this host
  root_app.conf                  # nginx include for `/` (launcher or redirect)
  launcher/                      # static assets served at /
  nginx-fragments/               # each app drops its own <name>.conf here

/etc/nginx/sites-available/
  torii                          # main server block; includes fragments + root_app

/usr/local/bin/
  torii                          # the CLI
```

---

## Registering another app

Apps are expected to:

1. Build their frontend to a directory the nginx user can read.
2. Drop an nginx `location` fragment at `/opt/torii/nginx-fragments/<name>.conf`.
3. Call `torii register <name> "<label>" <mount> "<description>"`.
4. Call `torii reload` (or just `nginx -s reload`).

The [Continuum Ansible installer](https://github.com/ChiefmonkeyArt/torii-continuum/tree/main/ops/ansible)
does all of this automatically.

---

## Security notes

- The sidecar binds to `127.0.0.1:8780` only. All external traffic goes
  through nginx.
- Admin endpoints (`/torii/set-root`, `/torii/apps`, `DELETE /torii/apps/:name`)
  require a Bearer token — the value in `/opt/torii/env`.
- Systemd unit is hardened: `NoNewPrivileges`, `ProtectSystem=full`,
  `ReadWritePaths=/opt/torii`.
- The launcher and `apps.json` are public. If you don't want the world to
  know what you host, use `torii set-root <app>` so `/` redirects to your
  chosen app and never shows the launcher.

---

## License

MIT — see LICENSE.
