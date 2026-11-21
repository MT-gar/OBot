# 私人云电脑

让人和 AI 在同一台持久云电脑上协作，先在本地 Linux / WSL 验证，再部署到服务器。

当前处于 **P1A 基础 MVP 收口**。P0 固定桌面演示和宿主 DSH ACP 的 `gpt-6.1-sol` / `max` 文本与用量已有实机记录。默认应用入口还需接通 ACP，随后验收真实工具任务与分离环境。WSL Node 24.22.3 复跑通过 59 项测试和 29 项语法检查。其他复跑发现连续启动任务时可能出现 409，需在真实文件任务验收前修复。固定演示不调用模型。真实模型任务会产生供应商用量。

开发顺序按差异化目标推进。基础 MVP 收口后，依次完成双向交接与私人操作、文件验收和恢复、有限授权与日常使用、私人部署。[差异化构思](差异化.md) · [开发路线](docs/development-roadmap.md)

## 在本机 Ubuntu WSL2 中运行

本仓库位于 Windows `D:\文件\项目\Bot`，对应 WSL `/mnt/d/文件/项目/Bot`。本次已在 Ubuntu 安装原生 Node.js 22、Docker Engine 和 Compose；应用依赖放在 Linux 镜像中，不依赖 Windows 的 Node/npm。

在 PowerShell 启动并保持这个终端打开：

```powershell
wsl -d Ubuntu -u root -- bash /mnt/d/文件/项目/Bot/scripts/dev.sh serve
```

浏览器打开 `http://localhost:3180`。另开一个终端取得本地访问密码：

```powershell
wsl -d Ubuntu -u root -- bash /mnt/d/文件/项目/Bot/scripts/dev.sh password
```

密码在 Linux 用户状态目录中，未写入仓库或镜像。当前用 root 调用 Docker；控制程序、桌面 runner/浏览器按分离角色运行。WSL 使用前台 `serve` 保持开发会话；服务器入口、运维和远程部署尚未认证。

下面的命令构建/启动现有基础 MVP 配置，**不会自动切换到已在宿主验证的 ACP 运行时**。ACP 独立运行时采用 Node 24.22.3 / DSH 0.2.2-rc.3；默认 Compose 与构建路径的对齐是路线中的下一项 A1，不能把基础镜像的 Node 22 当作 ACP 已满足运行条件。

## 常用开发命令

以下在 WSL/Linux 的仓库根目录执行，并使用与初始化相同的用户或相同 `BOT_SECRET_DIR`：

```bash
# 检查源代码语法与控制程序测试
bash scripts/dev.sh test

# 首次建立随机访问密码；重复执行不会重置已有密码
sudo bash scripts/dev.sh init

# 构建；支持现代 Docker BuildKit，当前环境也验证了 legacy builder
sudo env DOCKER_BUILDKIT=0 bash scripts/dev.sh build

# 前台启动；Ctrl+C 停止，不删除数据卷
sudo bash scripts/dev.sh serve

# 服务器/持续运行的 Linux 环境可后台启动
sudo bash scripts/dev.sh up

# 停止、状态、日志、用同一数据卷重新创建运行环境
sudo bash scripts/dev.sh stop
sudo bash scripts/dev.sh status
sudo bash scripts/dev.sh logs
sudo bash scripts/dev.sh recreate
```

下载受限时可显式选择 Node Docker Official Image 的 ECR 发布位置和 HTTPS Debian 镜像；软件包仍由 Debian keyring 验证签名：

```bash
sudo env DOCKER_BUILDKIT=0 \
  BOT_BASE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim \
  BOT_APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn \
  bash scripts/dev.sh build
```

这些配置不会自动修改整机代理或 DNS。不同网络下的可达性不作保证；不要为了下载关闭 TLS 或 APT 签名检查。

## 验收与数据

原 P0 的真实桌面、接管、文件保留和浏览器布局验收见[P0 历史记录](docs/development/wsl-p0.md)。[旧的一键验收脚本](scripts/verify-local.sh)仍假设在 `computer` 容器里执行桌面检查，需要适配当前分角色布局；它不是当前 ACP MVP 的完整验收入口。

基础回归使用上面的 `test` 命令，当前 ACP 开发以 WSL/Linux Node 24 为基线。真实 ACP 文件和桌面任务、取消/接管、分离状态恢复和隔离按 A1–A5 验收。[开发路线](docs/development-roadmap.md) · [开发机证据](.local/evidence/)

当前 [Compose](deploy/compose/compose.yaml)中，桌面主目录位于 named volume `private-computer-p0_computer-home`，工作文件在桌面 `/home/desktop/Workspace`，同一工作目录挂入 control 的 `/workspace`；浏览器配置位于桌面 `/home/desktop/.config/chromium`。控制状态及任务记录使用独立 `control-state` 卷，挂入 control 的 `/var/lib/private-computer`。`stop`、`down` 和 `recreate` 保留命名卷；删除卷会删除相应资料。卷保留不是独立备份，也不证明跨机灾备。

系统软件由镜像重建。临时在容器可写层安装的软件，不会因主目录持久化而自动保留。浏览器目录通过启动锁互斥，并只在取得锁后清理三个旧 singleton 符号链接，处理容器重建后的陈旧 PID/主机名锁。

## 使用范围与下一阶段

- 端口只绑定 Windows/主机 `127.0.0.1:3180`；原始 VNC、CDP 和桌面代理端口不映射公网。
- 默认保留 Chromium 沙箱；使用 Playwright 的 namespace-aware seccomp profile，详情见[第三方运行时清单](runtime/desktop/THIRD_PARTY.md)。界面的沙箱状态来自实际进程检查，不代表完整多租户安全认证。
- control、desktop、egress 已分为独立服务；当前仍是同一所有者的开发原型，分离配置不能代替真实隔离验收或多租户认证。私人模式尚未实现，不应据此交付敏感账号操作。
- `ALLOW_UNSANDBOXED_BROWSER=1` 仅是显式测试开关，默认关闭；生产配置不能依赖它。
- 下一项是对齐 ACP 启动路径并验证真实工具闭环，随后开发双向交接、私人操作和文件验收/恢复；服务器凭据、TLS/私网入口、目标架构和费用在 P3 部署阶段另行确认。

资料：[完整路线](docs/development-roadmap.md) · [桌面技术研究](docs/research/grokbot-and-desktop-stack.md) · [Oracle Cloud 研究](docs/research/oracle-cloud-feasibility.md)
