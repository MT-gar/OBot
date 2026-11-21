#!/usr/bin/env bash
set -euo pipefail
umask 077
runtime_dir="$(mktemp -d /tmp/private-computer.XXXXXX)"
export XDG_RUNTIME_DIR="$runtime_dir"
export DISPLAY="${DISPLAY:-:99}"
children=()
cleanup() {
  trap - EXIT TERM INT
  for child in "${children[@]}"; do kill "$child" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT TERM INT

Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -ac >"$runtime_dir/xvfb.log" 2>&1 &
children+=("$!")
for attempt in {1..50}; do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null
openbox >"$runtime_dir/openbox.log" 2>&1 &
children+=("$!")
x11vnc -display "$DISPLAY" -localhost -rfbport 5900 -nopw -forever -shared -noxdamage -quiet >"$runtime_dir/vnc.log" 2>&1 &
children+=("$!")
bridge_bind=127.0.0.1
if [[ "${APP_ROLE:-p0}" == desktop ]]; then bridge_bind=0.0.0.0; fi
websockify "$bridge_bind:6081" 127.0.0.1:5900 >"$runtime_dir/websockify.log" 2>&1 &
children+=("$!")

if [[ "${APP_ROLE:-p0}" == p0 ]]; then
  node /opt/private-computer/apps/control/src/server.mjs &
  children+=("$!")
  health_host="$(node -p 'new URL(process.env.APP_ORIGIN).host')"
  for attempt in {1..50}; do
    if curl -fsS -H "Host: $health_host" "http://127.0.0.1:${APP_PORT:-3180}/healthz" >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
  curl -fsS -H "Host: $health_host" "http://127.0.0.1:${APP_PORT:-3180}/healthz" >/dev/null
fi

# Recreated containers have new hostnames/PIDs. Serialize access to the persistent
# profile, then remove only Chromium's three stale singleton symlinks.
profile_dir=/home/desktop/.config/chromium
mkdir -p -- "$profile_dir"
if [[ "$(realpath -- "$profile_dir")" != /home/desktop/.config/chromium ]]; then
  echo 'Browser profile must not resolve outside its configured directory.' >&2
  exit 1
fi
exec 9>/home/desktop/.private-computer/browser-profile.lock
flock -n 9 || { echo 'The persistent browser profile is already in use.' >&2; exit 1; }
for lock_name in SingletonLock SingletonCookie SingletonSocket; do
  lock_path="$profile_dir/$lock_name"
  if [[ -L "$lock_path" ]]; then
    unlink -- "$lock_path"
  elif [[ -e "$lock_path" ]]; then
    echo 'Unexpected non-symlink browser lock; refusing to remove it.' >&2
    exit 1
  fi
done

browser_options=(--no-first-run --no-default-browser-check --disable-dev-shm-usage
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
  --user-data-dir=/home/desktop/.config/chromium --window-size=1180,720 --window-position=30,30)
export BROWSER_SANDBOX_ENABLED=true
if [[ "${ALLOW_UNSANDBOXED_BROWSER:-0}" == 1 ]]; then
  echo 'P0 TEST-ONLY: Chromium sandbox explicitly disabled. Do not use real accounts or browse untrusted sites.' >&2
  browser_options+=(--no-sandbox)
  export BROWSER_SANDBOX_ENABLED=false
fi
if [[ -n "${BROWSER_PROXY_URL:-}" ]]; then
  browser_options+=("--proxy-server=$BROWSER_PROXY_URL" '--proxy-bypass-list=control;<-loopback>')
fi
fixture_origin="${INTERNAL_CONTROL_ORIGIN:-http://127.0.0.1:${APP_PORT:-3180}}"
# No silent fallback to --no-sandbox. A failed sandbox is a visible startup failure.
dbus-run-session -- chromium "${browser_options[@]}" "${fixture_origin%/}/fixture" >"$runtime_dir/browser.log" 2>&1 &
children+=("$!")
for attempt in {1..100}; do
  if curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then break; fi
  sleep 0.2
done
if ! curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo 'Chromium did not start. Recent browser diagnostics:' >&2
  tail -n 25 "$runtime_dir/browser.log" >&2
  exit 1
fi
# Exit on a failed critical process, so Docker restart/health status is truthful.
wait -n "${children[@]}"
exit 1
