# Prompix 文档

Prompix 是开源、免费的多模态 Prompt 集合 App。用户像逛手机淘宝和小红书一样，发现有意思的文本、图片、视频、网页 Prompt，收藏并带到合适的工具中使用。

当前阶段：0.2.0 已接通真实社区内容与每日采集，但用户验收认为只达到勉强及格。**0.3.0 已完成完整创作者发现、多语言界面与内容、Skill和更多开放来源、原生体验改进及模拟器交付检查**。当前线上345条×9语言，实际演示见[0.3验收记录](acceptance-0.3.md)，用户产品验收仍待。本阶段只在模拟器研发测试，最后交付实际演示，不向用户手机安装。当前目标和续接见 [next-release.md](next-release.md)，设计依据见 [design-research-2026-10.md](design-research-2026-10.md)。复杂运营 Agent 仍后置。

## 当前方案

| 文档 | 内容 |
|---|---|
| [next-release.md](next-release.md) | 当前验收目标、工作分工与未完成关口 |
| [design-research-2026-10.md](design-research-2026-10.md) | Apple 官方案例、Cosmos 与原生交互实施依据 |
| [product.md](product.md) | 产品定位、四类内容、发现体验、首版边界 |
| [tech-plan.md](tech-plan.md) | 原生客户端、内容协议、轻量采集、静态发布 |
| [app-store.md](app-store.md) | 商店中英文文案、审核路径、隐私申报依据与待办 |
| [quality-release.md](quality-release.md) | 持续目标、完整交付的质量关口与完成证据 |
| [roadmap.md](roadmap.md) | 设计关口、模拟器开发、真机交付、上架与分工 |
| [decisions.md](decisions.md) | 按时间追加的关键决定；旧决定保留并标明替代关系 |
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

品牌官网、帮助、隐私与内容反馈的双语静态实现见 [services/site](../services/site/README.md)，部署于 `prompix.dev`；不代替原生客户端。
