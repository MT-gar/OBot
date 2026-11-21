# WSL P0 开发与验收记录

日期：2026-11-19，Asia/Shanghai。本文记录本地纵向原型，不表示已完成完整 MVP、服务器部署或生产安全认证。

> 2026-11-21 状态提示。下文记录 P0 的单容器、Node 22、18 项测试和无模型演示。新版分离环境已有固定演示记录，ACP 目前有宿主文本和用量证据。默认启动路径、连续运行、真实工具任务和分离环境验收按 P1A 推进。新版验收以当前路线为准。[开发路线](../development-roadmap.md)

## 环境与实现范围

- 开发发行版：本机 Ubuntu，WSL2，x86_64，Ubuntu 26.04 LTS；WSL 可用内存约 7.6 GiB。
- 在此发行版安装 Docker Engine 29.1.3、Compose 2.40.3、Linux 原生 Node.js 22.22.1。未依赖 Windows 的 Node/npm 运行后端。
- 参考镜像：Node 22 + Debian bookworm，安装 Xvfb、Openbox、Chromium、x11vnc、websockify、noVNC 和中文字体。容器内应用以 desktop 普通用户运行。
- P0 前端是无构建依赖的 HTML/CSS/ES modules；后端使用 Node 内置模块。先验证桌面和控制语义，MVP 再评估 TypeScript/React 的正式工程化；原型没有宣称已采用路线中的全部建议技术。
- 无模型接入、无任意命令执行接口、无云资源创建。自动化仅访问本地固定测试页面，并生成一个 Markdown 报告。

## 源码入口

- 网页：`apps/web/`。
- 控制程序：`apps/control/src/server.mjs`。
- 控制权、任务状态与持久记录：`apps/control/src/controller.mjs`。
- 固定 CDP 操作与真实桌面指令：`apps/control/src/runtime.mjs`。
- 工作文件路径/大小/符号链接检查：`apps/control/src/workspace.mjs`。
- 桌面镜像与启动：`runtime/desktop/`。
- 本地 Compose：`deploy/compose/compose.yaml`。
- 开发命令：`scripts/dev.sh`；语法检查：`scripts/check.mjs`。
- 真实桌面验证：`scripts/verify-runtime.mjs`；真实浏览器界面验证：`scripts/verify-browser.mjs`。

## 在本机启动

在 PowerShell 中运行并保持终端开启：

```powershell
wsl -d Ubuntu -u root -- bash /mnt/d/文件/项目/Bot/scripts/dev.sh serve
```

浏览器访问 `http://localhost:3180`。在另一个终端运行下面的命令查看本地密码；不要将密码粘贴到 issue、日志或仓库：

```powershell
wsl -d Ubuntu -u root -- bash /mnt/d/文件/项目/Bot/scripts/dev.sh password
```

`serve` 是前台开发会话；它适合 WSL 的启动/退出生命周期。Linux 服务器可使用 `up` 后台运行，但仍需单独的服务管理、TLS/私网入口、备份和监控配置。

默认只发布 `127.0.0.1:3180`。VNC 5900、WebSocket bridge 6081、浏览器 CDP 9222 均仅在容器内部使用，没有直接发布到宿主或公网。

## 构建与网络差异

当前环境无法直接从 Docker Hub 下载，使用 Node Docker Official Image 在 AWS ECR 的官方发布位置。默认 Debian CDN 在本机下载很慢，本次通过可配置的 HTTPS Debian 镜像构建；APT 保留 Debian Release/keyring 签名验证，没有关闭 TLS 或包验证。

```bash
sudo env DOCKER_BUILDKIT=0 \
  BOT_BASE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim \
  BOT_APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn \
  bash scripts/dev.sh build
```

本次获取的 ECR 基础镜像 digest：`sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`。公开发行前，应将经过验收的 digest 与软件包版本固定在发布清单中。

一次下载需要临时为 ECR 的 CloudFront 节点补充正确解析；工作区没有写入该临时地址，检查时 `/etc/hosts` 已无临时标记。项目不会自动更改系统 DNS/代理。另一台机器应按自身网络配置镜像来源，不能复制短 TTL 的临时 CDN 地址。

## 持久化与恢复的边界

Docker named volume：`private-computer-p0_computer-home`。

- 工作文件：`/home/desktop/Workspace`。
- 任务与运行记录：`/home/desktop/.private-computer`。
- 浏览器配置：`/home/desktop/.config/chromium`。
- 随机 owner 密码：位于启动用户的 Linux 状态目录，默认 `$HOME/.local/state/private-computer-p0/owner-password`；本机以 root 初始化，因此需沿用同一用户或显式指定同一 `BOT_SECRET_DIR`。

容器重建后继续挂同一卷；系统软件来自镜像，不依赖容器可写层。启动脚本在取得 profile 的 `flock` 互斥锁后，只移除三个陈旧的 Chromium singleton 符号链接，解决新容器主机名/PID 与旧 profile 锁冲突。它不删除浏览历史或用户文件，也不会删除意外出现的同名普通文件。

持久卷保留与独立备份是两回事。当前尚未提供完整加密备份、跨机恢复和版本回退工具；它们属于后续 MVP/beta 的验收。

## 验收方式

源码检查：

```bash
bash scripts/dev.sh test
```

控制程序的 18 项测试已在本机 Ubuntu 原生 Node 22 跑通，覆盖鉴权、Origin/Host、过期会话、请求限额、文件往返/逃逸/符号链接、任务中断恢复、控制权取消、SSE 和 WebSocket 二进制代理。

真实运行时验收会操作测试桌面，不应与手动操作同时执行：

```bash
sudo docker exec --user desktop private-computer-p0-computer-1 node scripts/verify-runtime.mjs
sudo bash scripts/dev.sh recreate
sudo docker exec --user desktop private-computer-p0-computer-1 node scripts/verify-runtime.mjs --check-persistence
sudo docker exec --user desktop private-computer-p0-computer-1 node scripts/verify-browser.mjs
```

运行时脚本使用真实 HTTP/WS、桌面 PNG、同一有界面 Chromium 和工作区文件；额外使用真实 apt noVNC 客户端，在同一条未重连的连接上测试“人工可输入 → 自动化时拒绝输入 → 接管后恢复输入”，并在每次尝试前强制客户端 `viewOnly=false`，排除只靠前端禁用输入的假通过。早期自写 RFB 探针未通过兼容验证，已改用产品实际使用的客户端，不把那个探针的失败直接归因为产品缺陷。

界面脚本使用另一个临时 headless profile，用于登录、等待实际 framebuffer 像素、从网页运行固定演示、桌面/窄屏布局和注销测试；它不冒充任务实际操作的持久浏览器。

验收脚本输出不含密码/cookie。截图只包含本地固定测试页面与测试文件；本地证据保存在忽略版本控制的 `.local/evidence/`，容器内界面截图位于 `/home/desktop/.private-computer/p0-ui.png`。

## 本次严格验收结果

本机最终镜像执行 `scripts/verify-local.sh` 返回 exit 0，具体证据位于 `.local/evidence/`：

- 源码语法检查通过；控制程序测试 18/18 通过。
- `runtime.json`：8/8 真实检查通过，包括 sandboxEnabled=true、实际 PNG、41 个 noVNC 模块、真实表单提交和报告。
- 同一真实 noVNC 连接的 connectionEvents=1、disconnectEvents=0；客户端强制 viewOnly=false 后，人工输入生效、自动化期间被后端阻止、接管后恢复；取消后未继续完成后续步骤。
- `persistence.json`：重建后重新登录与文件保留 2/2 通过；原有 44-byte marker 下载一致，验证过程未重写该文件。
- `browser.json`：真实浏览器登录、实际帧像素、网页按钮启动固定演示、桌面/390px 窄屏布局、注销全部通过。1440×1000 测试中 canvas 为 1280×800、缩放后底边约 910.9px，未超出视口；采样得到 23 种颜色，排除仅连接成功但尚未出图。
- `resource-snapshot.json`：单次验收结束快照约 291.6 MiB / 3 GiB 内存、0.39% CPU、166 PIDs。这是本机瞬时数据，不是负载基准或云端配置保证。

尚未完成路线中持续工作负载的 30 分钟性能实验、Arm/真实云实例认证和灾备演练；本次完成的是 P0 可运行纵向闭环。

## 安全与支持状态

- Compose 使用 namespace-aware seccomp 配置以保留 Chromium 沙箱；没有使用 privileged 或增加 SYS_ADMIN。
- 检查 renderer 的 NoNewPrivs、Seccomp 与过滤层数，同时扫描禁用沙箱参数。Chromium 在 Linux 可能重写进程标题，因此需按完整 cmdline 识别 renderer。
- 健康检查同时验证控制入口、VNC、WebSocket bridge 与 Chromium CDP；单纯 HTTP liveness 不再代表桌面已就绪。
- 单容器里仍共享同一所有者的信任环境，不承诺控制面/工作区隔离或不可信公众多租户安全。
- 当前是 amd64 本地验证，Arm、Oracle 实例、跨地域网络、音视频、敏感账号、长期压力测试和完整灾备均未认证。

## 后续远程部署

先完成[开发路线](../development-roadmap.md)中的 MVP 退出条件，再选择服务器地区/架构/规格，配置 SSH 公钥、私网或域名/TLS、凭据注入、独立数据备份和预算。服务器沿用相同镜像与卷约定，但不直接把 P0 的单容器信任模型和本地 HTTP 入口搬到公网。
