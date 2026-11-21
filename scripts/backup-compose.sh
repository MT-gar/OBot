#!/usr/bin/env bash
# Offline helper for the existing computer/desktop/egress Compose volume seam.
set -euo pipefail
umask 077
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
usage() {
  printf '%s\n' \
    'Usage: bash scripts/backup-compose.sh create|verify|restore --project EXPLICIT_NONDEFAULT_PROJECT --backup-root PRIVATE_EXTERNAL_DIR --name BUNDLE [--source-version REVISION] [--image LOCAL_IMAGE]' \
    'create stops that project, checks all users of its volumes, and leaves it stopped.' \
    'restore requires no target project containers and two absent target volumes; it never starts services.' \
    'Browser policy is external-relogin: settings/bookmarks only; credentials and keyrings stay external.' \
    'Only local Linux/WSL Docker via a unix socket is supported. Images are never pulled.'
}
[[ $# -gt 0 ]] || { usage; exit 2; }
action="$1"; shift
project= backup_root= name= source_version= image="${BOT_IMAGE:-private-computer:mvp}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|--backup-root|--name|--source-version|--image)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      case "$1" in
        --project) project="$2" ;; --backup-root) backup_root="$2" ;; --name) name="$2" ;;
        --source-version) source_version="$2" ;; --image) image="$2" ;;
      esac
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ "$action" == create || "$action" == verify || "$action" == restore ]] || { usage >&2; exit 2; }
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]{2,62}$ && "$project" != private-computer-p0 ]] || { echo 'An explicit nondefault project is required; the daily private-computer-p0 project is blocked.' >&2; exit 2; }
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$ ]] || { echo 'An explicit portable bundle name is required.' >&2; exit 2; }
[[ -n "$backup_root" && -d "$backup_root" && ! -L "$backup_root" ]] || { echo 'Create a private external backup root first (umask 077; mkdir ...).' >&2; exit 2; }
requested_root="$(cd -- "$backup_root" && pwd -L)"
backup_root="$(cd -- "$backup_root" && pwd -P)"
[[ "$requested_root" == "$backup_root" && "$backup_root" != / && "$backup_root" != "$project_root" && "$backup_root" != "$project_root/"* && "$backup_root" != *','* && "$project_root" != *','* ]] || { echo 'Backup root must be outside the repository and have no symlink components or commas.' >&2; exit 2; }
[[ "$(stat -c '%a' -- "$backup_root")" == 700 ]] || { echo 'Backup root permissions must be 700.' >&2; exit 2; }
[[ "${DOCKER_HOST:-unix:///var/run/docker.sock}" == unix://* ]] || { echo 'Remote Docker hosts are unsupported; use a local unix socket.' >&2; exit 2; }
endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
[[ "$endpoint" == unix://* ]] || { echo 'Remote Docker contexts are unsupported.' >&2; exit 2; }
docker info --format '{{.ServerVersion}}' >/dev/null
docker image inspect "$image" >/dev/null
[[ -f "$project_root/scripts/backup.mjs" ]] || { echo 'Portable backup module is missing.' >&2; exit 2; }
lock="$backup_root/.$project.operation.lock"
mkdir -- "$lock" || { echo 'Another operation holds the project backup lock; inspect it before removing a stale lock.' >&2; exit 1; }
trap 'rmdir -- "$lock"' EXIT
home_volume="${project}_computer-home"
control_volume="${project}_control-state"
helper=(docker run --rm --pull never --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER --security-opt no-new-privileges --pids-limit 64 --memory 512m --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m --mount "type=bind,src=$project_root/scripts/backup.mjs,dst=/backup.mjs,readonly")
policy=(--writers-stopped --profile-key-policy external-relogin --private-root-ack)
assert_unused() {
  local users
  users="$(docker ps -q --filter "volume=$home_volume")$(docker ps -q --filter "volume=$control_volume")"
  [[ -z "$users" ]] || { echo 'A container still uses a source/target volume. Stop all writers before proceeding.' >&2; exit 1; }
}
assert_external() {
  local volume="$1" mountpoint label
  mountpoint="$(docker volume inspect --format '{{.Mountpoint}}' "$volume")"
  label="$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$volume")"
  [[ -z "$label" || "$label" == '<no value>' || "$label" == "$project" ]] || { echo 'Volume project label mismatch.' >&2; exit 1; }
  [[ -n "$mountpoint" && "$backup_root" != "$mountpoint" && "$backup_root" != "$mountpoint/"* && "$mountpoint" != "$backup_root/"* ]] || { echo 'Backup directory overlaps a Docker source volume.' >&2; exit 1; }
}
case "$action" in
  create)
    [[ -n "$source_version" ]] || { echo '--source-version is required (revision/build identity).' >&2; exit 2; }
    [[ ! -e "$backup_root/$name" && ! -L "$backup_root/$name" ]] || { echo 'Bundle destination exists; refusing overwrite.' >&2; exit 1; }
    for volume in "$home_volume" "$control_volume"; do docker volume inspect "$volume" >/dev/null; assert_external "$volume"; done
    mapfile -t containers < <(docker ps -aq --filter "label=com.docker.compose.project=$project")
    for container in "${containers[@]}"; do
      role="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")"
      [[ "$role" == computer || "$role" == desktop || "$role" == egress ]] || { echo 'Unexpected service in the selected project; refusing stop.' >&2; exit 1; }
    done
    if [[ ${#containers[@]} -gt 0 ]]; then docker stop --time 30 "${containers[@]}" >/dev/null; fi
    assert_unused
    "${helper[@]}" --mount "type=volume,src=$home_volume,dst=/source/home,readonly" --mount "type=volume,src=$control_volume,dst=/source/control,readonly" --mount "type=bind,src=$backup_root,dst=/backups" --entrypoint node "$image" /backup.mjs create --home /source/home --control /source/control --destination "/backups/$name" --source-version "$source_version" --project "$project" --uid "$(id -u)" --gid "$(id -g)" "${policy[@]}"
    assert_unused
    echo 'Backup complete; the selected project remains stopped. Keep the bundle private and outside both source volumes.'
    ;;
  verify)
    "${helper[@]}" --mount "type=bind,src=$backup_root,dst=/backups,readonly" --entrypoint node "$image" /backup.mjs verify --backup "/backups/$name"
    ;;
  restore)
    [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]] || { echo 'Restore target must be a fresh project with no containers.' >&2; exit 1; }
    for volume in "$home_volume" "$control_volume"; do
      if docker volume inspect "$volume" >/dev/null 2>&1; then echo 'Restore target volume already exists; use a fresh project.' >&2; exit 1; fi
    done
    # Validate every manifest path and byte before creating any destination volume.
    "${helper[@]}" --mount "type=bind,src=$backup_root,dst=/backups,readonly" --entrypoint node "$image" /backup.mjs verify --backup "/backups/$name"
    transaction="restore-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    docker volume create --label "com.docker.compose.project=$project" --label com.docker.compose.volume=computer-home --label "org.private-computer.restore=$transaction" "$home_volume" >/dev/null
    docker volume create --label "com.docker.compose.project=$project" --label com.docker.compose.volume=control-state --label "org.private-computer.restore=$transaction" "$control_volume" >/dev/null
    for volume in "$home_volume" "$control_volume"; do
      [[ "$(docker volume inspect --format '{{index .Labels "org.private-computer.restore"}}' "$volume")" == "$transaction" ]] || { echo 'A target volume was created concurrently; refusing to write it.' >&2; exit 1; }
    done
    assert_unused
    "${helper[@]}" --mount "type=bind,src=$backup_root,dst=/backups,readonly" --mount "type=volume,src=$home_volume,dst=/target/home" --mount "type=volume,src=$control_volume,dst=/target/control" --entrypoint node "$image" /backup.mjs restore-volumes --backup "/backups/$name" --home /target/home --control /target/control --uid 1100 --gid 1100 "${policy[@]}"
    assert_unused
    printf 'Restored fresh volumes: %s and %s\n' "$home_volume" "$control_volume"
    echo 'Services remain stopped. Require matching .restore-complete.json markers in both volumes before startup; configure fresh external credentials and log in again.'
    echo 'If a copy failed, treat both newly created volumes as incomplete; inspect the restore label and use another fresh project. No existing volumes are removed automatically.'
    ;;
esac
