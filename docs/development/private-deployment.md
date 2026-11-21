# Private deployment operations

Updated 2026-11-21. This runbook covers one owner on a local Linux amd64 Docker engine. The supported entry point is [private-install.sh](../../scripts/private-install.sh), using the split [Compose manifest](../../deploy/compose/compose.yaml). The [support and evidence matrix](support-matrix.md) separates fake orchestration checks, the earlier WSL runtime evidence, and work still requiring an isolated integrated stack.

## Deployment contract

Use Bash, Python 3, Node >=22, Docker Engine >=29.1 and Compose >=2.40 on Linux x86_64. The reference host is Ubuntu on WSL2 with Engine 29.1.3 / Compose 2.40.3; the version floor is a tool guard, not certification of every later version. Store private state and backups on a Linux filesystem with real ownership/0700/0600 permissions. Run every operation as the same Linux user with access to the local unix Docker socket. Native Windows/macOS, Arm, remote Docker contexts and shared/public tenants are outside this procedure.

The wrapper requires an explicit project other than `private-computer-p0`; install refuses existing project containers or either existing target volume. The state directory must be outside the repository, owned by the operator, mode 0700, with no symlink path components. Backups use a separate, nonoverlapping external directory. The wrapper never builds, pulls, publishes or removes an image, volume, credential, or backup.

The immutable deployment selection records:

- Two distinct local `sha256:` image IDs: foundation for desktop/egress and ACP for control. Mutable tags are resolved once, so moving a tag cannot alter restart or rollback.
- Project, port, offline/model mode, provider URL/model/effort, operator-supplied source/build label, checkout location, and SHA256 hashes of the Compose manifest and seccomp policy.
- A current private manifest, the previous known manifest for one-step rollback, and a pending manifest while a transition is incomplete. These contain no credential contents. The source label is provenance supplied by the operator; it is not a signed release attestation or a reproducible-build claim.

The Compose/security-policy hashes must still match for later operations. Preserve the matching source checkout and both old image IDs before upgrading. This version supports image-only upgrades with the same deployment manifest/security policy. A changed mount/network layout, control-state schema, runtime contract, or checkout location needs a separately reviewed migration and fresh recovery test.

The default is `MODEL_ENABLED=0`, even if a model key already exists. The offline fixed demo uses the same pinned ACP control image but dispatches no provider request. The control runtime is Node 24.22.3 with DSH 0.2.2-rc.3 and its policy plugin. No model endpoint is called by install, health, backup, upgrade, rollback or uninstall. Enabling the model is an explicit install choice; owner task/test actions can then incur provider usage.

## Prepare local images

Build or load the two images separately, before running private operations. The [development helper](../../scripts/dev.sh) builds the foundation and then ACP from that selected foundation. Choose fresh, release-specific tags so an older local rollback image remains reachable. Building downloads dependencies and can take substantial time; it is not performed by the installation wrapper.

```bash
export COMPOSE_PROJECT_NAME=my-private-computer
export BOT_SECRET_DIR="$HOME/.local/state/my-private-computer/secrets"
export BOT_IMAGE=private-computer:base-release-1
export BOT_ACP_IMAGE=private-computer:acp-release-1
bash scripts/dev.sh build
```

The foundation's `BOT_BASE_IMAGE` and optional HTTPS `BOT_APT_MIRROR` affect the build. Debian packages are installed from signed repository metadata, and the base image defaults to a mutable upstream tag. Record the actual resulting IDs; do not describe rebuilding those Dockerfiles later as byte-for-byte reproduction. For a disconnected second host, export/import the accepted local images through an operator-controlled transfer, and compare the imported IDs before use. Retain the old images and matching checkout until rollback is no longer needed.

## Fresh offline install and health

Run from the repository root in Linux/WSL. Substitute your own unused project, port, state directory and build identity. The selected port must be 1024–65535 and free on loopback.

```bash
project=my-private-computer
state="$HOME/.local/state/$project"
backup="$HOME/.local/share/private-computer-backups"
umask 077
mkdir -p "$state" "$backup"
chmod 700 "$state" "$backup"

bash scripts/private-install.sh install \
  --project "$project" --state-dir "$state" \
  --base-image private-computer:base-release-1 \
  --acp-image private-computer:acp-release-1 \
  --source-version release-1 --port 3180

bash scripts/private-install.sh health --project "$project" --state-dir "$state"
```

Install creates missing owner/runner credentials and an empty model-key file in the state's `secrets` subdirectory. Existing valid private files are retained byte-for-byte. Never paste these files into an issue, log, repository, task prompt or provider message. Read the owner password only in a private operator terminal:

```bash
BOT_SECRET_DIR="$state/secrets" bash scripts/dev.sh password
```

Open `http://localhost:3180`. Only `127.0.0.1:PORT` is published. Desktop VNC, noVNC bridge, CDP, runner, egress and Docker socket are not exposed to the host by this manifest. The two project volumes are `${project}_computer-home` and `${project}_control-state`. Control receives only the `Workspace` subdirectory of the home volume; the desktop owns the browser profile; control owns durable task/artifact state.

Health privately validates resolved configuration, the three running container identities and selected image IDs, credential mount names, loopback binding and pinned ACP files. It then requires all three Docker health statuses to be `healthy`. The inherited checks cover control HTTP plus runner health, desktop runner readiness, and egress TCP readiness. This establishes startup readiness, not a successful provider turn, real desktop workflow, browser sandbox certification, backup round trip or long-duration stability. Health does not perform a task or modify desktop content.

For an explicitly online fresh install, first initialize private credentials and use the interactive local key setter, then pass `--model-enabled 1` to install. The wrapper refuses an empty key. Provider options are `--model-base-url` (credential-free HTTPS), `--model-name` and `--model-effort`; the current defaults are `https://api.xingchiapi.com`, `gpt-6.1-sol`, `max`. They stay fixed for this project's subsequent operations.

```bash
BOT_SECRET_DIR="$state/secrets" bash scripts/dev.sh model-key
# Then run the same fresh install command with --model-enabled 1.
```

## Private remote access

Keep the host application bound to loopback. For a remote host, use an authenticated SSH tunnel on the owner's machine and browse the same localhost port used in the deployment selection:

```bash
ssh -N -L 127.0.0.1:3180:127.0.0.1:3180 owner@your-private-host
```

The browser URL remains `http://localhost:3180`; the network hop is protected by SSH. Keep the forwarded listener on `127.0.0.1`. This document does not provision a server, modify a firewall or start a tunnel.

HTTPS through an independently administered trusted proxy requires a separate deployment change: configure one exact external `APP_ORIGIN`, preserve its Host/Origin, forward HTTP and WebSocket traffic, terminate TLS at that trusted boundary, and test login/logout, Secure cookies and noVNC upgrades. The current Compose manifest fixes `APP_ORIGIN` to localhost, and this wrapper deliberately has no public-origin override. A proxy that merely rewrites arbitrary external Origin/Host into localhost would remove the application's origin protection. Do not use that as a workaround. Public HTTPS/proxy deployment is an unverified extension until its reviewed manifest and browser acceptance exist; the SSH procedure is the narrow usable default.

## Independent backup

A retained Docker volume is not an independent backup. Before backup, take over/cancel active work and let in-flight external operations settle. Record uncertain outcomes; recovery must not replay them. The [backup helper](../../scripts/backup-compose.sh) stops the selected project's `computer`, `desktop`, and `egress`, rejects unexpected services and other volume writers, and leaves the project stopped. No automatic restart follows success or failure.

```bash
bash scripts/private-install.sh backup \
  --project "$project" --state-dir "$state" \
  --backup-root "$backup" --backup-name before-maintenance-001

# Resume deliberately after inspecting the successful verification result.
bash scripts/private-install.sh start --project "$project" --state-dir "$state"
```

Each bundle name must be new. The helper refuses overwrites, paths inside the repository, unsafe permissions/symlinks, overlapping source mounts and remote Docker. It creates a versioned manifest with per-entry hashes and a manifest checksum, then the wrapper invokes verification separately. The bundle includes work files, durable controller state/run/artifact records, and allowlisted browser preferences/bookmarks. Chromium credential/cookie/session/password databases, OS keyrings, owner password, runner token, provider key, transient ACP homes and runtime locks are excluded. Browser accounts must be logged in again after restore. Only complete supported layouts are accepted; unknown control layouts/schemas fail closed.

Bundles are private plaintext data, not encrypted archives or authenticated signatures. Hashes detect corruption; a person able to rewrite both payload and checksum can replace them. Put the external root on encrypted operator-controlled storage, keep another protected copy on a different failure domain, and verify the copied bundle. Preserve deployment manifests, image IDs, source checkout and any separately managed credential-recovery material in your existing encrypted recovery system. Never place credentials inside the portable bundle or commit them. Keep decryption/key-management access independent from the failed host. No automatic retention deletion is provided.

## Upgrade and pinned local rollback

Build/load the next release under new tags and run the relevant source/runtime checks on an isolated test project first. Verify current and candidate application data schemas are compatible. Preserve both current image IDs and the current checkout. Upgrade performs candidate local preflight, a stopped-writer backup plus verification, records the known previous selection, recreates with pinned candidate IDs (`--no-build --pull never`), checks health, and only then promotes the current manifest.

```bash
bash scripts/private-install.sh upgrade \
  --project "$project" --state-dir "$state" \
  --base-image private-computer:base-release-2 \
  --acp-image private-computer:acp-release-2 \
  --source-version release-2 \
  --backup-root "$backup" --backup-name before-release-2-001
```

There is no automatic fallback when startup/health fails. The current manifest remains the last completed selection and the pending manifest identifies the attempted target. Containers may already use the candidate or remain stopped; inspect before acting. `start` refuses an unresolved pending transition. Keep the backup and failed-state evidence, then use the explicit rollback command if the old application can read the current data:

```bash
bash scripts/private-install.sh rollback \
  --project "$project" --state-dir "$state" \
  --backup-root "$backup" --backup-name before-rollback-001 \
  --ack-current-data
```

Rollback uses the previous manifest's local image IDs, checks that they still exist, backs up current data again, recreates and checks health. It ignores moved release tags. It retains current volumes and does not restore a snapshot, undo external actions, resume tasks, or migrate data backwards. The acknowledgement makes that boundary explicit. There is one saved previous selection; a later successful upgrade replaces it. If an older image cannot read the current schema, restore the pre-upgrade bundle into a fresh project using the recovery procedure instead.

A failure during a first install can leave a pending manifest without a completed deployment. It is intentionally not adopted as a healthy installation. Inspect the recorded selection and selected project containers/volumes in a private terminal. Prefer another unused project and state path for a new attempt; retain the failed data for diagnosis. Do not remove a state lock while an operation may still be running, and do not use `down -v`, `volume rm`, `system prune`, or delete credentials as a retry shortcut.

## Restore to a fresh project

The [backup module](../../scripts/backup.mjs) and [Compose helper](../../scripts/backup-compose.sh) restore supported data only. Pick a new nondefault project with no containers and neither target volume. Use the matching accepted local foundation image; the helper performs no pull and never starts services.

```bash
restore_project=my-private-computer-recovery
bash scripts/backup-compose.sh verify \
  --project "$restore_project" --backup-root "$backup" \
  --name before-release-2-001 --image private-computer:base-release-1
bash scripts/backup-compose.sh restore \
  --project "$restore_project" --backup-root "$backup" \
  --name before-release-2-001 --image private-computer:base-release-1
```

Restore validates the complete bundle before creating volumes, labels the new volumes with its transaction, and writes matching completion receipts to both roots only after copying successfully. A failed restore leaves its new volumes for diagnosis. Never start a partially restored pair or copy an old completion marker into it; use another fresh project for a new attempt.

The private installer refuses existing volumes, including restored ones. The recovery handoff therefore uses the explicit [development helper](../../scripts/dev.sh), whose startup guard checks restored-volume completion. Set a fresh external credential directory, the recovered project, a free port, `MODEL_ENABLED=0` and the accepted image IDs; initialize private credentials, then start:

```bash
export COMPOSE_PROJECT_NAME="$restore_project"
export BOT_SECRET_DIR="$HOME/.local/state/$restore_project/secrets"
export BOT_PORT=3182 MODEL_ENABLED=0
# Copy these exact SHA256 IDs from the preserved pre-upgrade manifest.
export BOT_IMAGE='sha256:REPLACE_WITH_PRESERVED_FOUNDATION_ID'
export BOT_ACP_IMAGE='sha256:REPLACE_WITH_PRESERVED_ACP_ID'
bash scripts/dev.sh init
bash scripts/dev.sh up
node scripts/verify-compose-config.mjs --running
```

Compare representative work-file hashes and durable task/artifact state against the backup. Verify interrupted tasks have a safe terminal/recovery state, all previous approval/lease/session identifiers are unusable, and no external action resumes. Log into browser accounts again. Model credentials stay external; configure them separately only after owner acceptance. This explicit recovered project is not automatically registered with the private wrapper, and wrapper upgrade/uninstall must not be pointed at it without a separately designed adoption procedure.

## Data-preserving uninstall

Uninstall requires a new verified backup, stops writers, and runs `compose down --timeout 30` for only the selected project. It omits `--volumes`, `--rmi` and orphan removal. Both named volumes, credentials, manifests, backup bundles and pinned local images remain.

```bash
bash scripts/private-install.sh uninstall \
  --project "$project" --state-dir "$state" \
  --backup-root "$backup" --backup-name before-uninstall-001

# Same data and keys, same pinned selection:
bash scripts/private-install.sh start --project "$project" --state-dir "$state"
```

If backup fails, removal does not run, and writers may already be stopped. Inspect/repair the backup issue before a deliberate restart. Permanent data erasure is outside this tool and requires a separate owner decision after checking independent recovery material.

## Second-machine acceptance checklist

1. Record architecture, Linux distribution, kernel, Engine/Compose versions, available memory/disk, local socket/user identity and the chosen unused project/port. The Compose limits total approximately 4.7 GiB service memory ceilings plus host/build overhead; they are limits, not a measured minimum or capacity guarantee.
2. Obtain the matching source checkout and accepted local images, compare fixed IDs, and run syntax, source tests, resolved-config fixtures and `bash scripts/verify-private-install.sh`. The last command is fake-only and cannot certify that host's Docker/runtime.
3. Use fresh Linux-filesystem state and external backup roots. Run offline install and health in an isolated project. Confirm only the intended loopback application port is published and model/owner secrets are absent from desktop/egress.
4. Exercise login/logout, persistent work files, desktop takeover/revocation and the offline fixture on that disposable desktop. Keep credential-free evidence of exact images/configuration and outcomes. A provider test is a separate explicitly approved step.
5. Back up, verify, uninstall without data removal, restart and compare data/credential hashes locally. Perform a fresh-project restore and confirm no task or approval automatically resumes.
6. Test a candidate upgrade and pinned rollback, including a failed-health transition; verify new bundle names, retained images/volumes and the unresolved-transition guard. Record schema compatibility and what is not covered.
7. Have the owner accept the recovered work and remote access path before using important accounts or migrating daily work. Until these host-specific steps pass, describe the machine as an unverified deployment candidate.
