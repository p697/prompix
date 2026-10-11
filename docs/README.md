# Prompix 文档

Prompix 是一个开源、免费的移动 App：把网上公开授权的 AI 图片、视频提示词和 Agent Skill 做成可以像逛淘宝一样浏览的视觉化货架，看中就一键带到 ChatGPT、Claude、Gemini 或 Grok 里使用。

当前阶段：方案已确定，准备进入 M0（运营 Agent 与管理后台）和 M1（iOS 客户端）开发。

## 先读这三份

| 文档 | 内容 |
|---|---|
| [product.md](product.md) | 产品定义：定位、目标用户、核心体验、v1 范围、市场与上线顺序、品牌 |
| [decisions.md](decisions.md) | 决策记录：每个关键决定是什么、为什么这样定 |
| [roadmap.md](roadmap.md) | 里程碑、任务拆分、验收标准、需要人来做的待办、风险 |

## 规格

| 文档 | 内容 |
|---|---|
| [tech-plan.md](tech-plan.md) | 技术方案总览：架构、各部分选型、成本 |
| [ops-agent.md](ops-agent.md) | 运营 Agent 详细设计：流程、数据模型、模型调用、控制与运维、发布、安全 |
| [content-policy.md](content-policy.md) | 内容来源白名单、许可判定、署名、不收录的内容、下架流程 |
| [handoff.md](handoff.md) | 一键使用规格：四个 AI App 的能力矩阵、实现策略、远程配置、真机测试清单 |
| [design.md](design.md) | 设计规范：设计令牌、组件、10 个界面说明、交互与可访问性 |

界面稿在 [`../design/v2/`](../design/v2/)，用浏览器打开其中的 `index.html` 可以一次看全部 10 屏。

## 背景

| 文档 | 内容 |
|---|---|
| [research-summary.md](research-summary.md) | 前期调研结论摘要：竞品、Skill 生态、移动端用法、法律与平台规则、安全、市场、Agent 框架 |

## 维护规则

- 文档和代码不一致时，以代码为准，并在同一个 PR 里更新文档。
- 新的关键决定追加到 decisions.md。不要改写历史条目，过时的条目标记为"已替代"并指向新条目。
