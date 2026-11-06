# Prompix 2.0 条目字段与合并审核

2026-11-06。给 catalog 条目加 2.0 新字段，配固定 facets 词表，并提供「合并审核」库：一次模型调用产出 palette、sourceMetrics 以外的全部新字段。存量 3,130 条的补字段和发布另见本文末尾的进度。

## 字段

全部定义在 `packages/schema/enrichment.ts`，并入 `promptSchema` 时一律可选，旧客户端和旧 release 不受影响。`enrichedPromptIssues()` 规定一条完整的 2.0 条目必须带什么。

| 字段 | 内容 | 来源 |
|---|---|---|
| `presentation` | general / suggestive / unknown / explicit。图片、视频、网页必填 | 模型看真实画面，标准与 `visual-review.ts` 共用（`presentationStandard`） |
| `inputs` | `requirement`、`count`、`kinds`、`ownLikenessOnly` | 模型 |
| `generation` | `modelFamily`、`modelVersion`、`mode`、`outputAspect`、`durationSeconds`、`hasAudio` | 模型；`model` 标签能认出型号时以标签为准；视频的时长和有无音轨按实际文件测量；画幅没写明时取示例的实际比例（与常见比例相差 3% 以内） |
| `variables` | `token`（Prompt 里占位符原文）、`name`、`default`、`hint`（name、hint 中英两份） | 模型；token 必须在 Prompt 原文里出现 |
| `facets` | `useCase` ≤2、`style` ≤3、`subject` ≤3 | 模型，只能用 `packages/schema/facets.json` 里的 id，否则整条失败 |
| `localization.en` | 英文卡片 `title`、`summary` | 已有英文翻译的直接复用；否则模型写 |
| `palette` | 3 个 `{ hex, weight }`，按占比降序 | `ingest/palette.ts`：ffmpeg 缩到 64×64，确定性 k-means，不调模型 |
| `shots` | `{ index, startSec?, endSec?, text }` | 模型，仅当 Prompt 本身分镜头（至少两段） |
| `rights` | `license`、`basis`、`imageExport` | 按来源许可计算，不问模型：X 上的帖子一律 `LicenseRef-source-author-rights` + attribution-only + 不可导出图片；只有 CC0 且有图才可导出 |
| `sourceMetrics` | 收藏、浏览、点赞、转发、采集时间 | 后台进程采集，不进公开条目（`sourceMetricsSchema` 单独定义） |

`localization.en` 和九语 `translations` 并列，而不是放进 `translations.en`：旧客户端要求 `translations.en` 带完整正文译文，合并审核只写卡片标题和摘要。没有 `localization` 的老条目会补一个空翻译的 `localization`（`sourceLanguage` 用审核识别的语言，`sourceFingerprint` 照常计算），已有翻译的指纹不变。

## facets 词表

`packages/schema/facets.json`：三组固定 id，每项带中英显示名；`useCase` 另带 `interest`，对应 `interests.json` 的 12 个兴趣。用线上 3,130 条标签粗算，至少命中一个 useCase 95%、style 70%、subject 81%；style 的缺口主要是构图术语，不进词表。模型可以在 `vocabularyGaps` 里报告词表缺什么，只作证据，不发布。

## 合并审核库

`ingest/enrichment-review.ts`，给补字段脚本和之后的常驻进程共用：

- `packEnrichmentBatches()`：按顺序打包，每次最多 10 条、24 张图、6 万字符输入；Codex 订阅建议 8–10 条一包，摊薄每次约 1 万 token 的固定开销。
- `reviewEnrichmentBatch(provider, candidates)`：只经 `ingest/models/` 的提供方和 `completeValidated` 调用，记录走 `review` 环节（路由用 `npm run pipeline -- route review …`）。原始内容只放在不可信数据块里。
- 返回给模型的 JSON Schema 只用类型、枚举和必填，不带长度、数值、数组长度约束（有的厂商会拒收），精确限制由 zod 在本地再校验一遍。
- 一条不合格（词表外的值、超过数量上限、占位符不在原文里、模式和类型不符、参考图模式却不要输入）只判这一条失败；条目顺序或 id 对不上判整包失败。
- 拒答原样抛出，不换模型重试：调用方把整包送人工。
- `applyEnrichment(item, outcome, { palette, video, policy })` 生成新条目，正文字段一律不动。`policy: "label"` 用于新条目，以模型的尺度为准；`"keep-unless-unknown"` 用于存量，已有标签不变，只重判 unknown。

## 存量补字段进度

- [ ] 50 条试跑：codex-cli、anthropic-api（Sonnet 5.5、Opus 5.5）对比
- [ ] 全量 3,130 条补字段，250 条 unknown 看真实画面重判，explicit 下架
- [ ] 发布新 release 并线上核对
