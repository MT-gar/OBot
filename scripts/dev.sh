#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export BOT_SECRET_DIR="${BOT_SECRET_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/private-computer-p0}"
export BOT_PORT="${BOT_PORT:-3180}"
# BOT_IMAGE remains the shared desktop/egress foundation and volume helper.
export BOT_IMAGE="${BOT_IMAGE:-private-computer:mvp}"
export BOT_ACP_IMAGE="${BOT_ACP_IMAGE:-private-computer:acp}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-private-computer-p0}"
export MODEL_ENABLED="${MODEL_ENABLED:-1}"
compose=(docker compose --project-directory "$project_root" --project-name "$COMPOSE_PROJECT_NAME" -f "$project_root/deploy/compose/compose.yaml")
validate_selection() {
  if [[ "$BOT_IMAGE" == "$BOT_ACP_IMAGE" ]]; then echo 'BOT_IMAGE and BOT_ACP_IMAGE must use different tags for the base and ACP control images.' >&2; exit 1; fi
  if [[ ! "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then echo 'COMPOSE_PROJECT_NAME must be a lowercase Compose project name.' >&2; exit 1; fi
  if [[ "$MODEL_ENABLED" != 0 && "$MODEL_ENABLED" != 1 ]]; then echo 'MODEL_ENABLED must be 1 (ACP) or 0 (offline fixed demo).' >&2; exit 1; fi
}
init() {
  umask 077
  mkdir -p -- "$BOT_SECRET_DIR"
  if [[ -L "$BOT_SECRET_DIR" ]]; then echo 'Private state must not be a symlink.' >&2; exit 1; fi
  for credential_name in owner-password runner-token model-key; do
    credential_path="$BOT_SECRET_DIR/$credential_name"
    if [[ -L "$credential_path" || ( -e "$credential_path" && ! -f "$credential_path" ) ]]; then echo 'A private credential must be a regular file, not a symlink.' >&2; exit 1; fi
    if [[ ! -e "$credential_path" ]]; then
      if [[ "$credential_name" == model-key ]]; then : > "$credential_path";
      else python3 -c 'import secrets,sys; open(sys.argv[1], "x").write(secrets.token_urlsafe(32)+"\n")' "$credential_path"; fi
      chmod 600 "$credential_path"
    fi
  done
  echo 'Private credentials remain outside the repository. Use scripts/dev.sh password for the owner login.'
}
check_images() {
  docker image inspect "$BOT_IMAGE" >/dev/null 2>&1 || { echo 'Desktop/egress base image is missing. Run scripts/dev.sh build.' >&2; exit 1; }
  docker image inspect "$BOT_ACP_IMAGE" >/dev/null 2>&1 || { echo 'ACP control image is missing. Run scripts/dev.sh build.' >&2; exit 1; }
  # No mounts, credentials, network or DSH process: inspect only local runtime files.
  local result=0
  docker run --rm --pull never --network none --user desktop --entrypoint /opt/private-node/node_modules/node/bin/node "$BOT_ACP_IMAGE" --input-type=module -e '
    import { readFile, access } from "node:fs/promises";
    if (process.version !== "v24.22.3") process.exit(30);
    try { if (JSON.parse(await readFile("/opt/dsh/node_modules/@deepseek-ai/dsh/package.json", "utf8")).version !== "0.2.2-rc.3") process.exit(31); await access("/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"); await access("/opt/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml"); } catch { process.exit(31); }
    try { if (!(await readFile("/opt/private-computer/runtime/acp/budget.mjs", "utf8")).trim()) process.exit(32); } catch { process.exit(32); }
  ' >/dev/null 2>&1 || result=$?
  case "$result" in
    0) ;;
    30) echo 'ACP control requires Node 24.22.3. Rebuild scripts/dev.sh build.' >&2; exit 1 ;;
    31) echo 'ACP control requires DSH 0.2.2-rc.3 and its ACP profile. Rebuild scripts/dev.sh build.' >&2; exit 1 ;;
    32) echo 'ACP policy plugin is missing from the control image. Rebuild scripts/dev.sh build.' >&2; exit 1 ;;
    *) echo 'ACP runtime could not be checked locally. Verify Docker and rebuild scripts/dev.sh build.' >&2; exit 1 ;;
  esac
}
check_model() {
  if [[ "$MODEL_ENABLED" == 1 && ! -s "$BOT_SECRET_DIR/model-key" ]]; then
    echo 'ACP model credential is missing. Run scripts/dev.sh model-key, or explicitly use MODEL_ENABLED=0 for the offline fixed demo.' >&2; exit 1
  fi
}
check_restore() {
  local home_volume="${COMPOSE_PROJECT_NAME}_computer-home" control_volume="${COMPOSE_PROJECT_NAME}_control-state"
  local rows volume label extra home_restore= control_restore=
  # One metadata query on ordinary startup; inspect receipt files only for restores.
  rows="$(docker volume ls --filter "name=^${COMPOSE_PROJECT_NAME}_(computer-home|control-state)$" --format '{{.Name}} {{.Label "org.private-computer.restore"}}')" || { echo 'Cannot check local restore volume labels; startup stopped.' >&2; exit 1; }
  while read -r volume label extra; do
    [[ -n "$volume" ]] || continue
    [[ -z "$extra" ]] || { echo 'Invalid restore volume metadata; startup stopped.' >&2; exit 1; }
    case "$volume" in
      "$home_volume") home_restore="$label" ;;
      "$control_volume") control_restore="$label" ;;
      *) echo 'Unexpected restore volume metadata; startup stopped.' >&2; exit 1 ;;
    esac
  done <<< "$rows"
  [[ -n "$home_restore" || -n "$control_restore" ]] || return 0
  if [[ -z "$home_restore" || "$home_restore" != "$control_restore" ]]; then
    echo 'Restored volumes require matching restore labels on both home and control-state; startup stopped.' >&2; exit 1
  fi
  # Both mounts are read-only; no credentials, DSH process or network are available.
  docker run --rm --pull never --network none --read-only --user desktop --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 --memory 64m --entrypoint node \
    --mount "type=volume,src=$home_volume,dst=/restore/home,readonly" --mount "type=volume,src=$control_volume,dst=/restore/control,readonly" "$BOT_IMAGE" --input-type=module -e '
    import { open } from "node:fs/promises";
    import { constants } from "node:fs";
    async function receipt(root) {
      const file = await open(root + "/.restore-complete.json", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > 4096) throw new Error();
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead < 1 || bytesRead > 4096) throw new Error();
        return buffer.subarray(0, bytesRead);
      } finally { await file.close(); }
    }
    try {
      const [home, control] = await Promise.all(process.argv.slice(1).map(receipt));
      if (!home || !control || !home.equals(control)) throw new Error();
      const value = JSON.parse(home.toString("utf8"));
      if (value.format !== "private-computer-volume-restore" || value.version !== 1 || value.authentication !== "relogin-required" || value.resumedOperations !== false ||
          typeof value.transaction !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.transaction) ||
          typeof value.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.manifestSha256) ||
          typeof value.completedAt !== "string" || new Date(value.completedAt).toISOString() !== value.completedAt) throw new Error();
    } catch { process.exitCode = 33; }
  ' /restore/home /restore/control >/dev/null 2>&1 || { echo 'Restored volumes lack matching valid completion receipts; startup stopped. Keep services stopped and complete a verified restore into a fresh project.' >&2; exit 1; }
}
prepare_volume() {
  local home_volume="${COMPOSE_PROJECT_NAME}_computer-home"
  docker volume create "$home_volume" >/dev/null
  docker run --rm --pull never --network none --entrypoint /bin/sh --mount "type=volume,src=$home_volume,dst=/legacy" "$BOT_IMAGE" -c 'test ! -L /legacy/Workspace && install -d -o 1100 -g 1100 /legacy/Workspace'
}
prepare_start() { validate_selection; init; check_model; check_images; check_restore; prepare_volume; }
case "${1:-help}" in
  init) init ;;
  build)
    validate_selection; init
    docker build --build-arg "BASE_IMAGE=${BOT_BASE_IMAGE:-node:22-bookworm-slim}" --build-arg "APT_MIRROR=${BOT_APT_MIRROR:-}" -t "$BOT_IMAGE" -f "$project_root/runtime/desktop/Dockerfile" "$project_root"
    docker build --build-arg "FOUNDATION_IMAGE=$BOT_IMAGE" -t "$BOT_ACP_IMAGE" -f "$project_root/runtime/acp/Dockerfile" "$project_root"
    ;;
  up)
    prepare_start
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 180
    echo "Open http://localhost:$BOT_PORT (private local MVP)."
    ;;
  serve) prepare_start; "${compose[@]}" up --no-build --pull never ;;
  stop) "${compose[@]}" stop ;;
  down) "${compose[@]}" down ;;
  recreate) prepare_start; "${compose[@]}" up -d --no-build --pull never --force-recreate --wait --wait-timeout 180 ;;
  status) "${compose[@]}" ps ;;
  logs) "${compose[@]}" logs --tail=100 computer desktop egress ;;
  password)
    test -f "$BOT_SECRET_DIR/owner-password"
    python3 -c 'import sys; print(open(sys.argv[1]).read().strip())' "$BOT_SECRET_DIR/owner-password"
    ;;
  model-key)
    init
    if [[ ! -t 0 ]]; then echo 'Use an interactive local terminal or pipe directly to store-model-key.py.' >&2; exit 1; fi
    read -r -s -p 'Provider API key (hidden): ' provider_key; printf '\n'
    printf '%s' "$provider_key" | python3 "$project_root/scripts/store-model-key.py" --replace
    unset provider_key
    ;;
  config)
    validate_selection
    node "$project_root/scripts/verify-compose-config.mjs"
    ;;
  test)
    cd -- "$project_root"
    node scripts/check.mjs
    node scripts/verify-compose-config.mjs --self-test
    node --test apps/control/test/*.test.mjs apps/desktop/test/*.test.mjs
    ;;
  *)
    printf '%s\n' 'Usage: bash scripts/dev.sh init|build|serve|up|stop|down|recreate|status|logs|password|model-key|config|test' \
      'Run inside Linux/WSL with Docker access. build creates the base and pinned ACP control images.' \
      'BOT_IMAGE selects desktop/egress; BOT_ACP_IMAGE selects control. Use the same values for build and startup.' \
      'Set MODEL_ENABLED=0 explicitly for the offline fixed demo. Model credentials are mounted only in control.' \
      'COMPOSE_PROJECT_NAME selects the project and its retained home/control-state volumes.' \
      'config prints a safe image/executor summary. down retains volumes; only 127.0.0.1 is published.'
    ;;
esac
