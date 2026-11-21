#!/usr/bin/env bash
# Private, local-only operations. This command never builds, pulls or removes data.
set -euo pipefail
umask 077
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
usage() {
  cat <<'USAGE'
Usage: bash scripts/private-install.sh ACTION --project NAME --state-dir ABSOLUTE_PRIVATE_DIR [OPTIONS]
Actions: install | health | start | backup | upgrade | rollback | uninstall
install: --base-image LOCAL_REF --acp-image LOCAL_REF --source-version REVISION
         [--port 3180] [--model-enabled 0|1] [--model-base-url HTTPS_URL]
         [--model-name NAME] [--model-effort EFFORT]
upgrade: --base-image LOCAL_REF --acp-image LOCAL_REF --source-version REVISION
         --backup-root PRIVATE_EXTERNAL_DIR --backup-name NEW_BUNDLE
rollback: --backup-root PRIVATE_EXTERNAL_DIR --backup-name NEW_BUNDLE --ack-current-data
backup/uninstall: --backup-root PRIVATE_EXTERNAL_DIR --backup-name NEW_BUNDLE
Use a new, explicit project (not private-computer-p0) and an external 0700 state directory.
install defaults to MODEL_ENABLED=0. Images are resolved to local linux/amd64 SHA256 IDs.
upgrade and rollback retain current data; no schema/data migration or automatic rollback occurs.
uninstall stops/removes only selected project containers/network; volumes, keys, manifests and images remain.
USAGE
}
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ $# -gt 0 ]] || { usage; exit 2; }
action="$1"; shift
[[ "$action" != --help && "$action" != -h ]] || { usage; exit 0; }
project= state_dir= base_ref= acp_ref= source_version= backup_root= backup_name= ack_current_data=0
port=3180 model_enabled=0 model_base_url=https://api.xingchiapi.com model_name=gpt-6.1-sol model_effort=max
selection_options=0 image_options=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|--state-dir|--base-image|--acp-image|--source-version|--backup-root|--backup-name|--port|--model-enabled|--model-base-url|--model-name|--model-effort)
      [[ $# -ge 2 && -n "$2" ]] || { usage >&2; exit 2; }
      case "$1" in
        --project) project="$2" ;; --state-dir) state_dir="$2" ;;
        --base-image) base_ref="$2"; image_options=1 ;; --acp-image) acp_ref="$2"; image_options=1 ;;
        --source-version) source_version="$2"; image_options=1 ;;
        --backup-root) backup_root="$2" ;; --backup-name) backup_name="$2" ;;
        --port) port="$2"; selection_options=1 ;; --model-enabled) model_enabled="$2"; selection_options=1 ;;
        --model-base-url) model_base_url="$2"; selection_options=1 ;; --model-name) model_name="$2"; selection_options=1 ;;
        --model-effort) model_effort="$2"; selection_options=1 ;;
      esac
      shift 2 ;;
    --ack-current-data) ack_current_data=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
case "$action" in install|health|start|backup|upgrade|rollback|uninstall) ;; *) usage >&2; exit 2 ;; esac
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]{2,62}$ && "$project" != private-computer-p0 ]] || fail 'An explicit nondefault project is required; private-computer-p0 is blocked.'
[[ "$action" == install || "$selection_options" == 0 ]] || fail 'Port/model selection is immutable for an installed project; use a new private project to change it.'
[[ "$action" == install || "$action" == upgrade || "$image_options" == 0 ]] || fail 'Image/source options are accepted only for install or upgrade.'
if [[ "$action" == install || "$action" == upgrade ]]; then
  [[ -n "$base_ref" && -n "$acp_ref" && -n "$source_version" ]] || fail 'Both local images and --source-version are required.'
fi
case "$action" in
  backup|upgrade|rollback|uninstall) [[ -n "$backup_root" && -n "$backup_name" ]] || fail 'A private backup root and new backup name are required.' ;;
  *) [[ -z "$backup_root" && -z "$backup_name" ]] || fail 'Backup options are not used by this action.' ;;
esac
[[ "$action" != rollback || "$ack_current_data" == 1 ]] || fail 'Rollback changes images only; --ack-current-data confirms that current data will be retained.'
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail 'Only native Linux/WSL x86_64 with a local Linux Docker engine is supported.'
# Validate path components before creating anything; do not follow a state symlink.
python3 - "$state_dir" "$project_root" "$action" <<'PY'
import os, pathlib, stat, sys
raw, repo, action = sys.argv[1:]
p = pathlib.Path(raw)
def reject(message): raise SystemExit(message)
if not raw or not p.is_absolute() or '\n' in raw or '\r' in raw or ',' in raw or '..' in p.parts:
    reject('State directory must be an absolute Linux path without traversal, newlines or commas.')
if str(p) == '/' or p == pathlib.Path(repo) or pathlib.Path(repo) in p.parents:
    reject('Private state must be outside the repository.')
for item in [*reversed(p.parents), p]:
    if item.is_symlink(): reject('State path components must not be symlinks.')
if action == 'install': p.mkdir(mode=0o700, parents=True, exist_ok=True)
if not p.is_dir(): reject('Private state directory is missing.')
s = p.stat()
if s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o700:
    reject('State directory must be owned by the invoking user with permissions 0700.')
PY
state_dir="$(cd -- "$state_dir" && pwd -P)"
if [[ -n "$backup_root" ]]; then
  python3 - "$backup_root" "$state_dir" <<'PY'
import pathlib, sys
backup, state = map(lambda value: pathlib.Path(value).resolve(), sys.argv[1:])
if backup == state or state in backup.parents or backup in state.parents:
    raise SystemExit('Backup root and private state must be separate nonoverlapping directories.')
PY
fi
current="$state_dir/deployment.json"
previous="$state_dir/rollback.json"
pending="$state_dir/pending.json"
for path in "$current" "$previous" "$pending"; do
  [[ ! -L "$path" && ( ! -e "$path" || -f "$path" ) ]] || fail 'Deployment manifests must be regular private files.'
done
if [[ "$action" != health ]]; then
  lock="$state_dir/.operation.lock"
  mkdir -- "$lock" || fail 'Another private operation holds the state lock; inspect a stale lock before removing it.'
  trap 'rmdir -- "$lock"' EXIT
fi
[[ "${DOCKER_HOST:-unix:///var/run/docker.sock}" == unix://* ]] || fail 'Remote Docker hosts are unsupported.'
endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
[[ "$endpoint" == unix://* ]] || fail 'Remote Docker contexts are unsupported.'
engine="$(docker info --format '{{.ServerVersion}} {{.OSType}} {{.Architecture}}')"
compose_version="$(docker compose version --short)"
python3 - "$engine" "$compose_version" <<'PY'
import re, sys
engine = sys.argv[1].split()
def version(raw):
    parts = re.match(r'^v?(\d+)\.(\d+)(?:\.(\d+))?', raw)
    if not parts: raise SystemExit('Cannot identify a supported local Docker/Compose version.')
    return tuple(int(x or 0) for x in parts.groups())
if len(engine) != 3 or engine[1] != 'linux' or engine[2] not in ('x86_64', 'amd64') or version(engine[0]) < (29, 1, 0) or version(sys.argv[2]) < (2, 40, 0):
    raise SystemExit('Require local Linux amd64 Docker Engine >=29.1 and Compose >=2.40; only the documented reference versions have runtime evidence.')
PY
load_manifest() {
  local values
  values="$(python3 - "$1" "$project" "$project_root" <<'PY'
import hashlib, json, os, pathlib, re, stat, sys
from urllib.parse import urlsplit
file, project, root = sys.argv[1:]
p = pathlib.Path(file)
s = p.stat()
if p.is_symlink() or s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o600: raise SystemExit('Manifest must be a private regular 0600 file owned by this user.')
v = json.loads(p.read_text())
if v.get('schema') != 1 or v.get('project') != project or v.get('checkout') != root: raise SystemExit('Deployment identity does not match this project and checkout.')
for key, relative in [('composeSha256', 'deploy/compose/compose.yaml'), ('seccompSha256', 'deploy/compose/chromium-seccomp.json')]:
    if v.get(key) != hashlib.sha256((pathlib.Path(root) / relative).read_bytes()).hexdigest(): raise SystemExit('Deployment manifest/security policy changed; restore the recorded checkout before operating this project.')
fields = ['baseImageId', 'acpImageId', 'sourceVersion', 'port', 'modelEnabled', 'modelBaseUrl', 'modelName', 'modelEffort']
for key in fields:
    value = v.get(key)
    if not isinstance(value, str) or not value or '\n' in value or '\r' in value: raise SystemExit('Invalid deployment selection.')
for key in ['baseImageId', 'acpImageId']:
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', v[key]): raise SystemExit('Deployment images must be pinned SHA256 IDs.')
if v['baseImageId'] == v['acpImageId']: raise SystemExit('Base and ACP images must differ.')
if not re.fullmatch(r'[0-9]{4,5}', v['port']) or not 1024 <= int(v['port']) <= 65535 or v['modelEnabled'] not in ('0', '1'): raise SystemExit('Invalid port/model selection.')
u = urlsplit(v['modelBaseUrl'])
if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment: raise SystemExit('Provider must be a credential-free HTTPS URL.')
for key in fields: print(v[key])
PY
)" || return 1
  mapfile -t selection <<< "$values"
  base_id="${selection[0]}"; acp_id="${selection[1]}"; loaded_source="${selection[2]}"
  port="${selection[3]}"; model_enabled="${selection[4]}"; model_base_url="${selection[5]}"; model_name="${selection[6]}"; model_effort="${selection[7]}"
}
credentials() {
  python3 - "$state_dir/secrets" "$1" <<'PY'
import os, pathlib, secrets, stat, sys
p, initialize = pathlib.Path(sys.argv[1]), sys.argv[2] == 'initialize'
if p.is_symlink(): raise SystemExit('Credential directory must not be a symlink.')
if initialize: p.mkdir(mode=0o700, exist_ok=True)
if not p.is_dir() or p.stat().st_uid != os.getuid() or stat.S_IMODE(p.stat().st_mode) != 0o700: raise SystemExit('Credential directory must be owned by this user with permissions 0700.')
for name in ['owner-password', 'runner-token', 'model-key']:
    f = p / name
    if f.is_symlink(): raise SystemExit('Credentials must not be symlinks.')
    if initialize and not f.exists():
        with f.open('x') as handle: handle.write('' if name == 'model-key' else secrets.token_urlsafe(32) + '\n')
        f.chmod(0o600)
    if not f.is_file() or f.stat().st_uid != os.getuid() or stat.S_IMODE(f.stat().st_mode) != 0o600: raise SystemExit('Credential files must be regular private 0600 files owned by this user.')
    if name != 'model-key' and not f.stat().st_size: raise SystemExit('An owner/runner credential is empty.')
PY
}
select_environment() {
  export COMPOSE_PROJECT_NAME="$project" BOT_SECRET_DIR="$state_dir/secrets" BOT_PORT="$port"
  export BOT_IMAGE="$base_id" BOT_ACP_IMAGE="$acp_id" MODEL_ENABLED="$model_enabled"
  export MODEL_BASE_URL="$model_base_url" MODEL_NAME="$model_name" MODEL_EFFORT="$model_effort"
  compose=(docker compose --project-directory "$project_root" --project-name "$project" -f "$project_root/deploy/compose/compose.yaml")
}
resolve_image() {
  local result
  result="$(docker image inspect "$1" --format '{{.Id}} {{.Os}} {{.Architecture}}')" || fail 'Required local image is missing; build/load it separately. No image will be pulled.'
  [[ "$result" =~ ^(sha256:[a-f0-9]{64})\ linux\ amd64$ ]] || fail 'Image must be a local linux/amd64 image with a SHA256 ID.'
  printf '%s\n' "${BASH_REMATCH[1]}"
}
write_manifest() {
  python3 - "$1" "$project_root" "$source_version" "$base_ref" "$acp_ref" <<'PY'
import datetime, hashlib, json, os, pathlib, sys
file, root, source, base_ref, acp_ref = sys.argv[1:]
for value in [source, base_ref, acp_ref, *[os.environ[key] for key in ['BOT_PORT', 'MODEL_ENABLED', 'MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_EFFORT']]]:
    if not value or '\n' in value or '\r' in value: raise SystemExit('Deployment values must be nonempty single-line strings.')
v = dict(schema=1, project=os.environ['COMPOSE_PROJECT_NAME'], checkout=root, sourceVersion=source,
         baseImageRef=base_ref, acpImageRef=acp_ref, baseImageId=os.environ['BOT_IMAGE'], acpImageId=os.environ['BOT_ACP_IMAGE'],
         port=os.environ['BOT_PORT'], modelEnabled=os.environ['MODEL_ENABLED'], modelBaseUrl=os.environ['MODEL_BASE_URL'],
         modelName=os.environ['MODEL_NAME'], modelEffort=os.environ['MODEL_EFFORT'], recordedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
for key, relative in [('composeSha256', 'deploy/compose/compose.yaml'), ('seccompSha256', 'deploy/compose/chromium-seccomp.json')]:
    v[key] = hashlib.sha256((pathlib.Path(root) / relative).read_bytes()).hexdigest()
p = pathlib.Path(file)
if p.is_symlink(): raise SystemExit('Refusing a manifest symlink.')
with p.open('w') as handle: json.dump(v, handle, indent=2); handle.write('\n')
p.chmod(0o600)
PY
}
copy_manifest() {
  python3 - "$1" "$2" <<'PY'
import os, pathlib, sys
source, target = map(pathlib.Path, sys.argv[1:])
if source.is_symlink() or target.is_symlink(): raise SystemExit('Refusing a manifest symlink.')
temporary = target.with_name(target.name + '.next')
with temporary.open('x') as handle: handle.write(source.read_text()); handle.flush(); os.fsync(handle.fileno())
temporary.chmod(0o600)
os.replace(temporary, target)
PY
}
assert_project() {
  local ids id role owner users
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
  for id in $ids; do
    role="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$id")"
    [[ "$role" == computer || "$role" == desktop || "$role" == egress ]] || fail 'Unexpected service in selected project; refusing to modify it.'
  done
  for volume in "${project}_computer-home" "${project}_control-state"; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      owner="$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$volume")"
      [[ -z "$owner" || "$owner" == '<no value>' || "$owner" == "$project" ]] || fail 'Selected volume belongs to a different project.'
      users="$(docker ps -aq --filter "volume=$volume")"
      for id in $users; do
        owner="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$id")"
        [[ "$owner" == "$project" ]] || fail 'Selected volume is attached to another project; refusing to modify it.'
      done
    fi
  done
}
health() {
  node "$project_root/scripts/verify-compose-config.mjs" --running
  local role ids status
  for role in computer desktop egress; do
    ids="$("${compose[@]}" ps --all -q "$role")"
    [[ "$ids" =~ ^[a-f0-9]{12,64}$ ]] || fail 'Expected exactly one selected service container.'
    status="$(docker inspect --format '{{.State.Health.Status}}' "$ids")"
    [[ "$status" == healthy ]] || fail 'A selected service is not healthy; inspect local logs privately.'
  done
  printf '%s\n' 'Health passed: selected pinned images, runtime, loopback binding and three Docker healthchecks. Model requests: 0.'
}
backup_selected() {
  bash "$project_root/scripts/backup-compose.sh" create --project "$project" --backup-root "$backup_root" --name "$backup_name" --source-version "$loaded_source" --image "$base_id"
  bash "$project_root/scripts/backup-compose.sh" verify --project "$project" --backup-root "$backup_root" --name "$backup_name" --image "$base_id"
}
if [[ "$action" == install ]]; then
  [[ ! -e "$current" && ! -e "$pending" && ! -e "$previous" ]] || fail 'Deployment state exists; use start, upgrade or rollback.'
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]] || fail 'Install requires a fresh project with no containers.'
  for volume in "${project}_computer-home" "${project}_control-state"; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then fail 'Install requires absent target volumes. For restored volumes, use the documented explicit dev.sh handoff.'; fi
  done
  base_id="$(resolve_image "$base_ref")"; acp_id="$(resolve_image "$acp_ref")"
  [[ "$base_id" != "$acp_id" ]] || fail 'Base and ACP images must have different local IDs.'
  credentials initialize
  select_environment
  node "$project_root/scripts/verify-compose-config.mjs" --images
  [[ "$model_enabled" == 0 || -s "$BOT_SECRET_DIR/model-key" ]] || fail 'ACP model credential is missing; configure it privately before online install.'
  write_manifest "$pending"
  load_manifest "$pending"
  bash "$project_root/scripts/dev.sh" up
  health
  copy_manifest "$pending" "$current"
else
  [[ -f "$current" ]] || fail 'No completed private installation manifest exists.'
  load_manifest "$current"
  credentials validate
  select_environment
  assert_project
  case "$action" in
    health) health; exit 0 ;;
    backup) backup_selected; exit 0 ;;
    uninstall)
      backup_selected
      "${compose[@]}" down --timeout 30
      printf '%s\n' 'Uninstalled selected containers/network; both named volumes, credentials, manifests and local images are retained. Backup verified. Use start to resume.'
      exit 0 ;;
    start)
      [[ ! -e "$pending" ]] || fail 'An incomplete transition exists; inspect pending.json and use rollback before start.'
      resolve_image "$base_id" >/dev/null; resolve_image "$acp_id" >/dev/null
      for volume in "${project}_computer-home" "${project}_control-state"; do docker volume inspect "$volume" >/dev/null || fail 'Retained volume missing; do not start an empty replacement.'; done
      bash "$project_root/scripts/dev.sh" up
      health
      exit 0 ;;
    upgrade)
      [[ ! -e "$pending" ]] || fail 'An incomplete transition exists; use rollback before another upgrade.'
      candidate_base="$(resolve_image "$base_ref")"; candidate_acp="$(resolve_image "$acp_ref")"
      [[ "$candidate_base" != "$candidate_acp" ]] || fail 'Base and ACP images must have different local IDs.'
      # Validate candidate runtime/config without stopping current writers first.
      old_base="$base_id"; old_acp="$acp_id"
      base_id="$candidate_base"; acp_id="$candidate_acp"; select_environment
      node "$project_root/scripts/verify-compose-config.mjs" --images
      base_id="$old_base"; acp_id="$old_acp"; select_environment
      backup_selected
      copy_manifest "$current" "$previous"
      base_id="$candidate_base"; acp_id="$candidate_acp"; select_environment
      write_manifest "$pending"
      load_manifest "$pending"
      bash "$project_root/scripts/dev.sh" recreate
      health
      copy_manifest "$pending" "$current"
      ;;
    rollback)
      [[ -f "$previous" ]] || fail 'No pinned local rollback manifest exists.'
      # Validate the target before stopping any current writers; preserve current settings on failure.
      saved_base="$base_id"; saved_acp="$acp_id"; saved_source="$loaded_source"
      load_manifest "$previous"
      resolve_image "$base_id" >/dev/null; resolve_image "$acp_id" >/dev/null
      select_environment
      node "$project_root/scripts/verify-compose-config.mjs" --images
      base_id="$saved_base"; acp_id="$saved_acp"; loaded_source="$saved_source"; select_environment
      backup_selected
      copy_manifest "$previous" "$pending"
      load_manifest "$pending"; select_environment
      bash "$project_root/scripts/dev.sh" recreate
      health
      copy_manifest "$pending" "$current"
      ;;
  esac
fi
python3 - "$pending" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
if p.is_symlink() or p.name != 'pending.json': raise SystemExit('Unexpected transition manifest path.')
p.unlink()
PY
printf 'Private %s completed for project %s. Credentials and deployment selection remain in the private state directory.\n' "$action" "$project"
