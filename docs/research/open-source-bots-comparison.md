# 开源 AI Bot / Agent 对照（2026-11-21）

范围：按官方 GitHub README 与项目文档核对代表性项目；“开源 Bot”并非同一类产品，以下按侧重点比较，不做功能排行榜。浏览仓库内容于 2026-11-21。

## 本项目当前定位

当前仓库的目标是“私人云电脑”：一个单用户、可持续保留的 Linux 桌面/浏览器和工作区，加网页控制入口、人机接管与任务自动化。现有实现包含本机 Linux/WSL 的桌面、浏览器和文件闭环；任务对文件或桌面等变更动作需逐项审批，并有接管/取消控制。它首先是一个自托管的持久计算环境和控制面，不只是浏览器自动化库。

开发状态需要分层说明：P0 的本地纵向原型有完整验收记录；Responses 模型集成及 DSH ACP 执行器代码已进入工作区。2026-11-21 现场检查时，语法检查通过；完整测试串行运行 44/44 通过。但 ACP 真实适配器证据仍是 `ok:false / usage_unknown`，未证明真实模型任务成功。旧的本地 MVP 容器仍健康，但比最近的 ACP 执行器代码更早构建；健康检查不能代表新代码已部署。仓库当前无提交，源码和文档仍显示为未跟踪，因此无法按提交历史判断近期演进。

项目自身记录：[README](../../README.md)、[P0 验收记录](../development/wsl-p0.md)、[MVP 实施合同](../development/mvp-contract.md)。本项目定位/进度摘自仓库现有文档、源码、测试与本地 `.local/evidence/` 检查，不是第三方核验。

## 代表性项目

| 项目 | 官方项目材料所描述的重点 | 与私人云电脑的关系 |
|---|---|---|
| [Agent Zero](https://github.com/agent0ai/agent-zero) | 完整 Linux workspace、终端/浏览器/桌面应用、可接管桌面；容器化安装和持久 workspace；提供 Projects、skills、plugins、MCP、多个 Agent 协作、快照等。README 建议放在 Docker/其他隔离环境，并提示审查敏感操作、做好备份。 | **最接近的同类对照。**它已经把“Agent + 完整 Linux 桌面”做成更丰富的通用 Agent 产品。本项目相对聚焦单个 owner 的持久云电脑、网页会话、严格工具边界、精确审批和控制权 lease；但这些工程优势尚未等同于更成熟或更安全，当前也缺它的插件、项目管理、多 Agent 和应用协作广度。 |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | 官方仓库将其定位为自动化软件工程师/开发 Agent；Python 后端、React 前端与独立 runtime。仓库配置模板也列出浏览器开关和任务预算选项。 | 主要比较维度是**开发任务/代码代理**，不是“长期保有一台个人云电脑”。若核心目标是修仓库、写代码、跑工程任务，它更直接；本项目更强调远程桌面本身、持久个人工作环境和随时接管。 |
| [browser-use](https://github.com/browser-use/browser-use) | 浏览器 Agent 工具/库：模型在持续 REPL 中写 Python，经 Browser Harness/CDP 操作浏览器；可用本地或云浏览器，提供自定义工具、文件 workspace 等。官方迁移说明指出其运行代码是在当前用户权限下，不是 sandbox，建议不可信任务使用容器/VM。 | **浏览器层而非完整电脑产品。**可作为本项目浏览器自动化能力的参考/候选组件，但它本身不替代登录网页、持久桌面卷、桌面控制权和任务/审批管理层。 |
| [Stagehand](https://github.com/browserbase/stagehand) | Browser agent SDK：在 Playwright 风格接口上提供 `act/observe/extract`，支持本地浏览器及托管 Browserbase，浏览器 user-data-dir 可保存登录状态。 | **浏览器自动化 SDK**，不负责提供完整持久桌面或 owner 控制面。适合作为底层 browser seam 的候选，而非项目整体替代品。 |
| [Skyvern](https://github.com/Skyvern-AI/skyvern) | LLM + 视觉驱动的浏览器工作流自动化；Playwright 兼容 SDK、无代码 workflow builder、本地 API/UI 与托管云选项；支持可视化直播和工作流编排。 | **Web RPA / 浏览器工作流**更强：批量流程、提取、工作流连接器等面更宽；本项目更强调单人电脑体验、常驻桌面和控制权切换。Skyvern 可作为浏览器工作流能力的参考，不等同于整台私有云电脑。 |
| [Open Interpreter](https://github.com/OpenInterpreter/open-interpreter) | 当前官方 README 描述的是跨平台编程 Agent/终端 harness，支持 ACP、MCP、skills、hooks 与 sandbox/approval 能力；Computer Use 借助 `agent-browser`、`trycua` QA skills，完整桌面产品指向其关联的 Interpreter Workstation。 | 可与本项目在 **ACP/Agent Runtime** 层比较。值得注意：本项目现有增量正尝试将 DSH 原生 ACP 嵌入自己的远程桌面/审批平台；它不是 Open Interpreter 的 fork，也不应把某个 harness 误当作平台本身。 |

## 关键区别，不要混为一谈

1. **产品层次不同。** Agent Zero 是最直接的“Agent 带一台 Linux 电脑”；OpenHands 偏软件工程 Agent；browser-use、Stagehand 是浏览器自动化开发工具；Skyvern 偏浏览器 RPA；Open Interpreter 是跨任务 harness/终端 Agent（并有独立 Workstation 项目）。
2. **本项目目标是电脑长期在线与数据留存。**P0 已验证同一个真实 Chromium/桌面和用户卷重建后的数据保留；多数浏览器库只负责驱动一个浏览器，会话/工作区持久化取决于具体配置。Agent Zero 也明确有 persistent workspace，因此持久数据并非本项目独有。
3. **控制、安全设计是本项目的重点方向，而不是已认证结论。**本项目源码有 owner 鉴权、内部 runner、网络出口策略、明确审批和接管撤销 lease；Agent Zero 也有容器化、桌面接管和安全建议。不能仅凭文档或架构设计断言其优于对照项目，仍需独立威胁建模、攻击测试和远程部署验收。
4. **当前实现成熟度有明显落差。**这些项目是可安装/可复用的开源产品或组件，官方仓库公开了较广的集成/工作流能力；本项目仍是无 Git commit 的个人仓库原型。它的差异目前是产品方向和控制面设计，不是已证实的生态规模、可靠性或任务成功率优势。
5. **已有可复用组件是主要路线。**本项目现在借用 Linux/XFCE/Chromium/noVNC 等成熟栈，并将 DSH ACP 作为 Agent 执行器候选；应优先把桌面与控制平面做稳，再评估复用 Agent Zero/浏览器层的做法，而不是重新发明整个 Agent 生态。

## 建议的下一阶段门槛

- 先修复/厘清 ACP 实际用量回传：真实测试因 `usage_unknown` 失败时，禁止把模型任务状态标成成功；补充可靠的 ACP 集成测试与可重复的 live-test 证据。
- 明确当前实际运行的镜像、版本和容器是否已经切到 ACP；把可复现部署/回滚写入记录。
- 通过真实模型的“只读任务 → 明确审批后写文件 → 拒绝审批 → 桌面接管/取消”端到端验收，再开始称作可用 MVP。
- 再决定差异化：如果目标是个人远程桌面优先深耕持久桌面、登录交接、备份恢复；如果目标转成广谱 Agent，应优先集成成熟运行时、浏览器自动化和扩展生态，而不是复制竞品功能清单。

## 一手来源

- Agent Zero README（安装、Linux 桌面、workspace、插件、接管与安全提示）：https://github.com/agent0ai/agent-zero/
- OpenHands README、仓库 `AGENTS.md` 与运行时/配置模板（软件工程 Agent、架构、浏览器与任务预算）：https://github.com/All-Hands-AI/OpenHands ；https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/runtime/README.md ；https://github.com/All-Hands-AI/OpenHands/blob/main/config.template.toml
- browser-use README 与官方 1.0 迁移/信任说明：https://github.com/browser-use/browser-use/blob/main/README.md ；https://github.com/browser-use/browser-use/blob/main/MIGRATING.md
- Stagehand README（SDK、本地/托管浏览器与 API）：https://github.com/browserbase/stagehand/blob/main/README.md
- Skyvern README（本地/托管、Playwright SDK、工作流）：https://github.com/Skyvern-AI/skyvern/blob/main/README.md
- Open Interpreter README（当前 Rust/Codex-based harness、ACP、QA Computer Use 与 Workstation 指引）：https://github.com/OpenInterpreter/open-interpreter/blob/main/README.md

## 限制

- 这是有限样本的产品定位对照，不是全面 benchmark、安全审计或代码级逐版本审查。
- GitHub `main` 会变化；比较描述的是访问日的官方材料，不保证所有能力在每种安装形态/套餐都可用。
- OpenHands 的官方页面在本轮抓取时受 GitHub 页面故障影响，相关结论仅采纳官方搜索索引和官方仓库中的文件描述，未对完整 README 逐条核验；其余项目也以官方 README 自述为准，不代表本地实测。
