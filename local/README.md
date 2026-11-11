# local/ — our additions on top of upstream camofox-browser

Everything here is local to this fork; upstream never touches `local/`, so
`git merge upstream/master` stays clean. See `../MIGRATION-FROM-CAMOUFOX-MCP.md`.

| file | what |
|---|---|
| `camofox.env` | the only place port/bind/telemetry/profile live; sourced by ctl, service and selfcheck |
| `camofox-ctl` | `start|stop|restart|status|ensure|logs|url|open` for the REST server (pidfile + nohup, no systemd) |
| `selfcheck.mjs` | proves shared browser, relaunch after kill, idempotent `ensure`, telemetry off |
| `import-old-cookies.mjs` | one-time: old camoufox-mcp Firefox `cookies.sqlite` → `cookies.txt` for bootstrap import |
| `autostart/camofox-browser.desktop` | XDG autostart (installed at `~/.config/autostart/`) |
| `openrc/camofox-browser` | OpenRC service (needs root: `sudo cp` + `rc-update add`) |

Daily use:

```bash
local/camofox-ctl ensure       # idempotent; also what autostart runs
local/camofox-ctl status
node local/selfcheck.mjs       # must print PASS
```

`selfcheck.mjs` reads the mode, port, bind host and telemetry flag from the **running
server's** `/proc/<pid>/environ`, so it always tests what is actually up:

- server started headless (`CAMOFOX_INTERACTIVE=off`): 12 checks, one
  `skip headed window + hand-close checks` line — by design, there is no window to close.
- server started with a window (`CAMOFOX_INTERACTIVE=desktop`, our default in `camofox.env`):
  3 extra checks — window present, closed by hand via `wmctrl`, new window back after the relaunch.

To exercise the headed path (pops a window):

```bash
CAMOFOX_INTERACTIVE=desktop local/camofox-ctl restart && node local/selfcheck.mjs
CAMOFOX_INTERACTIVE=off    local/camofox-ctl restart    # back to no windows
```

Agent side (`~/.pi/agent/mcp.json`) runs `mcp/server.mjs` as a **stdio** proxy with
`CAMOFOX_PORT=8788` and `CAMOFOX_USER_ID=pi` — the user id is what makes every
session share one cookie jar.
