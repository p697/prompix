# Prompix 文档

Prompix 是开源、免费的多模态 Prompt 集合 App。用户像逛手机淘宝和小红书一样，发现有意思的文本、图片、视频、网页 Prompt，收藏并带到合适的工具中使用。

当前主线是普通 iPhone：**0.5.1（22）验收反馈修正**，调整创作者横向浏览、专题前置与连续瀑布流、顶部滚动外观、图片下滑返回和收藏页顶栏；见[本轮改动与验证](iphone-feedback-0.5.1.md)。上轮 **0.5.0（21）Cosmos 视觉与首次体验改版**的研究见 [Cosmos iPhone 记录](design-cosmos-iphone.md)，真机安装见 [0.5.0 交付](release-0.5.0.md)。Duo 扩展测试继续暂缓，旧验收现场保持。

上一阶段模拟器开发版为 **0.4.7（20）**，本地签名候选为 **0.4.7（20）**，已提供 [iPhone Duo 模拟器验收版与限制](iphone-duo.md)和[本地发行记录](release-0.4.7.md)；用户手机阶段包仍为 **0.4.6（17）**。0.4.6 已完成：自建 X 多主题发现、原帖与作者核验、预览审核和发布已连通；54 个 Skill、原生工具使用面板、可选的本地变量填写，以及网页 Prompt 的 Lovable／Claude Code 预填入口。当前线上 **531 条内容、70 个 Skill、243 个创作者身份**，其中 37 条直接从 X 采集，包含首条经过原文选段审读的文本 Prompt 及 36 条图片／视频。停止 OpenLab 新增同步，保留历史 230 条及用户收藏身份；尚未声称历史库已全部替换。九语界面完整；当前英文与简中完整记录均为531条，其余语言继续按条目补齐并保留原文回退。10月14日补齐十个Skill的简中正文，52段经过独立语义复核并上线，见[运行记录](content-operations.md#2026-10-14十个skill简中补齐与02点自然排程)。新增63条已完成原文与可见说明审读，其中1条Skill因版本检查步骤混入发布命令被质量暂缓；补译及模拟器实测见[运行记录](content-operations.md#2026-10-13新增内容审读补译与质量暂缓)。采集目录已迁外接SSD，状态写入失败修复已部署，20点自然排程已于20:25成功发布；付费编辑仍因旧结果未决请求而保守停用到当日结束。实际验证与剩余范围见[自建采集升级](independent-pipeline.md)。

上一轮开发版 **0.3.3（10）**：内容提前进入首屏、紧凑创作者行、固定分类、卡片快捷操作与原生详情转场，依据与实际截图验证见[本轮设计复查](design-polish-2026-10.md)。尚未签名或安装用户手机。

上一版 **0.3.2（9）：原文加按需语言下载、缓存与个人数据事务、详情语言下载和重试**，沿用0.3.1的Granola纸张视觉。148项原生模型测试干净通过，真实68→346条旧缓存升级、日语下载UI及英文草稿隔离已在模拟器验证。全部修复后的当前生产版UI复验也通过：中文包补日语后只保留3个活动文件、旧版文件清除，草稿字节不变，复制、编辑与缓存重启通过。Release测量五次启动均值3.624秒、三轮滚动峰值均值约135.47 MB；完整条件见[协议记录](content-protocol-v2.md)及[当前关口](next-release.md)。

服务器每日重跑的旧版本身份冲突已由PR40修复。批量审核运行后，线上目录增至 **352条、九种语言**，当前版本`edition-v2-b740a025a93331a3`包含文本109条（含10个Skill）、图片203条、视频33条和网页7条；180位结构化创作者覆盖311条内容。首个社区网页已完成真实作品审核、九语审读、双通道发布及App内打开验证；同时撤下一个预览错配的图片条目，保留其个人收藏和草稿。真实增量及两个分发通道已校验，见[运行记录](content-operations.md)。上方346条为客户端实际测试时的目录规模，不冒充352条的全量UI重测。

社区Skill采集器已安装到定时运行副本，首次独立实跑取得1条Gog草稿，尚未发布；实际部署和失败来源范围见[运行记录](content-operations.md)。

最新阶段验收包为 **0.4.6（17）**，已按用户本次明确要求安装到插线的 iPhone 17 Pro 并启动；开发 IPA 的严格签名、版本和目标设备覆盖检查通过，见[当前交付记录](quality-release.md)。这不是最终交付或 App Store 上传验收。此前视觉验收与签名包见[0.3.1记录](acceptance-0.3.1.md)，设计依据见[Granola原生适配](design-granola-2026-10.md)，0.3功能证据见[验收记录](acceptance-0.3.md)。完整交付继续推进，复杂运营Agent仍后置。

## 当前方案

| 文档 | 内容 |
|---|---|
| [next-release.md](next-release.md) | 当前验收目标、工作分工与未完成关口 |
| [iphone-duo.md](iphone-duo.md) | Duo 工具链、官方依据与连续操作验收目标 |
| [design-research-2026-10.md](design-research-2026-10.md) | Apple 官方案例、Cosmos 与原生交互实施依据 |
| [product.md](product.md) | 产品定位、四类内容、发现体验、首版边界 |
| [tech-plan.md](tech-plan.md) | 原生客户端、内容协议、轻量采集、静态发布 |
| [content-protocol-v2.md](content-protocol-v2.md) | 已部署的双通道协议、原生语言缓存与事务、已验收和待验收边界 |
| [app-store.md](app-store.md) | 九语言商店文案草稿、审核路径、隐私申报依据与待办 |
| [quality-release.md](quality-release.md) | 持续目标、完整交付的质量关口与完成证据 |
| [roadmap.md](roadmap.md) | 设计关口、模拟器开发、真机交付、上架与分工 |
| [decisions.md](decisions.md) | 按时间追加的关键决定；旧决定保留并标明替代关系 |
| [design.md](design.md) | 设计原则、已确认方向、核心页面和四类卡片要求 |
| [handoff.md](handoff.md) | 复制、编辑、分享和目标工具打开的能力边界 |
| [content-operations.md](content-operations.md) | 每日采集、发布、凭据与故障恢复 |
| [community-skills.md](community-skills.md) | ClawHub 作者与版本采集、文件校验及来源变更处理 |
| [content-policy.md](content-policy.md) | 来源、署名、许可和轻量下架流程 |

## 背景与旧方案

| 文档 | 状态 |
|---|---|
| [research-summary.md](research-summary.md) | 调研线索及新补充的多模态参考；历史结论不是已验证的产品事实 |
| [ops-agent.md](ops-agent.md) | 延后实施的旧运营 Agent 方案，不是首版依赖 |
| [design/v2](../design/v2/index.html) | 旧版 10 屏 HTML 静态稿，仅供参考；非当前范围或视觉定稿 |

产品内的网页 Prompt 是首版内容；完整的 Prompix 网页产品是后续项目，两者不同。HTML 设计稿也不代表使用 HTML 实现 App。

## 维护规则

- 文档与代码不一致时以代码为准，并在同一 PR 更新文档；目前已有原生客户端和轻量采集脚本，线上内容服务已部署于 api.prompix.dev。
- 新关键决定追加到 decisions.md；旧条目保留，并标明被哪些新条目替代。
- 待确认的设计、外部接口能力和部署条件不能写成已经验证。

开发与验证见 [ios/README.md](../ios/README.md)、[ingest/README.md](../ingest/README.md) 与 [acceptance-0.1.md](acceptance-0.1.md)。

品牌官网、帮助、隐私与内容反馈的双语静态实现见 [services/site](../services/site/README.md)，部署于 `prompix.dev`；不代替原生客户端。

**0.4.7（20）已提供iPhone Duo模拟器验收现场，并生成同源码本地签名包**；App Store Connect九语言文案与隐私网址已保存并回读核对，未上传二进制或提交审核。X 图片和视频已实际发布；下一轮重点是完整正文的回复／原始外链提取、供给覆盖及外部原生 App 的真实交接。实现与验证边界见[本轮方案](independent-pipeline.md)。
