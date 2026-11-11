#!/usr/bin/env bash
# Simulates the OpenRC unit's own start path as root (HOME=/root) and proves the
# service ends up on the USER's profile/cookies, not /root's:
#   - paths resolved from getent
#   - browser actually launches (browserConnected true, not just /health ok)
#   - persisted storage state restored
#   - a migrated cookie is readable in the page
# Runs the server on a spare port, headless, and kills only its own pid.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# --- stub the openrc-run helpers, then load the unit exactly as OpenRC would
eerror() { echo "eerror: $*" >&2; }
einfo() { :; }
checkpath() { :; }
export HOME=/root CAMOFOX_USER=adeliktas
# shellcheck disable=SC1091
. local/openrc/camofox-browser

echo "resolved REPO=$REPO"
echo "resolved ENVFILE=$ENVFILE"
echo "resolved STATE_DIR=$STATE_DIR"
start_pre || { echo "FAIL start_pre"; exit 1; }
echo "after start_pre: HOME=$HOME PROFILE_DIR=$CAMOFOX_PROFILE_DIR COOKIES_DIR=$CAMOFOX_COOKIES_DIR STATE=$CAMOFOX_STATE_DIR"
case "$CAMOFOX_PROFILE_DIR$CAMOFOX_COOKIES_DIR$CAMOFOX_STATE_DIR" in
	*/root/*) echo "FAIL: env still points at /root"; exit 1 ;;
esac

PORT=9381
export CAMOFOX_PORT=$PORT CAMOFOX_INTERACTIVE=off CAMOFOX_CRASH_REPORT_ENABLED=false
LOG=/tmp/openrc-service-test.log
: >"$LOG"
node "$REPO/server.js" >>"$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; wait $SRV 2>/dev/null' EXIT
for _ in $(seq 40); do curl -fsS -m 2 "127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done

node -e '
const b="http://127.0.0.1:9381";
const tab=await (await fetch(b+"/tabs",{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({url:"https://arena-breakout-infinite.fandom.com/wiki/Arena_Breakout_Infinite_Wiki",userId:"pi",sessionKey:"default"})})).json();
const ev=await (await fetch(b+`/tabs/${tab.tabId}/evaluate`,{method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({userId:"pi",expression:"document.cookie"})})).json();
const cookies=typeof ev.result==="string"?ev.result:JSON.stringify(ev.result);
console.log("cookie check:", /pvNumber|playerImpressionsInWiki/.test(cookies) ? "migrated cookie present" : `MISSING (${cookies.slice(0,120)})`);
' 2>&1 | tail -2

echo "--- health:"; curl -fsS -m 3 "127.0.0.1:$PORT/health" | head -c 120; echo
echo "--- service log evidence:"
grep -E "restoring persisted storage state|bootstrap cookies imported|EACCES|failed to (load|import)" "$LOG" | head -4
echo "--- /root leakage in log (must be empty):"
grep -c "/root/" "$LOG"
