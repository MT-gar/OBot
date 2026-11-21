# Grok Bot 对标与私人云桌面技术研究

核查日期：2026-11-19（Asia/Shanghai）  
方法：优先读取官方文档和官方源码；未成功取得正文的内容单独标记，不把搜索摘要当成完整验证。没有运行性能测试，也没有构建镜像或审核依赖树。

## 1. 对标的范围与证据强度

本次可成功读取 [xAI 官方文档索引 llms.txt](https://docs.x.ai/llms.txt)，其中列出 Grok Bot 的计算机、技能/例程、审批、文件、Team Bots、身份和电脑管理文档。它证明官方产品文档覆盖这些主题，但仅有目录不能证明全部实现细节。

[Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) 的官方搜索索引摘要明确描述：Bots 使用带有浏览器、命令行和文件系统的持久云电脑；同一账号下的 Bots 共享电脑，文件、登录与浏览器会话跨任务保留。此页与 How Grok Bot works 的 HTML/Markdown 正文抓取在本轮多次超时或连接失败；本段仅按官方索引摘要记录。每 Bot 的具体屏幕语义、内部隔离方式、任务调度实现及其安全保证，本轮没有足够正文证据，不据此设计兼容承诺。

设计推论：本项目需要“持久计算环境 + 任务执行 + 人工接管”，而不只是聊天网页。产品公开的功能不等于实现架构公开；本项目采用自己的数据模型和安全设计。

相关官方入口（正文未完整核验）：

- [How Grok Bot works](https://docs.x.ai/grok-bot/how-grok-bot-works)
- [Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)

以上链接访问/尝试日期均为 2026-11-19。

## 2. 远程桌面路线

### noVNC + websockify：MVP 首选候选

已读取 [noVNC 官方 README](https://raw.githubusercontent.com/novnc/noVNC/master/README.md)：noVNC 提供浏览器 VNC 客户端和可嵌入的 JavaScript 库，要求后端提供 WebSocket；普通 VNC TCP 连接可以经 websockify 桥接。README 也列出缩放、调整桌面大小、剪贴板和触控支持。它不是桌面操作系统、计算资源调度器或完整的用户身份平台。

许可证核查：README 声明 noVNC 主要为 MPL-2.0，具体例外需要进一步读分发版本的 LICENSE 和第三方文件。本轮直接取 LICENSE.txt 失败，所以这里只确认 README 的声明。[websockify 官方 setup.py](https://raw.githubusercontent.com/novnc/websockify/master/setup.py) 可成功读取，声明许可证 LGPLv3；分发前仍需核对对应版本的实际许可证和修改内容。

建议：在 P0 验证 Linux 桌面 + VNC server + websockify + noVNC 的最短路径。将会话鉴权、控制权和文件权限放在平台与 runner 中，不以 VNC 密码替代平台身份验证。正式发布锁定版本和 digest，不跟随 master。

架构约束：noVNC 的网页客户端不代表服务端镜像自动支持 Arm。VNC server、Linux 发行版、浏览器、runner 和所有原生依赖需一起实测。它适合做办公/浏览器操作的初始验证；帧率、画质和成本要实测，不从协议名称推导性能。

### Apache Guacamole：需要协议网关时评估

已读取 [Guacamole 官方首页](https://guacamole.apache.org/) 和 [开源说明](https://guacamole.apache.org/open-source/)：它是可在浏览器访问的远程桌面网关，支持 VNC、RDP 和 SSH，项目采用 Apache License 2.0，并提供嵌入与开发文档。

设计建议：当产品需要统一访问既有 Linux/Windows/RDP/SSH 机器时，它值得作为候选；仅为一个 Linux 桌面做 MVP 时，先比较它增加的部署和集成成本。使用网关不会自动解决 guest 内的 AI 工具、持久化、恢复和不可信租户隔离。

Arm 支持与实际容器构建：本轮未审核当前发布镜像 manifest，因此不声明现成镜像的 arm64 支持。支持某协议也不代表自动解决被控 Windows 的许可。

### Selkies：后续音视频/交互性能候选

已读取 [官方 Web Client 文档](https://docs.selkies.io/latest/components/web-client/)：客户端能用 WebCodecs/WebSocket，也能使用 WebRTC 媒体路径，并带有输入、剪贴板、文件、麦克风/摄像头等能力。不要将 Selkies 描述为“只有 WebRTC”的实现。

已读取 [官方 Usage](https://docs.selkies.io/latest/usage/) 的控制和共享说明：其服务器对只读角色输入执行检查；同一会话也支持多个有输入权的页面。设计推论：接入现成客户端后，本项目仍要明确自己的单一控制租约，不能假设远程桌面库会自动实现人与 AI 的互斥。

已读取 [官方 Licensing](https://docs.selkies.io/latest/licensing/)：Selkies 自身为 MPL-2.0；默认发行依赖可能包含 GPL 编码库，容器也包含各自许可的软件。不能把主项目许可证套用到整个镜像。具体分发构建需要按官方清单和自己的 SBOM 核对。

建议：P0 可以做一个小规模横向试验，但只有在 noVNC 路径不能达到实际音视频/交互要求时，才把替换列入主线。评价软件编码、硬件编码、内存、码率、网络受限重连和客户端兼容性。WebRTC 另测 ICE/TURN、防火墙与中继流量；WebSocket 路径也需要 TLS 和身份检查。

架构与性能限制：本轮未运行 Arm 或 GPU 版本，不保证可直接运行或达到官方展示帧率。测量应注明 CPU/GPU、驱动、编码、分辨率和网络条件。

### Kasm：区分 Workspaces 与开源子项目

已读取 [Kasm Workspaces On-Premises Software License Agreement](https://trust.kasmweb.com/eula)（页面注明 2026-11-05 更新）：Workspaces 的商业软件部分受订阅、使用范围和分发限制约束；协议也区分随附的独立开源代码。

结论：不能因为 Kasm 有 Community Edition 或开源镜像，就把整个 Workspaces 当作可任意再分发的开源平台。KasmVNC、workspace images、部署工具和 Workspaces 的许可要分别判断。KasmVNC 的具体源码许可及当前架构支持本轮未完整核查，保留为后续候选，不在本项目发行中默认打包。

## 3. 人与 AI 使用同一电脑时，项目要自己解决什么

以下是本项目的设计建议，不是对 Grok Bot 内部实现的陈述。

### 同一浏览器与持久状态

先启动一个有界面、专门用户目录的 Chromium，再让自动化连接此实例；确认人工看到的 tab、文件和自动化对象一致。不要让 AI 另启一个 headless 浏览器后宣称在操作用户正在看的电脑。

同一 profile 一次只由一个浏览器进程使用；不同 Bot 需要真正独立登录状态时分配不同 profile，跨租户则分配独立计算环境。浏览器 cookie、系统 keyring 与会话数据有迁移约束，恢复验收允许用户重新认证，不承诺复制文件后所有第三方登录永久有效。

GUI 输入绑定截图版本、画面尺寸与 control generation。人工接管后服务端撤销旧授权，runner 丢弃待执行输入；恢复 AI 前重新观察。界面按钮或前端禁用不足以构成互斥。

### 能力与权限

结构化浏览器动作优先用于可定位页面，GUI 动作用于普通应用和结构化访问不可用的场景，命令行用于受限本地任务。三条路径共用策略、任务状态、取消和审计。

允许任意 shell 和任意已登录网页点击后，无法仅靠识别工具名拦住全部高风险外部行为。MVP 使用公开资料、测试账号和受限工作区；高信任模式明确说明风险。需要强制控制外部写入时，使用工作区以外的 capability/connector，并实际约束绕行路径。

### 单机 Compose 与隔离

单机 Compose 适合验证同一所有者的桌面、网页和 runner 运维。容器和进程权限用于缩小事故影响；本项目不把这种布置宣传为已验证的不可信公众多租户隔离。

不同安全主体采用独立 VM 或经过专门审查的运行环境；guest 无云管理凭据、Docker socket、宿主敏感目录或 metadata 网络访问。控制端与 guest 分开授权，凭据按用途最小化。

这是规划的威胁模型和发布前提，本轮没有运行容器逃逸测试或证明某种隔离技术的绝对安全性。

## 4. P0 对比试验与采用门槛

1. 基准：固定 Linux 版本、桌面、Chromium 版本、客户端浏览器、服务器地区和网络。
2. 手动桌面：打开 5 个测试 tab、滚动公开网页、输入中文、调整分辨率、上传下载文件；连续测试 30 分钟。
3. 资源：记录 CPU、峰值 RSS/内存、桌面平均/峰值码率、输入反馈、断线恢复与磁盘增长。
4. AI：执行“公开网页 → 本地文件”，切换 GUI/浏览器/命令行路径，并在中途人工接管。
5. 持久化：网页关闭、桌面运行环境重建、整机重启、恢复至新机各测一次。
6. 架构：amd64 与 arm64 分开记录；当前没有实机证据的组合列未认证。
7. 采用：先保留满足需求且最简单的链路；只有测试显示缺口时，切换或增加 Selkies/Guacamole。

## 5. 开源分发前的实际检查清单

- 按锁定版本收集 noVNC、websockify、VNC server、Linux 发行包、浏览器、编码器、字体、网页依赖与 runner 的许可证。
- 区分仅依赖原包、修改源码、链接原生库、打包容器和提供托管的不同情形；按实际分发方式处理授权。
- 保存第三方 NOTICE、许可文件、必要的源码/修改信息与 SBOM；本文件不能替代实际版本的许可清单。
- 自写代码可另选 Apache-2.0 等许可证；这一选择不改变第三方文件的许可，也不自动授予品牌、编解码专利或商业应用分发权。
- 产品名称、标识、说明和示例使用自己的内容；对标 Grok Bot 的公开体验，不复制其品牌素材或声称使用其未公开内部实现。

## 6. 可依赖的结论与仍待验证的项目

可依赖的一手资料结论：noVNC 是可嵌入浏览器 VNC 客户端；websockify 有独立 LGPLv3 声明；Guacamole 支持 VNC/RDP/SSH 且项目采用 Apache-2.0；Selkies 包含 WebSocket/WebCodecs 和 WebRTC 两条路径且分发依赖许可混合；Kasm Workspaces 与其独立开源子项目需要分开审查。对应出处已在各节紧邻列出。

待实测/待核查：具体版本镜像的 Arm manifest 与运行效果；桌面编码性能；Playwright 与用户浏览器共享实例的限制；高风险操作绕行防护；完整依赖许可与编解码许可；Grok Bot 正文中的详细屏幕和隔离语义。

项目阶段、MVP 任务与验收以 [开发路线](../development-roadmap.md) 为入口。本研究不代表已经完成任何软件实现、云部署、性能认证或完整法律审查。
