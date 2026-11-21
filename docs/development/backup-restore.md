# 独立备份与干净实例恢复

本流程对应 P2A 的独立备份门槛。备份保存到原数据卷和源码目录之外的私人目录；只有已停用的 control 与 desktop/browser 才能导出。备份是可核对的目录包，不依赖 tar、云服务或付费工具。恢复保留工作文件、控制历史、用量记录、待验收内容和恢复点，以及允许范围内的 Chromium 设置/书签。恢复后需要重新登录；不会继续旧进程、执行旧审批或恢复内存状态。

## 入口与支持范围

- `node scripts/backup.mjs`：Node 22+ 的可导入 ES module/CLI，支持 Windows、Linux/WSL 上的普通本地目录。
- `bash scripts/backup-compose.sh`：本机 Linux/WSL、Unix socket Docker 的停机包装器。使用已有本地镜像，所有 helper 都禁止联网和拉取镜像。它不读取部署凭据，也不启动服务。
- `node scripts/verify-backup.mjs`：仅使用新建临时目录和合成资料的离线恢复证明。它不会读取 `.local`、日常项目、真实资料或 provider。

Compose seam 与 `scripts/dev.sh` 一致：服务键 `computer`（APP_ROLE=control）、`desktop`、`egress`；卷 `${project}_computer-home` 和 `${project}_control-state`。home 卷根对应 `/home/desktop`，其中 `Workspace` 子目录同时挂载到 control 的 `/workspace`；control-state 对应 `/var/lib/private-computer`。恢复文件属主为 UID/GID `1100:1100`。helper 使用 `BOT_IMAGE`（默认 `private-computer:mvp`），control 使用 `BOT_ACP_IMAGE`。不需要修改 Compose manifest 或服务名。

包装器必须显式提供项目名，且拒绝日常默认项目 `private-computer-p0`。以下命令只用于独立合成演练。项目、备份目录、端口与外置凭据目录均需独立，不能并发运行 `up`、`recreate`、其他备份或写卷 helper。

## 先运行安全的本地证明

在仓库根运行：

```sh
node scripts/verify-backup.mjs
```

它创建 `pc-backup-proof-*` 临时目录，建立独立 source、private-backups、fresh-instance，完成核验后删除自己创建的那一个临时目录。覆盖 UTF-8/二进制/空工作文件、历史与用量、artifact blob/恢复记录、可复用目标模板、浏览器设置与书签；使用实际 owner-operations API 证明目录模式和两空卷模式恢复的模板一致，旧 v1 无模板目录或有效空目录也能恢复；在新控制器实例中将旧审批 Run 标为 interrupted，验证已失效的审批不复用，然后用本地合成模型完成新任务。没有真实模型调用、浏览器登录或网络请求。

也可用以下 POSIX 命令核对 CLI。每条源资料都在新临时目录中生成：

```sh
umask 077
proof="$(mktemp -d "${TMPDIR:-/tmp}/pc-backup-manual.XXXXXX")"
mkdir -p "$proof/source/home/Workspace" "$proof/source/home/.config/chromium/Default" \
  "$proof/source/control/runs" "$proof/private-backups" "$proof/instances"
printf '%s\n' 'Synthetic workfile only.' > "$proof/source/home/Workspace/example.txt"
printf '%s\n' '{"version":1,"generation":0,"events":[],"run":null,"works":[]}' > "$proof/source/control/state.json"
printf '%s\n' '{"profile":{"last_used":"Default"}}' > "$proof/source/home/.config/chromium/Local State"
printf '%s\n' '{"browser":{"show_home_button":true}}' > "$proof/source/home/.config/chromium/Default/Preferences"
node scripts/backup.mjs create \
  --home "$proof/source/home" --control "$proof/source/control" \
  --destination "$proof/private-backups/synthetic-v1" --source-version synthetic-manual-v1 \
  --writers-stopped --profile-key-policy external-relogin --private-root-ack
node scripts/backup.mjs verify --backup "$proof/private-backups/synthetic-v1"
node scripts/backup.mjs restore --backup "$proof/private-backups/synthetic-v1" \
  --destination "$proof/instances/clean" \
  --writers-stopped --profile-key-policy external-relogin --private-root-ack
printf 'Synthetic proof files remain for inspection at %s\n' "$proof"
```

Windows 可以运行同一个验证脚本；普通目录 CLI 的源和目标参数也可使用完整 Windows 路径。Windows 的 `--private-root-ack` 表示操作者已把父目录 ACL 限制为当前账户/必要管理员；工具不把 POSIX mode 当作 Windows ACL。Linux 的备份/普通恢复父目录必须预先存在且 mode 为 `700`，新目录 `700`、普通文件 `600`、原可执行文件 `700`。不要在组共享、临时公共目录或符号链接父路径内存放备份。

## 数据范围、密钥与登录

目录包只包含：

- `home/Workspace/**`：全部普通工作文件与子目录。文件内容原样保存，包含用户主动放入的敏感资料时也必须私人保管；工具不会扫描并删改工作文件里的密钥。
- `control/state.json`、`control/runs/**`、`control/artifacts/**`：控制历史、用量、待验收 blob/元数据和恢复点。仅排除当前实现明确生成的原子写入临时文件与旧 restore receipt。未知 control 顶层布局拒绝导出，避免静默遗漏新状态或误纳凭据。
- `control/owner-operations/templates.json`（可选）：仅保存 format=1 的目标模板；每条恰好为 id/name/goal/createdAt，不含旧审批、预算、执行参数或凭据字段。导出与恢复均按应用同一规则校验 UTF-8、最多 100 条、2 MiB 总大小、唯一 UUID/大小写不重复名称、已裁剪名称（1–80 字符，无控制/格式字符）、已裁剪目标（1–4000 字符且最多 16000 字节）和规范 ISO 时间。此目录只允许 templates.json；导出仅跳过应用生成的 `.pending-UUID` 临时文件，未知文件或模板字段会拒绝，恢复 payload 连临时文件也不允许。尚未保存过模板的空目录和旧备份完全没有此目录都受支持。目标正文原样保留，可能含私密内容，不能把模板目标当作凭据保管处。
- `home/.config/chromium/Local State` 和 `Default`/`Profile N` 内的 `Preferences`、`Bookmarks`、`Bookmarks.bak`、`Custom Dictionary`。Local State 仅保留 browser 与 profile 的 last_used/last_active_profiles；Preferences 仅保留 browser、bookmark_bar、homepage、homepage_is_newtabpage、intl、translate、download、printing、webkit、session 设置。

不会包含 Cookies、Login Data、浏览器账号缓存、Sessions、扩展存储、cache、Chromium Singleton/lock 文件、OS keyring、`os_crypt`、home 的 `.ssh` 或外置 owner-password/runner-token/model-key。此版本唯一 key policy 是显式 `external-relogin`：不导出或导入浏览器解密密钥，不提供“复制加密数据库但缺密钥”的隐含承诺。设置/书签里的 URL 与工作/控制资料仍可敏感，所以整个包都必须保密。

部署凭据继续由外部私人凭据目录或安全保管方式负责，不能放回数据卷或备份 payload。恢复时初始化独立目标的 owner/runner 凭据，模型凭据由使用者另行配置；离线演练保持 `MODEL_ENABLED=0`。所有需要登录的网站和浏览器账号由本人重新认证。仓库 revision、安装清单和本地镜像不在 payload 内；另行保留匹配的源码 revision/构建身份、部署声明、镜像 digest 和必要凭据保管记录，依据 manifest 的 source.version 选择兼容应用。

## 目录格式与校验

v1 目录包顶层严格只有 `manifest.json`、`manifest.sha256`、`payload/`。manifest 包含 format=`private-computer-backup`、version=`1`、source revision/project/Node、controlState/browserConfig/ownerTemplates schema=`1`、stopped-writers 一致性起止时刻与 sourceRechecked、key/login policy，以及每项相对路径、类型、私有 mode、文件字节数和 SHA-256。含 owner-operations 目录的包必须声明 ownerTemplates=1；旧 v1 包若没有该目录，可省略该 schema 字段，仍能恢复。manifest.sha256 校验 manifest 的原始字节；payload 每个文件单独核对大小与 SHA-256。

v1 限制为 100000 项、16 MiB 元数据/浏览器 JSON、单文件 2 GiB、总文件 100 GiB。超限、未知包/状态版本、缺少必要根、非法路径、重复及大小写/Unicode 归一化冲突、符号链接/硬链接/设备/FIFO、额外 payload/顶层文件都会拒绝。所有路径在任何目标发布前完整验证；复制时再次核对文件描述符、路径身份及 checksum。校验和用于发现损坏，不能证明一个可被同一攻击者重写 payload 与 manifest 的包可信；只接收受私人保管的备份。

## 一致性与原子规则

1. 先停 control 和 desktop/browser，再读取 profile。CLI 的 `--writers-stopped` 是操作者明确保证，不能用它代替停机。包装器只停止所选项目的 computer/desktop/egress，并在前后拒绝任何仍活动、暂停或重启中的卷使用者。整个维护窗口保持独占，不允许另一会话启动容器。
2. 导出枚举选定源目录，按描述符与路径两次核对稳定身份/时间/大小，在复制后再次检查所有选定源；变化即中止。源卷以只读方式挂给 helper。此方法要求停写，不是活动数据库或 live profile 的快照。
3. 备份和普通目录恢复只写同父目录的唯一 `.NAME.pending-UUID` 暂存目录，以 `.NAME.lock` 排除本工具的同名并发；文件先 fsync，目录在支持的平台 fsync，成功校验后 rename 发布。已有目的地一律拒绝，绝不合并覆盖。私有父目录与独占维护是前提，不能防御同账户恶意改目录的对手。Windows/部分文件系统不支持目录 fsync，不能据此承诺掉电持久性。
4. 常规错误（含复制/空间不足）不发布暂存目录，并清理本操作自己的暂存与锁；源资料和已有目标不删改。掉电/强杀可能残留 `.pending-*`/`.lock`，不得视为备份成功；先确认没有活动操作，再核对确切路径、保留完好的正式包，人工清理残留后用新名字重试。目录清理失败也应按失败处理。
5. Docker 两个卷的 mount root 不能跨卷 rename，**不承诺两卷一起原子提交**。只能向全新、空、未使用卷复制，全部校验成功后才向两个根写相同 `.restore-complete.json`。receipt 包含 format=`private-computer-volume-restore`、version=`1`、transaction UUID、manifestSha256、completedAt、authentication=`relogin-required`、resumedOperations=`false`。两个卷的 `org.private-computer.restore` operation label 相同，receipt 的 transaction/hash 也必须相同；operation label 不等于 receipt UUID。
6. restore helper 失败后不自动删除任何卷、不启动服务。缺失/不匹配 receipt 的新卷按不完整恢复隔离，不能进入 up/serve/recreate。只能在核对准确的新项目/卷名后人工处理，或使用另一个全新项目重新恢复。`scripts/dev.sh` 的所有启动路径为带 restore label 的卷执行门槛：两个 label 必须存在且相同；通过无网络、只读、UID 1100 的 helper 读取两个小于等于 4096 字节的普通 receipt，要求字节一致、v1 格式、UUIDv4 transaction、64 位小写十六进制 manifestSha256、规范 ISO 时间、relogin-required 和 resumedOperations=false。正常无标记项目只查询卷元数据；私人部署也经由此启动入口。直接绕过脚本运行 Compose 的操作者必须自己遵守同一门槛。

控制器启动按应用规则把旧非终态 Run 标为 interrupted、撤销旧审批并将未完成的用量标为 unknown；不会自动重放外部效果。已有历史/恢复点保留不等于旧授权可继续使用。跨版本 schema 迁移须由匹配应用显式完成，工具不会猜测迁移或降级。

## 独立 Compose 演练的精确调用

此段依赖本机 Docker 可访问、已有本地 BOT_IMAGE/BOT_ACP_IMAGE。不要把下面的测试名字替换成日常项目，不要调用默认项目，不要执行带 `-v` 的 down 或无选择的 prune。开发启动或浏览器操作都在另一个集成验收中完成；这里给出安全停机导出、只读验证、干净卷恢复的接口。

```sh
# 确认 pc-backup-test-source 仅承载人工合成资料，且镜像已经本地构建。
umask 077
exercise="$(mktemp -d "${TMPDIR:-/tmp}/pc-backup-compose.XXXXXX")"
mkdir -m 700 "$exercise/private-backups"
export BOT_IMAGE=private-computer:mvp
export BOT_ACP_IMAGE=private-computer:acp
# 所选测试项目须已通过 COMPOSE_PROJECT_NAME=pc-backup-test-source 建立，不能并发启动。
bash scripts/backup-compose.sh create \
  --project pc-backup-test-source --backup-root "$exercise/private-backups" \
  --name synthetic-v1 --source-version synthetic-compose-v1 --image "$BOT_IMAGE"
bash scripts/backup-compose.sh verify \
  --project pc-backup-test-source --backup-root "$exercise/private-backups" \
  --name synthetic-v1 --image "$BOT_IMAGE"
# pc-backup-test-restored 必须无任何容器且两个命名卷均不存在。
bash scripts/backup-compose.sh restore \
  --project pc-backup-test-restored --backup-root "$exercise/private-backups" \
  --name synthetic-v1 --image "$BOT_IMAGE"
```

create 会停止选定测试项目并保持停止。restore 在核验整个包之前不建卷；新卷必须带同一 operation label，再执行空卷复制，容器始终不启动。备份 root 必须 mode 700、在源码目录和两个源卷之外且路径无符号链接；只允许本机 Unix socket，远程 context/host 会拒绝。外置备份和普通恢复目标不能相等或互为祖先。命令成功时输出可记录的 manifestSha256、项目/卷与 receipt；不要把私密内容打印进公共日志。

在 receipt 验证通过后，可由集成负责人以 `COMPOSE_PROJECT_NAME=pc-backup-test-restored`、独立 `BOT_SECRET_DIR`、独立 `BOT_PORT`、`MODEL_ENABLED=0` 和相同本地镜像启动。必须再次确认卷标记门槛和新建外置凭据；检查历史、用量、工作文件与必要浏览器配置，然后在新实例执行一次合成任务并手动确认需重新登录。此启动/浏览器验证不是 backup-compose.sh 的隐式步骤。

模块导入接口为 `createBackup(options)`、`verifyBackup({backup})`、`restoreBackup(options)`、`restoreVolumes(options)`；均返回 Promise。create 需要 home、control、destination、sourceVersion；restore 需要 backup、destination；restoreVolumes 需要 backup、两个空 home/control，Linux 可传 uid/gid。所有写操作都要求 writersStopped=true、profileKeyPolicy='external-relogin'、privateRootAck=true。verify 返回 manifest/root/hash，CLI 只输出摘要。CLI 验证/运行失败 exit 1；包装器参数与选择 guard exit 2、验证/运行失败 exit 1；成功 exit 0。所有调用必须提供路径，无隐含默认资料目录。

## 当前证据与剩余验收

2026-11-21 的本地合成证明（含 P2B 模板）：Windows Node v24.22.3 通过 25 项，符号链接（需额外 Windows 权限）及 POSIX mode 两项明确跳过；WSL Ubuntu Node v22.22.1 通过全部 27 项。两次各生成 24 个 manifest entry、2035 字节选定 payload；动态时间造成 hash 不同。实际 owner-operations API 保存的模板在目录模式与两空卷模式恢复后均能由新实例读回，临时文件与工作记录中的审批/凭据/预算字段不进入模板；旧 v1 无模板目录和有效空模板目录均能恢复。17 组非法模板（format、额外根/条目字段、UUID、名称、目标、时间、重复 id/名称、数量、UTF-8/JSON、大小）在源导出与重新计算 checksum 的恢复路径均拒绝；额外 owner-password、pending 和未知临时文件即使写进 manifest 也会拒绝。证明还包含损坏 payload/hash、重新计算校验和后的不支持版本/schema、路径穿越/Windows ADS/设备名、重复大小写路径、额外文件、浏览器密钥、链接、源并发变化及已有目标拒绝；拒绝时没有发布目标。WSL 验证了符号链接与 mode 700 门槛。实际新 controller 使用本地合成模型得到 succeeded、7 tokens，并保留既有 20-token 历史，旧 awaiting_approval 变 interrupted/usage unknown。

当前备份代理没有访问 Docker daemon 的权限（普通 WSL 调用得到 `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`），所以没有声称实际 Compose 卷复制、容器内 profile 启动、真实浏览器重新登录、第二台机器、磁盘耗尽或掉电故障注入已验收。Compose wrapper 已做 Bash 语法检查；两空目录的 volume 模式及 completion receipt 已由本地证明覆盖，不能替代真实卷/浏览器演练。集成负责人应在专用 synthetic project 补充：实际服务停机与无活动 writer；新卷 receipt 与 UID/GID；新 control/desktop/browser 启动及新任务；破坏副本后的恢复拒绝；ENOSPC/强杀时无成功发布且启动门槛拒绝不完整卷。跨主机灾备仍需第二台干净机器独立验证后才可承诺。
