#!/usr/bin/env bash
# Offline rehearsal of an EXISTING isolated split project; never builds or pulls.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_root"
mode="${1:---help}"
if [[ "$mode" == --help || "$mode" == -h ]]; then
  node scripts/verify-split.mjs --help
  exit 0
fi
if [[ "$mode" == --self-test ]]; then
  node scripts/verify-split.mjs --self-test
  exit 0
fi
if [[ "$#" != 1 || ! "$mode" =~ ^(smoke|persistence|isolation|recreate|recreate-interrupted)$ ]]; then
  echo 'Usage: bash scripts/verify-split.sh smoke|persistence|isolation|recreate|recreate-interrupted|--self-test|--help' >&2
  exit 1
fi
: "${COMPOSE_PROJECT_NAME:?Choose an explicit isolated Compose project}"
: "${BOT_PORT:?Choose an explicit non-default localhost owner port}"
: "${BOT_SECRET_DIR:?Choose the explicit isolated project private directory}"
if [[ ! "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ || ! "$COMPOSE_PROJECT_NAME" =~ (check|test|smoke|verify) || "$COMPOSE_PROJECT_NAME" == private-computer-p0 ]]; then
  echo 'COMPOSE_PROJECT_NAME must identify an isolated check/test/smoke/verify project.' >&2; exit 1
fi
if [[ ! "$BOT_PORT" =~ ^[0-9]{4,5}$ ]] || (( 10#$BOT_PORT < 1024 || 10#$BOT_PORT > 65535 || 10#$BOT_PORT == 3180 )); then
  echo 'BOT_PORT must explicitly choose 1024-65535, excluding the active default 3180.' >&2; exit 1
fi
if [[ "$BOT_SECRET_DIR" != /* || "$(basename -- "${BOT_SECRET_DIR%/}")" != "$COMPOSE_PROJECT_NAME" || -L "$BOT_SECRET_DIR" ]]; then
  echo 'BOT_SECRET_DIR must be a real absolute directory named after this isolated project.' >&2; exit 1
fi
BOT_SECRET_DIR="${BOT_SECRET_DIR%/}"
if [[ ! -f "$BOT_SECRET_DIR/owner-password" || -L "$BOT_SECRET_DIR/owner-password" ]]; then
  echo 'The existing isolated owner credential must be a regular file.' >&2; exit 1
fi
export COMPOSE_PROJECT_NAME BOT_PORT BOT_SECRET_DIR
export MODEL_ENABLED=0
export BOT_IMAGE="${BOT_IMAGE:-private-computer:mvp}"
export BOT_ACP_IMAGE="${BOT_ACP_IMAGE:-private-computer:acp}"
evidence_dir="${SPLIT_VERIFY_EVIDENCE_DIR:-$project_root/.local/evidence/$COMPOSE_PROJECT_NAME}"
compose=(docker compose --project-directory "$project_root" --project-name "$COMPOSE_PROJECT_NAME" -f "$project_root/deploy/compose/compose.yaml")
probe() {
  node scripts/verify-split.mjs --project "$COMPOSE_PROJECT_NAME" --port "$BOT_PORT" --phase "$1" --owner-password-file "$BOT_SECRET_DIR/owner-password" --evidence-dir "$evidence_dir"
}
if [[ "$mode" == smoke || "$mode" == persistence || "$mode" == isolation ]]; then
  probe "$mode"
  exit 0
fi
# The initial probe verifies image/source, owner-file mount, published port and all
# volume labels before ANY mutation. Only the named project is ever recreated.
node scripts/verify-compose-config.mjs --running
probe smoke
if [[ "$mode" == recreate-interrupted ]]; then
  probe prepare-restart
  computer_id="$("${compose[@]}" ps -q computer)"
  if [[ ! "$computer_id" =~ ^[a-f0-9]{12,64}$ ]]; then echo 'Expected one isolated control container.' >&2; exit 1; fi
  # Inspect the current target immediately before this explicit abrupt restart.
  identity="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}:{{ index .Config.Labels "com.docker.compose.service" }}' "$computer_id")"
  if [[ "$identity" != "$COMPOSE_PROJECT_NAME:computer" ]]; then echo 'Refusing to interrupt a container from another project.' >&2; exit 1; fi
  printf '%s\n' 'Abruptly stopping only the explicitly selected isolated control to test interrupted-run recovery.'
  docker kill --signal KILL "$computer_id" >/dev/null
fi
printf '%s\n' 'Recreating the isolated control and desktop with the same named data volumes and existing local images.'
"${compose[@]}" up -d --no-build --pull never --no-deps --force-recreate --wait --wait-timeout 180 computer desktop
probe persistence
printf '%s\n' "Offline split recreation rehearsal passed. Evidence: $evidence_dir" \
  'The isolated project remains running. Its data volumes were retained.' \
  'Real ACP tools/approvals/usage, rendered owner UI and public egress require separate acceptance.'
