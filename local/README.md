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

Agent side (`~/.pi/agent/mcp.json`) runs `mcp/server.mjs` as a **stdio** proxy with
`CAMOFOX_PORT=8788` and `CAMOFOX_USER_ID=pi` — the user id is what makes every
session share one cookie jar.
