# Prompix 文档

Prompix 是开源、免费的多模态 Prompt 集合 App。用户像逛手机淘宝和小红书一样，发现有意思的文本、图片、视频、网页 Prompt，收藏并带到合适的工具中使用。

当前阶段：首版范围与「轻盈发现」设计已确认，**原生 iOS 0.2.0 已接通每日采集和真实社区内容，支持中英文原生界面，持续推进完整交付质量验收**。iOS 原生先行，自建轻量采集；最终交付可装真机的验收版。复杂运营 Agent 和 Skill 后置。

## 当前方案

| 文档 | 内容 |
|---|---|
| [product.md](product.md) | 产品定位、四类内容、发现体验、首版边界 |
| [tech-plan.md](tech-plan.md) | 原生客户端、内容协议、轻量采集、静态发布 |
| [quality-release.md](quality-release.md) | 持续目标、完整交付的质量关口与完成证据 |
| [roadmap.md](roadmap.md) | 设计关口、模拟器开发、真机交付、上架与分工 |
| [decisions.md](decisions.md) | 历史决定与本轮 D-20 至 D-32；旧决定保留并标明替代关系 |
| [design.md](design.md) | 设计原则、已确认方向、核心页面和四类卡片要求 |
| [handoff.md](handoff.md) | 复制、编辑、分享和目标工具打开的能力边界 |
| [content-operations.md](content-operations.md) | 每日采集、发布、凭据与故障恢复 |
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
