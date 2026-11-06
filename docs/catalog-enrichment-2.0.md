# Prompix 2.0 条目字段与合并审核

2026-11-06。给 catalog 条目加 2.0 新字段，配固定 facets 词表，并提供「合并审核」库：一次模型调用产出 palette、sourceMetrics 以外的全部新字段。存量 3,130 条的补字段和发布另见本文末尾的进度。

## 字段

全部定义在 `packages/schema/enrichment.ts`，并入 `promptSchema` 时一律可选，旧客户端和旧 release 不受影响。`enrichedPromptIssues()` 规定一条完整的 2.0 条目必须带什么。

| 字段 | 内容 | 来源 |
|---|---|---|
| `presentation` | general / suggestive / unknown / explicit。图片、视频、网页必填 | 模型看真实画面，标准与 `visual-review.ts` 共用（`presentationStandard`） |
| `inputs` | `requirement`、`count`、`kinds`、`ownLikenessOnly` | 模型；需要上传人脸而模型没判定时，`ownLikenessOnly` 默认为 true（App 统一显示「人像照片」，不区分本人与他人） |
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
- 拒答原样抛出，不换模型重试：调用方把整包判为不发布，并写入排除记录。
- `applyEnrichment(item, outcome, { palette, video, policy })` 生成新条目，正文字段一律不动。`policy: "label"` 用于新条目，以模型的尺度为准；`"stricter-only"` 用于存量：unknown 重判；已有标签只能变严（general→suggestive），不会放宽。

## 补字段命令

`scripts/enrich-catalog.ts`。所有工作文件放在 `--work` 指定的外置目录（媒体、每条结果、批次记录），不进仓库。

```bash
W=/Volumes/Lucy-SSD/Prompix-Codex/enrichment-2.0/full
npx tsx scripts/enrich-catalog.ts review --work $W --catalog /external/catalog.json --run sonnet-55 \
  --provider anthropic-api --model claude-sonnet-5-5 --batch 6 --concurrency 16 --max-concurrency 32 --budget 80
npx tsx scripts/enrich-catalog.ts report --work $W --catalog /external/catalog.json --runs sonnet-55
node --env-file=$HOME/.config/prompix/database.env --env-file=$HOME/.config/prompix/publication.env \
  --import tsx scripts/enrich-catalog.ts dry-run --work $W --run sonnet-55   # 先看报告，再把 dry-run 换成 publish
```

- `review`：下载并校验镜像媒体（与图片审核同一套校验），算 palette，按批调用。媒体准备最多 4 个并发；模型调用从 `--concurrency` 起步，一分钟内没遇到限流就翻倍到 `--max-concurrency`，遇到 429 减半并暂停 30 秒。可中断后重跑，已有结果的条目跳过。拒答的条目写入 `human-queue.jsonl`，不重试、不换模型；超时和临时失败最多重试 4 次；整包格式错误时用同一模型逐条重试一次。按实测 token 和标价估算累计花费，到 `--budget` 停止派发。
- `publish`：在发布锁下读取线上当前版本，只给审核时内容未变的条目补字段，正文一律不动。unknown 用新判定；已有尺度只许变严。判成 explicit 的必须先用 `npm run remove` 登记下架，否则整次发布中止。X 来源要有 24 小时内的复查，已失效的和日常发布一样暂不进入本版（不进下架名单）；ClawHub 来源同样要 24 小时内核验。日常复查停了的话，先跑一次维护复查（`prepareXAvailability`，带已发布 ID）和 `npm run collect:community-skills`。`dry-run` 只写出发布输入和报告。

## 新增条目：重译被语义复核挡下的历史库存

`scripts/add-history-items.ts`。历史补库 campaign（`history-2000-v1`）里有约 700 条已采集、已过编辑和图片审核、也已翻译的 X 条目，因为简中译文被独立语义复核判为 needs-review 而没有上线。主要问题是含义偏差、遗漏，以及把要原样出现在画面里的英文文字也译成了中文。这个命令不搜索、不新采集，按顺序：

1. `retranslate`：只重译简中。把每条的复核意见附在它引用的原文段落上交给译者，原文和其他语言不动，校验器与原翻译环节相同。
2. `semantic`：另起一次调用独立复核新译文，每 4 条一批；带证据的结论照原规则严格校验，自相矛盾的 pass 按 needs-review 处理。
3. `select`：和线上版本及彼此去重，排除 hold 和已下架。
4. `recheck`：用 twitterapi.io 复查来源是否仍在线，写入 campaign 的 `source-revalidation`。
5. 2.0 审核：`enrich-catalog review --catalog <work>/candidates.json --full-media`，同时判定是否涉及未成年人（none / safe / unsafe / uncertain）。
6. `publish`：走 history publisher。逐批重新核验原编辑和图片审核证据、来源时效与翻译完整性。未成年人判定为 unsafe 或 uncertain、可能未成年又是 suggestive、尺度为 unknown 或 explicit 的，一律自动排除；尺度只取原图片审核和新审核中更严的那个。

翻译和复核走模型插件层（默认 `anthropic-api` + `claude-sonnet-5-5`，分别记为 `translate`、`translationCheck` 环节）。原来的 Codex gpt-6-luna 和 gpt-6.1-sol 在 2026-11-06 的订阅上不可用。

## 日常发布

后台进程的每日采集发布在发布前调用 `enrichNewItems()`（`ingest/enrichment-daily.ts`），规则见 `docs/data-pipeline-v2.md` 的「后台进程」。结果按条目存在内容目录的 `enrichment/outcomes/`，绑定审核时的内容；内容不变就不再调用模型。审核失败的条目在之后的时段重试一次。

## 排除记录

流水线不把任何条目交给人。判定不清就不发布，每次排除都在工作目录的 `exclusions.jsonl` 里留一行：时间、条目 ID、环节（media / translate / translationCheck / source / review / publish）、原因、提供方和模型（`ingest/exclusion-log.ts`）。拒答带 `refused: true`，同一内容不再发送；其他排除在下次重新采集或复查时可以再判一次。

## 存量补字段进度

- [x] 50 条试跑：Codex、Sonnet 5.5、Opus 5.5，另有 Haiku 5.5 20 条评估。全量选 Sonnet 5.5
- [x] 全量补字段：3,126 条审核（4 条媒体下载失败，后补审），3,115 条合格，估算 $35.99；unknown 249 条重判，没有 explicit
- [x] 2026-11-06 发布 `feed-40add1c8…`：3,108 条，其中 3,093 条带新字段；22 条 X 来源失效，暂不进入本版；线上只读核对通过
- [x] 补审 12 条后发布 `feed-5cc5250a…`：3,105 条带新字段，最后 1 条 unknown 改判 general；3 条 prompts.chat 文字 Prompt 一直被判成 Skill 模式，保持原样
- [x] 新增：677 条被挡下的历史库存重译（4 条被校验器拒收），521 条通过新复核，去重后 516 条，复查后 469 条仍在线；2.0 审核全部合格，53 条带人物标记，按当时的规则暂未发布，发布 416 条 `feed-fca61a66…`，线上共 3,524 条。花费：重译 $9.83、复核 $6.33、2.0 审核 $7.72，X 复查约 $0.08
- [x] 2026-11-06 规则调整：没有任何条目交人工。53 条原人物标记条目按新规则重新判定，结果见下一节
