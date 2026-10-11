# Prompix 技术方案 v0.4

更新：2026-10-11　状态：已确认，随开发持续更新。各部分的详细规格见文中链接。

## 1. 目标与约束

- 开源（MIT）、免费，无广告、无内购，运行成本必须低；性能与稳定性优先。
- 第一版：iOS 原生 App，除中国大陆外的全部地区上架；网页版同步上线。之后单独做 Android 原生 App。
- 研发主要由 AI Agent 完成。
- 内容运营由运营 Agent 闭环完成；人类通过管理后台查看、修改和兜底。
- 第一版不做账号、社区、App 内生成，也不做自产样图和多模型实测；收藏存在本机。
- 模型统一通过 OpenAI 兼容接口接入，可以替换。默认用 DeepSeek。

## 2. 总体架构

```mermaid
flowchart LR
  subgraph 来源白名单
    S1[ClawHub API]
    S2[许可明确的 GitHub 仓库]
    S3[prompts.chat CC0]
    S4[X 官方 API]
  end
  S1 --> AG
  S2 --> AG
  S3 --> AG
  S4 --> AG
  AG[运营 Agent<br/>Mac mini，launchd 调度] --> DB[(Postgres 内容主库)]
  ADMIN[管理后台 Payload CMS<br/>审核、编辑、货架、下架] <--> DB
  HUMAN((人类)) --> ADMIN
  AG --> PUB[发布任务]
  DB --> PUB
  PUB --> R2[(Cloudflare R2<br/>内容快照 + 图片视频)]
  R2 --> IOS[iOS App（SwiftUI）]
  R2 --> WEB[网页版（Next.js）]
  CFG[Workers<br/>远程配置、下架黑名单] --> IOS
  IOS --> MON[PostHog / Sentry]
  MON --> AG
  IOS -->|一键使用| AI[ChatGPT / Claude / Gemini / Grok]
```

核心思路是"静态优先"：App 和网页读取的都是发布到 CDN 上的内容快照，不直接查数据库。用户再多，后端压力也几乎不变；CDN 出问题时 App 仍能离线使用。

## 3. 内容来源

只收录白名单来源，只全文展示许可允许的内容，署名并链接原帖，作者要求即下架。来源清单、许可判定和下架流程见 [content-policy.md](content-policy.md)。

样图用上游仓库收录的创作者原图，转存到 R2 并生成多种尺寸，原因有两个：一是瀑布流加载要快，热链原图会拖慢；二是原帖删除后热链会失效。代价是我们持有副本，所以下架必须快。

## 4. 运营 Agent

- **代码优先**：用 TypeScript（Node）写确定性流水线，负责抓取、去重、许可判定、写库、发布；大模型只负责判断，包括打分、写标题、分类、排货架和异常处理。
- **安全边界**：处理外部内容的模型调用不给任何工具，只返回 JSON，再用 Zod 校验；不合格的进人工队列。
- **好管理**：
  - `prompix-agent` 命令行可以启动、停止、暂停、恢复、立即运行、查看状态；
  - 管理后台有同样的暂停开关；
  - 调度用 launchd，生产环境用系统级 LaunchDaemon。
- **运行环境**：开发在 MacBook 上，生产在 Mac mini 上；支持代理配置。
- 不用 OpenClaw、Hermes Agent 和 Prefect，原因见 [decisions.md](decisions.md) D-14。

详细设计见 [ops-agent.md](ops-agent.md)。

## 5. iOS 客户端

- SwiftUI，最低支持 iOS 17。
  - 瀑布流用 UIKit 的 UICollectionView 自定义布局；
  - 图片加载和缓存用 Nuke；
  - 视频用 AVFoundation，同屏最多播放 2 个；
  - 本地数据用 GRDB（SQLite，带 FTS5 全文搜索）。
- 数据：安装包内置种子快照，按版本清单增量更新，完全离线也能浏览已有内容和收藏。
- 推荐不需要账号：编辑精选 + 全站热度 + 本机兴趣重排；首屏货架和目标 App 的排序按地区切换。
- 一键使用见 [handoff.md](handoff.md)；界面与交互见 [design.md](design.md)。
- 原生能力：v1 做离线收藏和一键交接；v1.1 加分享扩展、键盘扩展和快捷指令。

Android 版之后用 Kotlin + Jetpack Compose 开发：瀑布流用 LazyVerticalStaggeredGrid，视频用 Media3，图片用 Coil，本地库用 Room。

## 6. 网页版

- Next.js 静态生成，和 App 用同一份内容快照，部署在 Cloudflare。
- 作用：
  - 搜索引擎收录；
  - 分享链接的落地页，以及 iOS 通用链接的跳转页；
  - "发到电脑"安装 Skill 时打开的页面；
  - 在 App 上线前先按国家收集使用数据。

## 7. 后端

- 内容主库用 Postgres，管理后台用 Payload CMS 3，和运营 Agent 一起部署在 Mac mini 上。
- Agent 用一个受限角色的 API Key 通过 REST 接口写入管理后台，不用 Payload 的 Local API，因为它默认跳过权限检查。
- Cloudflare Workers 负责远程配置、版本清单、下架申请表单和短链。
- 第一版没有用户数据库。

## 8. 仓库结构

| 路径 | 内容 |
|---|---|
| `agent/` | 运营 Agent（TypeScript） |
| `admin/` | 管理后台（Payload CMS 3） |
| `web/` | 网页版（Next.js） |
| `packages/schema/` | 共享数据结构和快照格式（Zod，导出 JSON Schema 给 iOS） |
| `ios/` | iOS App（Xcode 工程） |
| `docs/`、`design/` | 文档和界面稿 |

`agent/`、`admin/`、`web/`、`packages/` 放在同一个 pnpm 工作区里。

## 9. 监控

- PostHog：埋点和转化漏斗（曝光 → 详情 → 使用 → 选择哪个 App），同时作为运营 Agent 的数据输入。
- Sentry：App 崩溃和错误。
- 大模型调用记录存在 Postgres，管理后台可查；需要更细的追踪时再接 Langfuse 云服务。
- 运营 Agent 失败时告警。

## 10. 依赖与安全

- 依赖尽量少；提交锁文件，安装时用 frozen lockfile；新增依赖要在 PR 里说明理由。
- 密钥只放在仓库外的 `~/.config/prompix/agent.env`。
- 不在任何环节执行来源里的代码；Skill 的脚本只作为文本保存和展示。

## 11. 成本估算（10 万月活）

| 项目 | 费用 |
|---|---|
| Cloudflare R2 存储与请求、Workers | 每月 $15–30 |
| Mac mini（自有，运行 Agent、Postgres、Payload） | 电费 |
| DeepSeek、通义千问 | 首次约 $160–230 / 10 万条（每条约两次 DeepSeek 调用，平均看 1.5 张图），之后按日增量处理，每月约 $10–35 |
| X 官方 API | 每月约 $30–100 |
| PostHog | 每月 100 万事件以内免费，超出后约 $0–200（可以采样） |
| Sentry、Langfuse | 免费额度起步 |
| 合计 | 每月约 $60–400 |

另有 Apple 开发者账号 $99/年和域名费用。

## 12. 里程碑

见 [roadmap.md](roadmap.md)。

## 13. 待定

1. 域名与商标：注册 prompix.ai，并检索"Prompix"商标。
2. Apple 开发者账号的注册主体。
3. DeepSeek 看图能力与通义千问视觉模型的对比结果。
4. 四个 AI App 的真机深链测试结果。
