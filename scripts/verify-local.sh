#!/usr/bin/env bash
# Offline regression for the preserved immutable P0 image, not split ACP acceptance.
# Uses its own project/home volume and never passes owner/model credentials to a runner.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_root"
export BOT_SECRET_DIR="${BOT_SECRET_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/private-computer-p0}"
export BOT_PORT="${BOT_PORT:-3180}"
export MODEL_ENABLED=0
project="${P0_VERIFY_PROJECT:-private-computer-p0-verification}"
if [[ "$project" == private-computer-p0 || ! "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo 'P0_VERIFY_PROJECT must be an isolated lowercase project, not the default split application project.' >&2; exit 1
fi
compose=(docker compose --project-directory "$project_root" --project-name "$project" -f "$project_root/deploy/compose/compose.p0.yaml")
docker image inspect private-computer:p0 >/dev/null 2>&1 || { echo 'The preserved private-computer:p0 image is required for this offline rollback regression.' >&2; exit 1; }
bash scripts/dev.sh init
evidence_dir=.local/evidence/p0-rollback
mkdir -p "$evidence_dir"
trap '"${compose[@]}" stop >/dev/null 2>&1 || true' EXIT
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 180
container_id="$("${compose[@]}" ps -q computer)"
if [[ ! "$container_id" =~ ^[a-f0-9]{12,64}$ ]]; then echo 'Expected one isolated P0 verification container.' >&2; exit 1; fi
printf '%s\n' 'Checking the preserved P0 desktop, browser, files and control handoff without a model.'
docker exec --user desktop "$container_id" node scripts/verify-runtime.mjs | tee "$evidence_dir/runtime.json"
printf '%s\n' 'Recreating only the isolated P0 verification project, retaining its home volume.'
"${compose[@]}" up -d --no-build --pull never --force-recreate --wait --wait-timeout 180
container_id="$("${compose[@]}" ps -q computer)"
if [[ ! "$container_id" =~ ^[a-f0-9]{12,64}$ ]]; then echo 'Expected one recreated P0 verification container.' >&2; exit 1; fi
docker exec --user desktop "$container_id" node scripts/verify-runtime.mjs --check-persistence | tee "$evidence_dir/persistence.json"
printf '%s\n' 'Checking P0 browser login, framebuffer pixels, fixed demo and layout.'
docker exec --user desktop "$container_id" node scripts/verify-browser.mjs | tee "$evidence_dir/browser.json"
docker cp "$container_id:/home/desktop/.private-computer/p0-ui.png" "$evidence_dir/p0-ui.png"
docker stats --no-stream --format '{{json .}}' "$container_id" | tee "$evidence_dir/resource-snapshot.json"
printf '%s\n' 'Offline P0 rollback regression passed. This does not certify split ACP A2-A5.' \
  'The isolated verification project is stopped on exit; verification volumes are retained.' \
  "Evidence: $evidence_dir/ (ignored by Git)."
