# Migration: camoufox-mcp (Python, dead upstream) → camofox-browser (fork)

Goal: run **our** browser stack out of this fork, keep every behaviour we added to the
Python MCP, and make the switch one-way but reversible until the selfcheck passes.

Repo: `~/gitrepos/securityrepos/camofox-browser` (fork `adeliktas/camofox-browser`,
remotes `origin` = fork, `upstream` = jo-inc/camofox-browser, `master`).
Old repo stays at `~/gitrepos/securityrepos/camoufox-mcp` — do not delete it.

## 0. Status (2026-11-11)

Done: npm ci + shared browser on 8788 · `local/` (env, ctl, selfcheck, importer, autostart, OpenRC file) ·
cookies migrated (168 cookies imported, verified live) · `mcp.json` switched to the stdio proxy
(`camoufox` = camofox 31 tools, `camoufox-python` = disabled rollback entry) · XDG autostart replaced ·
selfcheck green twice.

Remaining, needs the user: install the OpenRC service (`sudo cp local/openrc/camofox-browser /etc/init.d/ &&
sudo rc-update add camofox-browser default`) — not done, no passwordless sudo. Additions live under
`local/`, see `local/README.md`.

## 1. What we ran before (matched or beaten)

| Thing | Current value |
|---|---|
| Code | `~/gitrepos/securityrepos/camoufox-mcp` (fork of `rlgrpe/camoufox-mcp-python` 0.1.0, MIT; upstream abandoned, 75 PyPI dl/mo) |
| Process | one daemon: `~/.local/share/mcp-servers/camoufox-mcp/venv/bin/camoufox-mcp --transport streamable-http --host 127.0.0.1 --port 8788` |
| MCP endpoint | `http://127.0.0.1:8788/mcp` (streamable HTTP), registered in `~/.pi/agent/mcp.json` as `camoufox` |
| Browser | Camoufox, **headed** window by default, shared by every client |
| Profile | `~/.local/share/camoufox-mcp/profile` (~198 MB, cookies + logins worth keeping) |
| State/log | `~/.local/share/camoufox-mcp/daemon.{pid,log}`, `~/.cache/camoufox` (browser binary, shared with camoufox-js) |
| Control | `scripts/camoufox-mcp-ctl {start,stop,restart,status,ensure,logs,url,open}` — no systemd, pidfile+nohup |
| Autostart | `~/.config/autostart/camoufox-mcp.desktop` → `camoufox-mcp-ctl ensure` |
| Deploy | `scripts/deploy.sh` = pip install into venv + fetch browser + ctl restart + selfcheck |
| Selfcheck | `scripts/selfcheck.py` (asserts one shared browser, navigate/evaluate/screenshot, survives restart) |

Custom commits to preserve in spirit (`5ff3716..3c3d92f`):
`f56da60` HTTP daemon so one browser outlives clients · `9fd28dc` `browser_status` + close() fix ·
`c0b6621` ctl/deploy/autostart · `bc0337f` selfcheck · `0286f9e` SIGTERM really stops+closes ·
`e915ecf` relaunch browser after the user closes the window · `c2bac2c` never two servers on one profile.

## 2. What camofox-browser already gives us (do NOT re-port)

- **Persistent browser owner**: `server.js` REST server (`CAMOFOX_PORT`, default `9377`) owns the single
  Camoufox. The MCP server (`mcp/server.mjs`, bin `camofox-browser-mcp`) is a **stdio proxy** that
  spawns per client and never launches a browser → the "two windows / two servers on one profile"
  class of bug cannot happen by construction. (`c2bac2c`, `c0b6621` covered.)
- **Dead-browser recovery**: `browser.isConnected()` check → `closeAllSessions` + relaunch, stale tabs
  return retriable `410`/`503` (`e915ecf`, `0286f9e` covered). Verify, don't rewrite.
- **Headed window**: `useDesktopWindow` path; falls back to Xvfb/headless when no display (`1359/1385`).
- **Status**: `GET /health`, `GET /metrics`, `POST /pressure/cleanup`.
- **Tool surface**: 31 `camofox_*` tools from `mcp/lib/tool-contracts.mjs` (single contract shared
  with the OpenClaw plugin, parity-tested against the HTTP routes). Every tab tool takes a `tabId`, so a
  session starts with `camofox_create_tab`.
- **Per-user sessions**: the MCP proxy derives its own user id (`CAMOFOX_USER_ID` or a random uuid) and
  the cookie jar is per user — set it to a constant or every agent session gets fresh cookies.

What is **not** there and has to be written by us: ctl script, env file, OpenRC service, autostart
entry, selfcheck, and the migration of profile + `mcp.json`.

## 3. Target layout (all our additions, upstream-merge friendly)

Keep our files in paths upstream does not touch, so `git merge upstream/master` stays clean:

```
local/camofox.env                     # our env (sourced by ctl + service + selfcheck)
local/camofox-ctl                     # start|stop|restart|status|ensure|logs|url|open
local/selfcheck.mjs                   # ported from scripts/selfcheck.py, talks to REST+MCP
local/autostart/camofox-browser.desktop
local/openrc/camofox-browser          # OpenRC init script (user-installable variant below)
local/README.md                       # 10 lines: what this fork adds, how to deploy/rollback
```

## 4. Env contract (`local/camofox.env`)

```sh
CAMOFOX_PORT=8788                      # keep our old port so agent config/notes stay valid
CAMOFOX_BIND_HOST=127.0.0.1            # loopback only
CAMOFOX_CRASH_REPORT_ENABLED=false     # upstream telemetry defaults ON - must be off
CAMOFOX_PROFILE_DIR=$HOME/.local/share/camoufox-mcp/profile   # reuse logins (see 5.3)
CAMOFOX_TRACES_DIR=$HOME/.local/share/camofox-browser/traces
CAMOFOX_UPLOADS_DIR=$HOME/.local/share/camofox-browser/uploads
# CAMOFOX_LOCALE / CAMOFOX_TIMEZONE only with a proxy; without one leave them unset
# CAMOFOX_ACCESS_KEY unset: loopback only, MCP proxy needs no auth
```

State/log dir for the ctl: `~/.local/share/camofox-browser/{server.log,server.pid}`.

## 5. Steps (each ends with a check; stop on the first failure)

**5.1 Build the checkout**
`npm ci` in the fork. Note: `postinstall.js` runs and may download a Camoufox bundle (~300 MB).
If we want to force the existing binary instead: `CAMOUFOX_EXECUTABLE=/path/from ~/.cache/camoufox`
*and* `npm ci --ignore-scripts` for air-gapped installs. Check: `node -e "import('./lib/config.js')"`
or simply `npm start` → `curl -s 127.0.0.1:9377/health` → `ok`.

**5.2 Write `local/camofox.env`, `local/camofox-ctl`, `local/selfcheck.mjs`, autostart, OpenRC**
ctl mirrors the old one: pidfile + `nohup node server.js`, `ensure` adopts an untracked server when the
port is already open, `stop` = SIGTERM then SIGKILL with a warning (SIGTERM must close the browser —
`POST /stop` with `CAMOFOX_ADMIN_KEY` is the clean path, prefer it), `status` prints port+log,
`logs`, `url` prints `http://127.0.0.1:8788`. Guard: refuse to start a second server when the port is
open but foreign.
OpenRC service (`local/openrc/camofox-browser`): `#!/sbin/openrc-run`, `command_background="yes"`,
`command_user="adeliktas"`, `pidfile`, `output_log`, `error_log`, `depend() { need localmount; use net }`,
`start_pre()` sources `local/camofox.env`. Install needs root:
`doas cp local/openrc/camofox-browser /etc/init.d/ && doas rc-update add camofox-browser default`
(or `rc-service camofox-browser start`; keep the XDG autostart as the non-root path and disable one of
the two so the browser is not started twice — `ensure` makes that a no-op anyway).

**5.3 Profile — the Firefox profile is NOT reusable (measured)**
camofox launches with `firefox.launch()`, not `launchPersistentContext`, and persists cookie/localStorage
state as `storage-state.json` per user id. So `~/.local/share/camoufox-mcp/profile` cannot be pointed at.
What did work: `local/import-old-cookies.mjs` reads `cookies.sqlite` from the old profile and writes
Netscape `cookies.txt` into `CAMOFOX_COOKIES_DIR`, which the server imports at session bootstrap
(only for a user id with no saved state, i.e. first run or after clearing `CAMOFOX_PROFILE_DIR/<hash>`).
Firefox stores expiry in ms, Playwright wants seconds — the script converts; without that, import fails
with `Cookie should have a valid expires`. Result: 168 of 173 cookies imported, verified live.
Logins that live in localStorage (not cookies) need one fresh sign-in. Old profile left untouched.

**5.4 Checkout the MCP proxy as a local bin**
`npm link` (or run `node mcp/server.mjs` directly with `cwd` = repo). Check:
`echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | CAMOFOX_PORT=8788 node mcp/server.mjs`
returns `camofox_*` tools.

**5.5 Switch the agent config (the actual cut-over)**
`~/.pi/agent/mcp.json`, entry `camoufox`: replace `"url": "http://127.0.0.1:8788/mcp"` with
`"command": "node", "args": ["/home/adeliktas/gitrepos/securityrepos/camofox-browser/mcp/server.mjs"], "env": {"CAMOFOX_PORT": "8788"}`,
`timeout` 120. Keep the old entry as `camoufox-python` (same body as today) for one week so a rollback is
a one-line swap. Note: the MCP proxy is **stdio**; upstream has no streamable-HTTP MCP endpoint.
Check: new agent session lists `camofox_*` tools, `camofox_navigate` + `camofox_snapshot` work on a real page.

**5.6 Tool-name mapping** (for our notes/playbooks; no skill file references the old names today)

| old | new |
|---|---|
| `browser_navigate` / `browser_navigate_back` | `camofox_navigate` / `camofox_back` |
| `browser_snapshot` | `camofox_snapshot` (+ `camofox_ax`, `camofox_actionables`) |
| `browser_click` / `browser_type` / `browser_press_key` | `camofox_click` / `camofox_type` / `camofox_press` |
| `browser_evaluate` (page eval) | `camofox_evaluate` (note `CAMOFOX_EVALUATE_MAX_BODY_SIZE`=1mb) |
| `browser_tabs` / `browser_close` | `camofox_list_tabs` / `camofox_create_tab` / `camofox_close_tab` |
| `browser_take_screenshot` / `browser_resize` | `camofox_screenshot` / `camofox_viewport` |
| `browser_status` | `GET /health` + `GET /metrics` (no MCP tool) |
| `browser_file_upload` / `browser_fill_form` / `browser_handle_dialog` | `camofox_upload` / `camofox_type`·`camofox_select` (no form-fill or dialog tool) |
| `browser_console_messages` / `browser_network_requests` | **no equivalent** — drop, or thin plugin later (not needed so far) |
| `browser_configure`(proxy) | proxy is server-side env/config (`CAMOFOX_*`), not a tool |

**5.7 Deploy + selfcheck**
`local/camofox-ctl restart && node local/selfcheck.mjs`. Selfcheck must assert:
REST `/health` ok · exactly one browser process on the profile · navigate → snapshot → evaluate returns
text · screenshot non-empty · browser killed mid-session → next call relaunches (410/retriable path) ·
user-closed window → next call relaunches · `tools/list` over the MCP proxy lists `camofox_*` ·
`CAMOFOX_CRASH_REPORT_ENABLED=false` in effect (`/metrics` or startup log line).

**5.8 Retire the old daemon**
Only after 5.7 passes twice in a row: `camoufox-mcp-ctl stop`, remove
`~/.config/autostart/camoufox-mcp.desktop`, pip-uninstall is optional (keep the repo + venv as a
fallback for a month). Do not touch `~/.cache/camoufox` (both stacks can share it).

## 6. Acceptance criteria

1. `local/camofox-ctl ensure` is idempotent: second call prints "already running", no second browser.
2. A new agent session reaches `camofox_*` tools without any manual step after a reboot.
3. Closing the browser window by hand does not break the next tool call.
4. `ensure` survives: no PID file yet port open (adopts), stale PID file (restarts).
5. `local/selfcheck.mjs` green, and green again after `camofox-ctl restart`.
6. Telemetry off, bind loopback, nothing listens on 0.0.0.0.
7. `git -C ~/gitrepos/securityrepos/camofox-browser status` clean; all our files under `local/`;
   `git fetch upstream && git log --oneline upstream/master ^HEAD` short (merges stay possible).

## 7. Rollback (one line, any time before 5.8)

Restore the `camoufox` entry in `~/.pi/agent/mcp.json` to `{"url": "http://127.0.0.1:8788/mcp"}`,
`camoufox-mcp-ctl start`, and stop camofox (`local/camofox-ctl stop`). The old profile and venv were
never touched.

## 8. Risks / gotchas

- **Telemetry is ON by default** upstream (crash/hang reports to their GitHub/endpoint, redacted).
  `CAMOFOX_CRASH_REPORT_ENABLED=false` must be in the env file before the first real run.
- **Supply chain**: `postinstall.js` downloads a browser; the published npm package is what most people
  run (`@askjo/camofox-browser`, 53k dl/mo, commercial vendor askjo.ai). We run the checkout, so pin the
  commit and review the diff before `npm ci`.
- **No streamable-HTTP MCP** → agent config becomes a stdio `command`, and the proxy needs the checkout
  on disk (`npm link` or absolute path). If the fork moves, update `mcp.json`.
- **Port**: 8788 vs upstream default 9377 — set `CAMOFOX_PORT` everywhere (ctl, env, mcp.json env).
- **Node >= 22** (we have v26.3.0). Browser binary can be shared with `~/.cache/camoufox`.
- **Feature gaps**: no dialog handler, no form-fill, no console/network capture. If a real task hits one,
  add a thin plugin (upstream has a plugin system) instead of forking `server.js`.
- **OpenRC needs root**; without it the XDG autostart + `ensure` path already covers "always up after login".
