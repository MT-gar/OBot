# Private deployment support and evidence matrix

Updated 2026-11-21. Support here means the narrow operational contract in the [private deployment runbook](private-deployment.md). A source test, a fake command trace, an older runtime experiment and a fresh-stack acceptance run establish different things. None alone certifies a public service or an unrelated machine.

## Platform and deployment boundary

| Area | Current contract | Evidence / remaining limit |
| --- | --- | --- |
| Host architecture | Linux x86_64 / local Linux amd64 images | Explicit wrapper guard; Arm and emulation are rejected. |
| Reference host | Ubuntu WSL2 on this Windows machine | Earlier Engine 29.1.3 / Compose 2.40.3 runtime recorded in the [P0 log](wsl-p0.md). This is one host, not second-machine evidence. |
| Engine/tool floor | Docker Engine >=29.1, Compose >=2.40, Bash, Python 3, Node >=22 | Local version and architecture guard. Runtime coverage of every newer version is not implied. Compose subpath and readiness behavior require host acceptance. |
| Docker endpoint | Local unix socket only | Fake cases reject TCP and SSH context endpoints. Rootless/custom unix-socket engines have no dedicated runtime acceptance here. |
| State filesystem | Linux filesystem, operator-owned state/secret directories 0700, files 0600 | Path/mode/symlink guards and fake filesystem checks. A Windows-mounted filesystem without real permissions is unsuitable for private state. |
| Services | `computer` control + `desktop` + `egress`, no optional profiles | Resolved-config verifier and exact selected-project health. No Kubernetes, multi-host or public multi-tenant support. |
| Images | Two distinct accepted local SHA256 IDs, linux/amd64 | Install pins content IDs; restart/rollback do not follow mutable tag changes. Upstream builds still use live apt/npm/base dependencies and are not reproducible release builds. |
| ACP runtime | Control Node 24.22.3, DSH 0.2.2-rc.3, ACP profile/policy | Static local preflight / selected running-image inspection. It does not dispatch DSH/model turns. |
| Default execution | Offline `MODEL_ENABLED=0` | Fake install confirms explicit offline environment. Online mode requires a separately stored nonempty provider key. |
| Listener | One selected loopback IPv4 application port | Config/running verification asserts `127.0.0.1`; no runner/VNC/CDP/egress port is published. No remote listener is created. |
| Owner access | Local browser or authenticated SSH loopback tunnel | Procedure documented. External HTTPS requires reviewed exact `APP_ORIGIN`, trusted proxy/WebSocket configuration and its own acceptance; no public-origin override is provided by the wrapper. |
| Durability | Project-scoped home + control-state named volumes; external credentials | Lifecycle fake asserts retention and unchanged key bytes. Physical Docker volume survival must be checked on the isolated integrated stack. |
| Restart policy | Existing Compose `restart: "no"`; explicit `start` or dev startup | No init/service manager, host-reboot automation or HA failover is installed. |
| Resource sizing | Existing service memory/CPU/PID ceilings retained | Approximately 4.7 GiB total service memory ceilings plus host overhead. A minimum host size, load benchmark and sustained capacity remain unmeasured. |

## Operational evidence

The private-operations work runs [verify-private-install.sh](../../scripts/verify-private-install.sh) with a fail-closed fake Docker executable in a temporary Linux directory. It invokes the actual [private wrapper](../../scripts/private-install.sh), [development startup](../../scripts/dev.sh), [configuration verifier](../../scripts/verify-compose-config.mjs) and [backup shell](../../scripts/backup-compose.sh); image/container/volume results are fixtures. Unknown fake Docker operations fail instead of reaching the real engine. Its evidence is command ordering, selected values, guards and private-file behavior, not desktop or real volume behavior.

The 2026-11-21 WSL run passed **32 private lifecycle command scenarios**, with `realDockerCalls: 0` and `modelRequests: 0`. The independently maintained checks also passed **13 Compose configuration + 11 startup + 21 restore-gate cases**, and **21 synthetic backup/recovery cases with no skips**. The backup suite started a fresh local application, retained history, invalidated an old approval and completed a new synthetic task; its output explicitly says Docker was not exercised and cross-host disaster recovery was not proven. These runs used host Node `v22.22.1` on Linux and do not replace the integrated evidence below.

| Requirement | Executable / evidence | Bound of the claim |
| --- | --- | --- |
| Fresh install | Fake install uses an unused explicit project, project-specific external state, two pinned IDs and offline mode | Real image bytes, container boot, port contention and actual Docker readiness need the parent's fresh integrated stack. |
| Health | Fake tests exercise resolved/running verification and all three health-status reads | A healthy real desktop/browser/provider workflow is a separate integration check. |
| Credential preservation | Fake lifecycle compares owner, runner and model file bytes across install, upgrades, rollback, backup, uninstall and restart | The suite uses a synthetic non-provider secret and asserts it never appears in output. It does not inspect a user's real credentials. |
| Backup before transition | Fake trace requires successful create and separate verify before recreate; creation/verification failure prevents recreation/removal | Backup may already have stopped writers when it fails. Payload correctness is tested independently by [verify-backup.mjs](../../scripts/verify-backup.mjs). |
| Pinned rollback | Mutable fixture release tags are moved; rollback still chooses old saved SHA256 IDs | Works only while those local images and matching deployment configuration exist and the old application can read current data. |
| Partial upgrade | Failed fixture recreate and successful recreate with unhealthy services both leave current unchanged and pending selection retained; start is blocked; explicit rollback recovers | No automatic fallback; current volumes are retained. Power loss at arbitrary filesystem/Docker boundaries is not a transactional migration guarantee. |
| Data-preserving uninstall | Fake verified-backup + `compose down` removes project containers only; both volumes/keys/manifests/images remain; start succeeds | No permanent deletion command is implemented. Real retained-volume data verification remains an integrated acceptance step. |
| Scope/identity refusal | Default project, remote host/context, wrong image architecture, old engine, foreign volume labels and missing local image fixtures fail | Docker-socket administrators remain trusted. These guards do not constrain a malicious host administrator or unrelated direct Docker operations. |
| Filesystem refusal | Symlink state path, broad credential mode, deployment hash drift and operation lock are exercised | State locking coordinates this wrapper; direct dev/Docker commands require operator coordination. |
| Restore safety | Backup helper requires absent target volumes/containers; startup's restored-volume gate checks matching receipts | Private fresh install deliberately refuses restored volumes. Recovery uses the explicit dev-helper handoff and a fresh external credential directory. |
| Historical desktop baseline | [P0 verification log](wsl-p0.md) records noVNC pixels/input handoff, sandbox checks and retained file evidence | Historical single-container evidence does not certify the final split ACP/handoff changes. |
| Provider/model | No live provider call in this private-operations work | Model tool correctness, long tasks, usage settlement and paid-request acceptance remain separate. |
| Second host | Acceptance checklist in the [runbook](private-deployment.md) | Not performed here. WSL configuration inspection is not a second physical machine or remote deployment. |

## Re-run the bounded checks

From Linux/WSL at the repository root:

```bash
bash -n scripts/private-install.sh scripts/verify-private-install.sh
bash scripts/verify-private-install.sh
node scripts/verify-compose-config.mjs --self-test
node scripts/verify-backup.mjs
```

Only the private wrapper fake suite is the task-9 lifecycle evidence. Other checks are independently maintained modules; record their current outputs when integrating. No command in this section intentionally calls a model or mutates a real Compose project. Preserve credential-free summaries with the exact source/image identities used for any actual integrated run.

## Required integrated evidence before broader use

The integrating parent owns a fresh disposable split-stack test, not the active daily project. Record the selected Compose project, both real image IDs, pinned runtime versions, localhost bindings, mount/credential isolation, all service healthchecks, owner login/logout, representative work-file content/hash, takeover/privacy and artifact acceptance results. Then record backup verification, fresh-project recovery, retained-volume restart, candidate upgrade, pinned rollback and failed-health recovery as each actually runs. Mark skipped or blocked items individually.

The four private-operations files do not claim that integrated acceptance has occurred. Public deployment, external HTTPS proxy acceptance, cloud provisioning, sensitive-account use, browser login portability, encrypted backup/key rotation automation, destructive uninstall, schema migration, Arm/native Windows/macOS, resource/uptime SLOs, HA and disaster recovery on a second machine remain outside the established evidence.
