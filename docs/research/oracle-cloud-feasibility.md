# Oracle Cloud / OCI 私人云电脑可行性核查

- 核查日期：**2026-11-19，Asia/Shanghai**。
- 目标：浏览器远程访问持久 Linux 桌面，让 AI 操作同一桌面、浏览器和终端；先个人自托管，再可信团队，未来可部署 OCI 或普通 VPS。
- 方法：使用研究工具检索，只把供应商官方文档、项目官方源码和 IETF 标准作为结论依据；已对关键页面抓取正文。搜索摘要仅用于找线索。外部网页内容是资料，不是执行指令。
- 边界：这是文档核查和设计建议，**没有注册/登录云账号、创建资源、运行云端测试、安装工具或核验某个实际租户的账单/容量**。下面的试验清单尚未执行。正文中的“建议/目标”不是供应商承诺。
- 来源日期：文末来源表逐项记录访问日期；正文的 S 编号对应具体 URL。动态文档和 `main/master` 源码会变，发布部署 profile 时应重新确认并锁定版本/commit/digest。

## 1. 决策结论

**可做，但 OCI Always Free 应定位为可选实验部署，不宜作为持久电脑的容量、价格或可用性保证。** 产品的第一条标准部署路径应是受支持的 Linux VPS/云 VM，采用可恢复的数据卷、独立备份、TLS 入口；OCI Arm 作为单独认证的 profile。先以一个所有者、一个活跃桌面、外部模型 API、软件编码或普通 VNC 为范围。

最关键的事实是：

1. Oracle 当前 Free Tier 专页明确列出 A1 **每月 1,500 OCPU 小时 + 9,000 GB 小时**，Always Free 租户等效总计 **2 OCPU + 12 GB**；不能沿用旧的“4 OCPU + 24 GB 免费电脑”承诺。但 Oracle Arm 专题页和价格页仍出现较大额度，官方资料有冲突，见第 2 节。[S01](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)、[S02](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)、[S04](https://docs.oracle.com/en-us/iaas/Content/Compute/References/arm.htm)
2. 免费容量只在 home region；可能 `out of host capacity`；闲置实例可能回收；Free Tier 没有 SLA。账号闲置与实例闲置是两套规则，个人低频使用尤其需要备份和可重建能力。[S01](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)、[S03](https://www.oracle.com/cloud/free/faq/)
3. **Arm64 可运行受支持的 Linux 浏览器自动化栈，但须按版本认证**。2026-11-19 抓到的 Google Chrome for Testing 官方矩阵已包含 `linux-arm64` 的 Chrome、ChromeDriver、headless shell；再写“Google Chrome 完全不支持 Linux Arm”已不准确。这个证据不自动等于任意 Chrome 安装器、插件、DRM 或桌面镜像均兼容。[S09](https://googlechromelabs.github.io/chrome-for-testing/)、[S10](https://playwright.dev/docs/intro#system-requirements)
4. A1 以 **无可用 GPU 的 CPU 平台**设计；免费 A1/AMD 上的嵌套 KVM **没有得到当前、明确、对应 shape 的官方支持确认，不能作为设计前提**。普通 Linux 进程/容器桌面不依赖嵌套虚拟化；需要强 VM 隔离时选择另有明确支持的付费实例或裸机。[S04](https://docs.oracle.com/en-us/iaas/Content/Compute/References/arm.htm)、[S06](https://docs.oracle.com/en-us/iaas/oracle-linux/oci/index.htm)
5. **持久磁盘、卷备份、异地副本、公网流量和模型调用是不同成本项**。200 GB 是 boot + block 合计，5 个备份也是 boot + block 合计；同区备份不能独自覆盖区域故障和账号不可用。不要把“免费机器”写成“整个产品永久零成本”。[S01](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)、[S07](https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/blockvolumebackups.htm)、[S05](https://www.oracle.com/cloud/price-list/)

## 2. Always Free：现行额度、冲突与账号限制

### 2.1 免费层和促销试用分开计算

- **Always Free**：官方称符合条件的资源在账号生命周期内免费，但仍有额度、地域、回收、账号条款和资源供应限制。[S01]
- **Free Trial**：通常是 US$300、最多 30 天，额度用完或日期到期先发生者结束；它能创建超出 Always Free 的付费资源，不能证明试用结束后仍免费。[S02][S03]
- 试用结束前要检查**所有 A1 实例合计**。S02 警告：超出 Always Free 租户可用 A1 数量/总资源时，现有 A1 实例会被停用，30 天后删除，除非升级付费；明确要求总计不超过 2 OCPU 和 12 GB。[S02]
- FAQ 还说明特殊促销账号可能**不会转成 Always Free 账号**；必须读具体注册 offer。删除/回收后的数据可能不可恢复，宽限期不是备份策略。[S03]
- 升级 PAYG 后仍可享符合条件的免费资源，超额资源计费；FAQ 写明升级后不能降回免费账号。升级不会保证某个 shape 有库存。[S01][S03]

### 2.2 当前可核实的计算资源

| 项目 | 2026-11-19 抓取正文中的规定 | 对私人桌面的含义 |
| --- | --- | --- |
| Ampere A1 | `VM.Standard.A1.Flex`；每月前 1,500 OCPU 小时、9,000 GB 小时免费；Always Free 租户总计等效 2 OCPU/12 GB；可一台或最多两台各 1 OCPU | 建议先把资源集中在一台；并发浏览器、视频编码和 Agent 会争抢 CPU，实际体验未知 |
| A1 CPU 单位 | A1 1 OCPU = 1 core/1 vCPU，不能套用 x86 1 OCPU = 2 vCPU 的比较法 | 2 OCPU A1 不能描述成“4 vCPU” |
| AMD Micro | 最多两台 `VM.Standard.E2.1.Micro`；每台 1/8 OCPU、1 GB 内存，可使用额外 CPU 资源；互联网带宽最高 50 Mbps，私有流量等另有上限 | 不建议默认承载完整桌面 + 浏览器 + Agent；可用于极小辅助服务，仍须压测 |
| 镜像 | A1 列 Oracle Linux/Ubuntu 等 Arm 镜像；Always Free-eligible Linux 镜像本身不收许可费；Cloud Developer 镜像至少 8 GB 内存 | “能在 OCI 启动”不等于“Playwright 官方支持该发行版” |
| 额度分配 | 额度、实例数量和存储都在租户范围内合计 | 不是每个 Bot、每个项目各获一套 |

来源：Always Free 详情 [S01]；OCPU 单位与 CPU/内存分别定价见价格页 [S05]。月小时额度不等于容量预留或并发可用保证。

### 2.3 官方额度页面存在实质冲突

本次直接抓正文得到：

- Free Tier 资源详情 S01：**所有租户 1,500 / 9,000，免费租户 2 OCPU / 12 GB**。
- Free Tier 总览 S02：试用结束后保留 A1 的总上限为 **2 OCPU / 12 GB**。
- Arm-Based Compute 专题 S04：仍写所有租户（包括付费和 trial）**3,000 / 18,000**。
- 价格页 S05 的 Container Instances 注释：仍写 **each paid tenancy** 前 **3,000 / 18,000**，并提到 Bare Metal/VM/Container Instances 共享；这不能直接外推给免费账号。

**处理方式：免费部署按更保守且直接针对 Free Tier 的 1,500 / 9,000、2/12 规划。** 付费账号究竟是否享有较大共享免费用量、历史租户是否有过渡政策或既有权益，以及准确变更生效日期，**本次未能从可读取的一手政策正文确认**。这不是认定所有账号均已减半，也不是认定付费账号必然保留旧额度。部署前要求使用者在 Console `Limits, Quotas and Usage`、费用估算/账单及适用合同中核对，发生冲突向 Oracle 确认。额度显示也不证明有可创建的物理容量。

检索找到 Oracle 自有社区题为 “OCI Always Free: Updated Ampere A1 Compute Allocation” 的候选公告，但抓取返回技术错误页，未据其摘要推断生效日或 grandfathering。见来源 X01。**没有使用第三方新闻来补写政策事实。**

### 2.4 地域、容量、账号与回收

- Always Free Compute 必须在 tenancy 的 **home region**；免费 boot/block volume 也要求 home region，在其他 region 建卷通常按正常价格计费。选注册地区时不能只看“便宜”，还要考虑用户到地区的时延、服务供应和实际可用容量。[S01][S02]
- S01 写 A1 在多 AD 地区可选择 AD（另列韩国 Chuncheon 例外）；AMD Micro 只在一个 AD 可建。遇到容量不足只能尝试其他允许的 AD/等待或选其他可付费资源，**无等待时长保证**。[S01][S03]
- S08 写 trial/free tier/PAYG 默认只有一个订阅 region，PAYG 可申请增加。跨区恢复需要目标 region 的订阅、权限、配额和容量；免费账号不能预设一定能在 OCI 第二地区创建灾备资源。[S08]
- 每人只允许一个 Free Trial/Always Free 账号；FAQ 禁止创建或尝试创建多个免费账号，联系/计费信息必须持续真实有效。通常需要手机号码和有效银行卡用于验证；不保证注册审核通过。**账号闲置 30 天及以上**可能被视为 abandoned，暂停或终止。[S03]
- **实例闲置规则**：7 天期间同时满足 CPU 使用率第 95 百分位 <20%、网络利用率 <20%、内存利用率 <20%（内存一项仅 A1），Oracle 可回收 Always Free Compute。[S01] 这里是三项并列条件，不是“有一次 CPU 低于 20% 即回收”。
- Free Tier 无 SLA；仅使用 Always Free 资源不享 Oracle Support。不要向团队用户承诺 24×7 或固定恢复时间。[S03]
- 不通过人为烧 CPU/制造流量规避回收。把可失去计算节点的假设落实到自动重建、备份、恢复演练和付费/VPS 退出路径中。

## 3. Arm64、桌面、浏览器和编码器

### 3.1 桌面/镜像的兼容边界

建议选 **Ubuntu 24.04 LTS arm64 + 轻量 X11 桌面**作为首个 Arm 试验组合；先对 x86_64 profile 完成闭环，再认证 Arm。此为项目选择，不是 Oracle 对 XFCE/noVNC 组合的性能或支持承诺。Oracle 官方确认 A1 可用 Ubuntu/Oracle Linux Arm 平台镜像。[S01][S04]

逐层确认 OS、桌面组件、VNC server、代理 runtime、原生 Node/Python 模块、浏览器、字体、ffmpeg 及每个镜像的架构；不要用 `--platform linux/amd64` 模拟跑通来宣称原生 Arm 支持。应用镜像应分别提供/验证 `linux/amd64`、`linux/arm64`，并记录 digest、系统版本和依赖清单。Windows/macOS 产物、x86-only 的闭源桌面软件不会因主机有 Arm CPU 自动兼容。

noVNC 官方说明它是 HTML/JavaScript VNC 客户端，服务端需要 WebSocket 支持，否则用 websockify 做 WebSocket 到 TCP 代理；可绑定 localhost。[S18] 它提供浏览器访问路径，并不创建桌面、持久化数据或替代鉴权。

### 3.2 Chromium、Chrome、Playwright 应分别验证

- Playwright 当前官方系统要求包含 Debian 12/13、Ubuntu 22.04/24.04/26.04 的 x86-64/arm64，说明 Linux Arm64 有官方支持路径；它不代表任意 Oracle Linux 版本原生受支持。[S10]
- Playwright 默认使用其配套 Chromium，浏览器版本与 Playwright 版本关联；官方说明带界面的完整 Chromium 与 headless shell 分开提供。用户看到的桌面浏览器和 Agent 连接对象应通过独立 profile/进程及调试接口明确绑定，不能把 headless 截图当作同一桌面证据。[S11]
- **Chrome 的新事实**：2026-11-19 抓到 Google 官方 Chrome for Testing availability，`Last updated @ 2026-11-19T10:12:50.036Z`，Stable 为 `158.0.8127.36`，`chrome`、`chromedriver`、`chrome-headless-shell` 均列 `linux-arm64` 且 HTTP 200。[S09] 因此“没有任何官方 Linux Arm Chrome 二进制”不能继续写入路线。普通 Chrome 企业部署、具体包管理器安装、Widevine/DRM、扩展与第三方原生插件本次未全部核实，按具体版本另验；Chrome for Testing 的存在也不证明 Playwright 任意版本的 branded installer 已适配。
- Chromium 与 Google Chrome 的媒体 codec 支持有差异，Playwright 官方也提醒 branded browser 的 codecs、enterprise policy 和 headless 行为可能不同。需要登录、视频播放、扩展的真实工作流都应单测。[S11]
- Playwright 官方 Docker 文档建议锁版本，并要求镜像与项目 Playwright 版本匹配；镜像包含浏览器和系统依赖，**不自带项目 Playwright npm 依赖**。官方构建脚本接受 `--arm64`、`--amd64`。[S12][S13] 本次未成功读取所选 release 的 MCR 多架构 manifest，**没有拉取或运行镜像**；发布前仍须检查具体 tag/digest 确实含目标架构并原生启动验证。
- 官方 Docker 页面说明默认 root 会关闭 Chromium sandbox，且该测试/开发镜像不推荐直接访问不可信站点。[S12] 私人云电脑恰会浏览任意网页，不能把文档中的 root/`SYS_ADMIN` 调试示例当默认生产配置。建议非 root、保留 Chromium sandbox、最小权限和独立持久数据目录；共享 IPC 等配置另按隔离要求评估。

### 3.3 ffmpeg、CPU 编码与 GPU

FFmpeg 官方源码 `configure` 明确识别 `aarch64|arm64`，提供 `libx264`、`libvpx`、`libopenh264` 等可选编码库，并把 NVENC、VAAPI、QSV/oneVPL 等硬件加速分别列为能力；这证明有 Arm 编译路径，**不证明某个发行版二进制已启用所有编码器**。[S14] 本次 Ubuntu 包详情页抓取超时，所以不以包搜索摘要证明实际安装包包含 x264。

项目应检查运行产物的 `ffmpeg -version`、`ffmpeg -buildconf`、`ffmpeg -encoders`，再实测目标编码器、色彩格式、采屏、音频和性能；ffmpeg/codec 的开源许可证和专利/分发条件在打包发布时逐项核对。源码开启 `--enable-nonfree` 可能使产物不可再分发，不能为“开源部署范式”随意聚合二进制。[S14]

A1 是通用 Ampere CPU 平台，官方 Arm 介绍的适用项包括 **CPU-based** AI/ML inference；Always Free shape 说明没有 GPU 资源分配。[S01][S04] **默认假定没有可用 GPU、NVENC、CUDA 或视频硬件编码器**，不要把 Ampere 服务器当成带视频硬件的手机/Raspberry Pi。即便 ffmpeg 列出某硬件编码器，也要有相应设备和驱动才能工作。

建议先 noVNC/VNC 做办公交互；需要 WebRTC 时以 CPU 软件编码做独立实验。从 1280×720、15–30 fps 等试验档起测，不承诺 A1 2 OCPU 同时支撑 1080p60、多个活跃浏览器和 Agent。记录编码 CPU、浏览器 CPU、输入往返延迟、带宽与丢帧，再决定降分辨率、换付费 CPU 或启用另行验证的 GPU profile。

## 4. CPU 虚拟化与嵌套 KVM：不能混淆

OCI 给用户一台云 VM，和用户可在该 VM 内再运行硬件加速的 KVM guest，是两回事。Docker/普通进程桌面主要复用 Linux 内核，也不是嵌套 KVM。

- 官方已 EOL 的 Oracle Linux KVM Image 文档明确写：AMD processor-based VM 不支持 nested virtualization，历史支持项涉及 Intel VM；它同时写 Oracle Linux 7 镜像已停止支持。[S06]
- **不能把 EOL 文档当作 2026 全部 shape 的完整支持矩阵**，也不能根据某付费 Intel VM/KVM 博客推导 Always Free AMD 或 A1 有支持。
- 本次未获得当前官方针对 `VM.Standard.A1.Flex` 和 `VM.Standard.E2.1.Micro` 的嵌套 KVM 支持保证；A1 的 Arm EL2、AMD 的 svm/VMX 暴露、`/dev/kvm` 可访问性及正式支持范围均应视为**未证实，不能作为设计前提**。一个“Arm FAQ”候选 URL 返回 404，另一个 KVM 博客正文不可读，均未用摘要补结论。
- 软件 QEMU 模拟不等于硬件 KVM，也不能当作免费层性能方案。MVP 在云 VM 内运行单所有者的 Linux 桌面和容器；公众多租户/不可信用户命令需要独立 VM 或经单独验证的隔离环境、权限模型和成本预算。
- 将来若需要 microVM/KVM，在选定 provider、shape、region、OS/kernel 上查正式支持并做可复现测试；测试中即便出现 `/dev/kvm` 也不足以替代供应商支持条件。

## 5. 网络接入：云防火墙、客体防火墙和 TLS 均要配置

### 5.1 OCI 规则的真实语义

官方说明 security list 作用于 subnet 下 VNIC；NSG 作用于选定 VNIC。二者一起使用时，常规允许规则是**并集**，不是“再经过更严格 NSG 就能覆盖 security list 的宽放行”。客体 OS firewall 是另一层，必须对齐。若另启 ZPR，还需满足 ZPR policy。[S15]

公网直接访问需 public subnet、public IPv4/适当 IPv6、Internet Gateway、路由及安全规则；只给 VM 一个 IP 不够。[S16] 建议：

- 公网入口仅公开鉴权后的 HTTPS/WSS；SSH 仅管理来源网段、私网或 Bastion；关闭直接公开 VNC、CDP/remote debugging、数据库、runner、容器 daemon。
- Guest `nftables`/`ufw`/`firewalld` 与 NSG/security list 都最小放行；同时检查容器端口映射/转发链和 IPv6，不能只检查一张云控制台截图。
- TLS 终止处验证证书自动续期、WebSocket Upgrade、长连接超时和 Origin；TLS 加密不代替用户鉴权、会话授权、接管和 CSRF/跨站 WebSocket 防护。
- AI 工作负载不持有云管理员/API signing key；限制其访问 instance metadata。S15 特别写 169.254.0.0/16 不受这些安全规则强制，因此**不能仅靠 NSG 阻挡工作区读取 IMDS**，需在客体/容器隔离和实例权限上处理。

### 5.2 个人私有访问优先，公开入口另作 profile

个人阶段可用 Tailscale/私有隧道让入口只在私网可达。Tailscale Serve 官方说明是 tailnet 内服务，支持 HTTPS 与访问规则，并建议后端仅监听 localhost，避免身份 header 被旁路伪造；Funnel 是公开访问功能，不应误开。[S17]

Tailscale 官方说明 direct UDP、DERP、peer relay 三种路径均端到端加密，但中继性能通常低于直连；没有“永远 P2P/永远低延迟”的保证。[S19] 私网访问也需要云主机**能出站**连接控制/中继服务和模型/软件源；放在无公网 IP 的私有 subnet 后，要预算并配置真实出口（例如 NAT/代理），不能把 overlay 当作无需网络的服务。团队阶段另核 Tailscale 套餐、设备/用户/身份提供商要求；本次未核价，不承诺永久免费团队网络。

公网 HTTPS profile 需要拥有可控域名/DNS（或明确支持的证书名称方案）、证书签发和续期；reserved public IP 便于换机后保持地址，ephemeral public IP 不能随意迁移，实例终止会释放；reserved IP 则直到主动删除才释放。[S16] 隧道 profile 也要验证 WebSocket、鉴权和上传下载限额，并核对供应商条款、出口和流量费用；不要假定某个 HTTP 隧道能透明承载 WebRTC 媒体 UDP。

### 5.3 WebRTC/TURN 单独验证

普通 noVNC/WebSocket 路线不因使用浏览器就自动需要 TURN。选择 WebRTC 桌面后，HTTPS 信令成功也不证明媒体能连接。IETF RFC 8835 §3.4 要求 WebRTC 支持 ICE、STUN/TURN 配置，针对 UDP 被禁环境还要求 TURN over TCP 和 TLS over TCP；NAT/防火墙会使直连失败。[S20]

需要：可达的 STUN/TURN、短期鉴权凭据、防开放中继滥用、所选实现的监听端口/relay 端口范围、NSG 和 guest firewall、证书/域名、真实公网映射和 NAT external address。TURN 端口范围以具体实现配置为准，不能只放行信令 TCP 443。443/TLS fallback 与网站入口共机时还要设计端口/代理冲突。测试家庭宽带、移动网、企业禁 UDP、IPv4/IPv6 混合网络，并记录 direct/relay 比例和额外延迟。[S20]

TURN 与 Tailscale DERP 是不同中继层；可选其一或组合，但都不会取消底层主机的出站流量成本。若媒体中继在另一个供应商，可能同时产生源桌面到中继、中继到客户端两端账单，按各自出口分别核算。

## 6. 存储、备份、RPO/RTO 与故障域

### 6.1 免费存储的边界

S01 明确：**200 GB 是 boot + block volume 合计**，home region 内；**最多 5 个 Always Free volume backups 是 boot + block 合计**。不是每台 VM 200 GB，也不是“200 GB 数据盘另送系统盘”。创建第 6 个免费备份可能直接失败，轮转任务必须监控失败和留存数量。[S01]

同一页面对 boot volume 还存在 47 GB 和 50 GB 两种写法：Compute 段称 minimum 47 GB，Block 段称默认/最小 50 GB。**规划按每台至少约 50 GB 预留，以实际镜像/Console/API 为准**，不围绕 3 GB 差额设计部署。建议首台用约 50 GB boot + 100 GB data，保留重建/恢复时临时卷空间；容量仍须按账号已有全部卷合计。创建恢复卷、clone 或第二台 VM 会消耗额外配额/产生费用。

Always Free 对象存储与 volume backups 是两种资源，不要混算。S01 还按免费账号、付费/试用状态区分对象存储免费池，并警告试用结束超额对象可能删除；不把其免费对象存储当无限异地备份。

### 6.2 卷、备份、clone/快照的区别

官方卷备份是加密保存于**区域内 Object Storage**的时间点数据，可在同区任一 AD 还原新卷；有 full/incremental，两者都能恢复完整时间点。备份尺寸可能高于文件系统当前已用量，删除 full 后某些 incremental 的计费体积还可能增长。[S07]

“快照”只描述时间点语义，不自动意味着独立或异地：

- **volume backup**：保留时间点，恢复时创建新卷；源卷不可用时仍可恢复，但恢复时间和计算容量需另算。
- **volume clone**：快速复制到 Block Volume，消耗新卷空间/性能资源，不替代独立备份。
- **volume group backup**：多卷 crash-consistent 时间点；应用一致性仍需数据库/应用 quiesce、flush 或原生备份。运行内存、未落盘操作不在备份内。
- **cross-region copy**：OCI 正式支持，可异地恢复，但要目标 region 订阅、权限、可用额度、备份存储和复制/出站预算。[S07][S08]

S07 说备份在高峰可耗数小时。备份“任务已启动”不算达成 RPO；只有完成且验证可恢复的副本才算。云磁盘内持久文件不等于在进程崩溃/主机被删/租户不可用后都有恢复保证。

### 6.3 建议的恢复目标（项目目标，必须实测）

**个人试验阶段**：

- 建议目标 RPO ≤24 小时，RTO ≤4 小时；每天对应用一致的工作目录和任务/配置数据库做加密备份，关键产物在任务完成后立即导出。24 小时 RPO 要按“最后完成并可还原副本时间”监测，给备份完成时延留裕量。
- 至少一份副本在主机/主卷外；再保留一份可从 OCI 账号之外读取的异地副本（个人另一设备或独立存储提供商）。加密密钥另存；否则账号封停、权限误删或区域故障可同时影响电脑和备份。
- boot 可以通过 IaC + cloud-init 重建；独立 data volume 保存工作文件、数据库和必要 browser profile。浏览器凭据/系统 keyring 能否跨主机解密和重新登录应专门演练；不把登录态当作可无损迁移的普通文件。
- 每月至少一次在干净 VM 恢复，测量从发现故障到 TLS/私网入口、数据、Agent、人工接管均可用的完整时间。

**可信团队阶段**：

- 先约定可接受的数据损失/停机，再设如 RPO ≤1 小时、RTO ≤1 小时的付费目标；需要数据库原生备份/日志、应用数据增量、备用算力/region 配额、监控值班和演练，不能靠免费 5 个卷备份宣称实现。
- 多实例分布不同 fault domain；有多个 AD 时进一步跨 AD。Oracle 每 AD 有 3 个 fault domain；它们隔离硬件/维护风险，但不是异地备份。[S08]
- 跨 AD 不能直接把原 AD 的卷任意挂到另一 AD；卷是 AD 资源，还原备份才能在目标 AD 获得新卷。[S08]
- 同区另一 FD/AD 不能覆盖区域级灾难；异地副本也不等于自动切换。个人免费账号无法获取恢复计算容量时，**RTO 无上界保证**，应保留普通 VPS 恢复方案。

恢复时间计算模板：`RTO = 故障发现 + 决策/授权 + 等待可用容量 + 创建/还原卷 + 主机配置 + 数据一致性检查 + DNS/隧道切换 + 端到端验证`。恢复点按最后一个验证成功的独立副本计算，不能只看定时任务频率。

## 7. 成本：用可复核公式，不报固定低价

Oracle 价格页对 CPU/内存、存储/性能、AI、网络列不同计费单位；本次抓取动态价格页许多数值单元格为空，无法可靠取得当前币种/合同的完整单价。因此**不提供“每月若干美元包办”的金额**。查询价格页、估算器并用真实账单验证；另计税、汇率、支付方式及合同差异。[S05][S21]

### 7.1 逐项成本模板

| 成本项 | 估算模板/必须核对的边界 |
| --- | --- |
| A1 CPU | `max(0, 全租户合资格 A1 OCPU·h − F_cpu) × p_cpu`；免费账号规划 F_cpu=1500，PAYG 具体免费池见第 2.3 节，不能自行取 3000 |
| A1 内存 | `max(0, 全租户合资格 A1 GB·h − F_mem) × p_mem`；免费账号规划 F_mem=9000；CPU 和内存独立扣量，别只算 vCPU |
| 其他 VM/VPS/GPU | 按该 shape/VPS 套餐/GPU 小时及内存等实际 SKU；不因 A1 免费而连带免费；普通 VPS 套餐还需核 included transfer/超额/附加盘 |
| Boot + Block | `Σ(每卷按时间折算的 provisioned GB-month × 容量价) + Σ(GB-month × VPU档位/性能价)`，扣除确实适用的免费量；关应用/停实例不等于删除卷和备份 |
| Volume backups/快照 | 按服务实际计费备份 GB-month、保留版本与适用免费额度；5 是免费备份数量限制，不能按“5 × 原盘大小免费”推导；clone 按新 Block Volume 算 |
| 异地/独立备份 | 目标存储 + API/请求 + 复制/下载/出站 + 还原临时卷/算力；每个提供商分别核价 |
| 公网 IPv4 | `已分配/保留/空闲 IP 的计费数量或 IP·h × 对应 p_ip`；核 ephemeral/reserved、使用/未使用状态与合同。**本次未取得足以确认所有状态的现行 IPv4 价目，金额未知，不承诺永远免费，也不套用别家云的收费规则** |
| 流量/带宽 | `Σ各计费路径 max(0, 可计费出站 GB − 该路径适用免费池) × p_egress`；区分公网、跨区、中继、同区。另计 LB/NAT/网关/隧道套餐等已选服务费用 |
| 域名/TLS/TURN | 域名续费、DNS 服务（若收费）、证书/托管入口（若收费）、TURN 主机/服务与流量；免费证书不等于域名/入口/中继都免费 |
| 模型调用 | `Σ(未缓存输入单位 × p_in + 缓存输入 × p_cache + 输出 × p_out + 图像/音频/视频/工具/搜索等单位 × p_extra)`，遵循实际供应商定义；模型 API 预算和 OCI 算力预算分开 |
| 其他 | 对象存储、日志、监控、邮件、密钥、用户套餐、支持、税费等按所选资源核算 |

其中 p 是当日币种/region/合同的实际单价，F 是实际适用免费池，不是保证可用的配额。非 PAYG 免费账号可能直接无法创建超额资源，不能把上述付费公式理解为自动允许超额。

### 7.2 出站流量与帧率的关系

Oracle 网络价格页目前说明公网出站**每月前 10 TB 免费**、同区数据移动无收费；Always Free 资源页也列 10 TB/月 outbound。该池是账号/计费规则下的总量，不能给每桌面/每连接重复抵扣，适用单位和路径按账单确认。吞吐上限和月流量是不同约束，10 TB 不代表可一直跑满任意带宽。[S01][S21]

测量模板：

`视频/桌面出站 GB ≈ 平均码率 Mbps × 3600 × 使用小时 × 同时观看连接数 ÷ 8 ÷ 1000`。

例如 **4 Mbps × 4 小时/天 × 30 天 × 1 连接 ≈216 GB/月**（十进制 GB，不含协议、音频、输入、文件、备份、重传等）。这是流量算术示例，不是 A1 画质/速度或价格承诺。VNC 的码率随画面变化很大，要以网络计量为准；TURN/DERP 的线路会改变性能和账单路径。

### 7.3 费用控制应落实到产品

部署前保留完整资源清单与成本预览；创建后再对照真实计量。配置预算告警，但**不要把告警当作硬性停费开关**。模型侧限制每日预算、任务步数/最大 token/重试；主机侧设置磁盘/备份留存告警、关停明确不再使用的付费资源，并检查残留 reserved IP、boot/data volume、backups、LB/网关。数据删除另行明确授权。

## 8. 可重复部署、密钥与普通 VPS

Oracle 提供开源 OCI Terraform provider，官方文档支持 Terraform 和 Resource Manager，并警告 Terraform state 可能包含密码、私钥等敏感属性。[S22] 建议把 OCI 资源（VCN/subnet/NSG/route/instance/volume/IP）和通用 Linux 应用启动配置分层。

- **Terraform 主路径**：使用 `oracle/oci`，锁 CLI/provider 版本和依赖校验；shape、region、AD、镜像 OCID、架构、boot/data 大小、端口、入口和备份目的地可配置。先 review plan，再 apply；创建失败能重新执行，已有资源可 import；不可在失败重试时自动销毁已有持久数据。
- **OpenTofu 路径**：官方支持 `required_providers` 的来源地址/版本约束/lockfile，[S23] 因此值得验证 Oracle provider；但**本次未执行 tofu init/plan/apply，也未找到 Oracle 对任意 OpenTofu/provider 组合的全面支持保证**。发布前单列经过验证的 CLI/provider/registry、状态迁移和销毁行为，不能把语法类似写成已认证。
- **cloud-init**：安装/配置应可重复执行且校验完成状态；`cloud-init status --wait` 与输出中的错误要进入部署验收。官方说一些 module 并非幂等，单纯重跑全部 cloud-init 不能保证安全。[S24]
- **凭据**：SSH 只注入公钥；云 API signing key 留部署端；外部模型 key、Tailscale auth key、管理员密码用短期/一次性注册或受控 secret 注入，限定权限，避免出现在 repo、state、user-data、启动日志和镜像中。仅标记 Terraform `sensitive` 不等于 state 已加密。
- **镜像清理**：制作共享镜像前清理用户数据、shell 历史、模型 key、隧道状态、浏览器 profile/cookies、SSH host keys、应用 token；重建后重新注册。cloud-init 官方 `clean --logs --seed --machine-id` 等选项可清它管理的缓存/日志/机器标识，**不负责清除所有应用秘密**，也会导致下一次开机重新跑初始化，只能在准备模板的明确流程中使用。[S24]
- **状态/销毁**：IaC state 加密存储、访问控制、避免打印到日志；data volume 明确保留策略/删除保护；卸载区分运行服务、云资源和用户数据，输出残留计费资源，不把 destroy 的成功等同于已清除全部凭据。

普通 VPS profile 复用相同的受支持 Linux/CPU 架构、应用镜像、数据目录、TLS/私网入口、备份格式和验收脚本；云厂商的网络、块盘挂载、metadata、备份 API 单独适配。有 cloud-init 的 VPS 用相同用户配置，没有的用明确的 SSH/bootstrap 路径。**不要求 OCI IAM、Oracle KVM 或 OCI 专属对象存储才能启动产品**；跨 provider 恢复优先依赖应用级加密导出，而不是只能在 OCI 还原的卷格式。VPS 的出站、IPv4、快照/备份和虚拟化政策仍由该供应商单独确认。

Windows 桌面、Windows 客户端/Server、远程桌面访问/多会话权利和再分发许可**单独评估**，不纳入默认开源 Linux 镜像或默认成本；不因提供商能启动 Windows VM 就推导可免费分发 Windows 云桌面。

## 9. 最低落地试验清单（未执行）

以下完成并记录结果前，profile 标记为“实验/未认证”，不要写“一键部署已支持”。

1. **额度/容量**：由拥有者确认账号 offer、free/PAYG 状态、home region、A1 月额度、现有 boot/block/backups、实际可创建 shape 与余额；记录信息时去除账号/OCID/密钥等敏感值。核对 trial 到期后的资源清单和备用 VPS。
2. **原生架构**：在目标 amd64/arm64 各用干净 VM 验证 OS、桌面、浏览器、Playwright、原生依赖/字体、镜像 manifest 与 digest；记录 `uname -m` 等必要架构证据，不上传环境全集。
3. **同一电脑闭环**：用户经 HTTPS/私网看到持久桌面；AI 打开页面、完成文件任务；Playwright/GUI 操作同一受控浏览器和目录；人可接管并停止后续输入。
4. **性能**：连续 30–60 分钟典型办公任务，并叠加页面滚动/视频/Agent 截图；分别测 VNC 和选定 WebRTC 软件编码的 CPU、RSS、磁盘、平均/峰值出站、帧率、输入延迟、断流恢复。A1 2 OCPU 和 AMD Micro 分开给结论，不能用付费大规格成绩替代。
5. **网络**：核 public subnet/route/IGW、NSG/security list 规则并集、guest/container firewall、IPv6、TLS/WSS/续期；从外部确认 VNC/CDP/runner/数据库不可直接访问。工作区不能读取不该有的 IMDS/云凭据。
6. **私网/中继**：确认 Tailscale 的 direct/DERP/peer-relay；如果 WebRTC，强制测试 TURN relay、禁 UDP、移动网、企业网与 IPv6；核验域名、证书、端口、临时凭据、出口与流量账单。
7. **持久与恢复**：断开浏览器、重启容器、重启 VM、重建 VM，分别检查文件/数据库/浏览器 profile、任务中断状态；执行一致性备份和全新主机恢复，核对校验和、最近恢复点、RTO；至少一份独立异地副本可在 OCI 不可用时读取。
8. **IaC 与费用**：Terraform 两次运行第二次无意外变更；OpenTofu 单独记录兼容矩阵；验证失败后续跑、保留数据的重建/卸载与凭据清理；运行 24–72 小时对照费用计量，覆盖 boot/data、备份、出站/IP、入口/TURN 和模型调用。

## 10. 不应该承诺与尚未确认事项

- 不承诺 OCI 注册成功、指定 region 有 A1、提升配额获批、PAYG 升级后立刻有库存或永不回收。
- 不承诺旧版 4 OCPU/24 GB 免费权益适用于任何新/老/付费账号；**准确变更日和历史账号过渡条款未知**。
- 不承诺 A1 有 GPU、免费 VM 支持嵌套 KVM、软件模拟等于硬件虚拟化、容器足以隔离不可信租户。
- 不承诺任意 Arm Docker 标签、Chrome 安装方式、闭源 App/扩展/DRM、codec 或硬件加速均可用；具体 release manifest、应用组合和性能仍待原生测试。
- 不承诺固定 IPv4 价格、全球最低月价、10 TB 是每实例额度、TURN/Tailscale/模型调用免费；**现行 IPv4 各状态费用本次未可靠确认**。
- 不承诺云磁盘、快照、同区备份或相邻 fault domain 能单独覆盖区域事故/账号不可用；不承诺免费资源 RPO/RTO 和 SLA。
- 不承诺主机重启能无损继续进程内状态、浏览器登录态跨机器可直接恢复，或所有外部 GUI 副作用可自动重试。
- 不分发默认 Windows 桌面/许可，不承诺浏览器能绕过网站验证码、反自动化、登录授权或服务条款。

## 11. 一手来源与访问记录

以下 S01–S24 均在 **2026-11-19（Asia/Shanghai）**访问并获得可读正文（部分大型页面被工具截断，仅用于已读到的段落）；没有给出网页本身未说明的更新时间。标记 X 的失败页面不作为主张依据。

| 编号 | 官方资料、具体 URL | 访问日期 / 用途 |
| --- | --- | --- |
| S01 | [Oracle — Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) | 2026-11-19；A1/AMD、闲置、home region、卷/备份、网络额度；直接抓正文 |
| S02 | [Oracle — OCI Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm) | 2026-11-19；trial、A1 超额试用结束处理、2/12；直接抓正文 |
| S03 | [Oracle — Free Tier FAQ](https://www.oracle.com/cloud/free/faq/) | 2026-11-19；一人一账号、30 天账号闲置、无 SLA/支持、特殊 offer、PAYG；直接抓正文 |
| S04 | [Oracle — Arm-Based Compute](https://docs.oracle.com/en-us/iaas/Content/Compute/References/arm.htm) | 2026-11-19；架构/平台镜像、CPU-based inference、旧额度冲突；直接抓正文 |
| S05 | [Oracle — OCI Price List](https://www.oracle.com/cloud/price-list/) | 2026-11-19；SKU/单位、A1 OCPU、boot/block 另计、付费 A1 免费池冲突；动态金额未完整抓到 |
| S06 | [Oracle — Oracle Linux KVM Image (EOL)](https://docs.oracle.com/en-us/iaas/oracle-linux/oci/index.htm) | 2026-11-19；历史 AMD VM 限制、Intel 支持和 EOL；不外推当前 A1 |
| S07 | [Oracle — Block Volume Backups](https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/blockvolumebackups.htm) | 2026-11-19；full/incremental、跨 AD/region、应用一致性、备份时延、clone 差异；直接抓正文 |
| S08 | [Oracle — Regions and Availability Domains](https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm) | 2026-11-19；FD/AD、卷作用域、region 订阅限制；直接抓正文 |
| S09 | [GoogleChromeLabs — Chrome for Testing availability](https://googlechromelabs.github.io/chrome-for-testing/) | 2026-11-19；当前 linux-arm64 分发矩阵；直接抓正文 |
| S10 | [Microsoft Playwright — Installation / System requirements](https://playwright.dev/docs/intro#system-requirements) | 2026-11-19；Linux arm64 支持 OS；直接抓正文 |
| S11 | [Microsoft Playwright — Browsers](https://playwright.dev/docs/browsers) | 2026-11-19；浏览器版本耦合、headless/有头、Chrome/codecs 差异；直接抓正文 |
| S12 | [Microsoft Playwright — Docker](https://playwright.dev/docs/docker) | 2026-11-19；镜像内容、版本匹配、root/sandbox、开发用途；直接抓正文 |
| S13 | [Microsoft Playwright 官方源码 — utils/docker/build.sh](https://raw.githubusercontent.com/microsoft/playwright/main/utils/docker/build.sh) | 2026-11-19；构建脚本支持 linux/arm64 与 linux/amd64；不是所选 tag manifest 运行证据 |
| S14 | [FFmpeg 官方源码 — configure](https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/configure) | 2026-11-19；aarch64、编码库/硬件加速和分发开关；直接抓源码 |
| S15 | [Oracle — Security Rules](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securityrules.htm) | 2026-11-19；SL/NSG 并集、OS firewall、IMDS 地址例外、ZPR；直接抓正文 |
| S16 | [Oracle — Public IP Addresses](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm) | 2026-11-19；公网条件、ephemeral/reserved 生命周期；此页未确认所有 IP 状态价格 |
| S17 | [Tailscale — Serve](https://tailscale.com/docs/features/tailscale-serve) | 2026-11-19；tailnet HTTPS、ACL、身份 header 与 localhost；直接抓正文 |
| S18 | [noVNC 官方源码 — README](https://raw.githubusercontent.com/novnc/noVNC/master/README.md) | 2026-11-19；浏览器 VNC、WebSocket/websockify、本地绑定；直接抓源码 |
| S19 | [Tailscale — Connection types](https://tailscale.com/docs/reference/connection-types) | 2026-11-19；direct/DERP/peer relay、加密和性能边界；直接抓正文 |
| S20 | [IETF RFC 8835 — §3.4 Middlebox-Related Functions](https://datatracker.ietf.org/doc/html/rfc8835#section-3.4) | 2026-11-19；ICE/STUN/TURN、TCP/TLS fallback；直接抓标准正文 |
| S21 | [Oracle — Virtual Cloud Network Pricing](https://www.oracle.com/cloud/networking/virtual-cloud-network/pricing/) | 2026-11-19；公网前 10 TB、同区传输；直接抓正文；估价另用 [Oracle Cost Estimator](https://www.oracle.com/cloud/costestimator.html) |
| S22 | [Oracle — Terraform Provider](https://docs.oracle.com/en-us/iaas/Content/dev/terraform/home.htm) | 2026-11-19；官方 provider/源码、state 敏感属性警告；直接抓正文 |
| S23 | [OpenTofu — Provider Requirements](https://opentofu.org/docs/language/providers/requirements/) | 2026-11-19；provider source/version/lockfile；直接抓正文，不等于已验证 OCI 兼容 |
| S24 | [Canonical cloud-init — CLI commands](https://docs.cloud-init.io/en/latest/reference/cli.html) | 2026-11-19；schema/status/clean、seed/machine-id、幂等边界；直接抓正文 |

### 访问失败/证据缺口

- **X01**：[Oracle Cloud Customer Connect — OCI Always Free: Updated Ampere A1 Compute Allocation](https://community.oracle.com/customerconnect/discussion/970310/oci-always-free-updated-ampere-a1-compute-allocation)，2026-11-19 抓取返回 Oracle 技术错误页；未引用搜索摘要中的具体变更日/账号范围。
- [Oracle Arm FAQ 候选](https://www.oracle.com/cloud/compute/arm/faq/)，2026-11-19 返回 404；未以此证明 A1 nested virtualization 支持或不支持。
- [Oracle KVM 博客候选](https://blogs.oracle.com/linux/kvm-nested-virtualization-in-oci)，2026-11-19 返回技术错误页；不能以其标题推导免费 shape 支持。
- 所选旧 tag 的 MCR manifest、部分 Google 帮助/发布页、Ubuntu ffmpeg 包详情及 FFmpeg 文档站本次超时/解析失败；软件栈判断使用表中可读官方源码/文档，具体安装和性能保持未验证。
- IPv4 计费、付费账号 A1 免费池适用细则、历史账号过渡、具体 region 实时容量、OpenTofu 组合兼容、实际 RPO/RTO 仍需发布/部署前补证；**没有用“没搜到收费”推定免费，也没有用旧文章推定当前政策**。

[S01]: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
[S02]: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm
[S03]: https://www.oracle.com/cloud/free/faq/
[S04]: https://docs.oracle.com/en-us/iaas/Content/Compute/References/arm.htm
[S05]: https://www.oracle.com/cloud/price-list/
[S06]: https://docs.oracle.com/en-us/iaas/oracle-linux/oci/index.htm
[S07]: https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/blockvolumebackups.htm
[S08]: https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm
[S09]: https://googlechromelabs.github.io/chrome-for-testing/
[S10]: https://playwright.dev/docs/intro#system-requirements
[S11]: https://playwright.dev/docs/browsers
[S12]: https://playwright.dev/docs/docker
[S13]: https://raw.githubusercontent.com/microsoft/playwright/main/utils/docker/build.sh
[S14]: https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/configure
[S15]: https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securityrules.htm
[S16]: https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm
[S17]: https://tailscale.com/docs/features/tailscale-serve
[S18]: https://raw.githubusercontent.com/novnc/noVNC/master/README.md
[S19]: https://tailscale.com/docs/reference/connection-types
[S20]: https://datatracker.ietf.org/doc/html/rfc8835#section-3.4
[S21]: https://www.oracle.com/cloud/networking/virtual-cloud-network/pricing/
[S22]: https://docs.oracle.com/en-us/iaas/Content/dev/terraform/home.htm
[S23]: https://opentofu.org/docs/language/providers/requirements/
[S24]: https://docs.cloud-init.io/en/latest/reference/cli.html

