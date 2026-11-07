# 数据管线 v2：模型插件、控制面与指挥官

2026-11-06。本文是新管线的总体设计。第一部分（模型插件层和控制面）已在本 PR 实现并测试；第二部分（常驻后台进程）是下一步，接口已按本文预留。

## 目标

- 调用哪家模型、走订阅还是按量 API，只是配置；新增一家只加一个适配器。
- 你对任何一个 agent（Codex、Claude Code 或之后的其他工具）说一句话，它就能查看、启动、暂停管线，或者换模型；换了哪个 agent 都能接着管。
- 后台管线自己跑，不依赖某个对话窗口开着；出问题主动报警，指挥官不用每分钟去看。
- 能快则快、能省则省；质量和安全一条都不让。

## 三层结构

```
你 ──说话──▶ 指挥官（任意一个 Codex / Claude Code 会话）
                 │  只通过 npm run pipeline -- … 读写
                 ▼
            控制面（~/.local/share/prompix/pipeline/）
            config.json 期望状态 · status.json 实际状态 · events.jsonl 记录
                 ▲  读配置、写心跳和记录
                 │
            后台管线（常驻进程，下一步实现）
            采集 → 预筛 → 合并审核 → 安全复核 → 发布 → 翻译
                 │  每个环节按路由调用
                 ▼
            模型插件层（ingest/models/）
            codex-cli · claude-cli · kimi-code · kimi-api · deepseek-api · openai-api · anthropic-api
```

指挥官不直接调用模型做审核，也不直接改控制目录里的文件；它只发命令和看状态。后台进程只读配置，不接受对话里的指令。两边通过控制面解耦，所以任何一个 agent 都能接手。

## 模型插件层（已实现）

每个提供方实现同一个接口：给它可信的说明、不可信的原始内容、一份 JSON Schema（可选图片），它返回一个符合 Schema 的对象。环节代码只认这个接口。

| 提供方 | 方式 | 默认模型 | 看图 | 结构化输出 | 需要 |
|---|---|---|---|---|---|
| `codex-cli` | Codex 本地订阅，`codex exec` | gpt-5.6-luna | 是 | 原生 Schema | 本机已登录 Codex |
| `claude-cli` | Claude Code 本地订阅，`claude -p` | claude-opus-5-5 | 是 | 原生 Schema | 本机已登录 Claude Code |
| `kimi-code` | Kimi 会员订阅，`api.kimi.com/coding/v1` | k3.1-pro | 是 | JSON 模式 + 提示里的 Schema | `KIMI_CODE_API_KEY` |
| `kimi-api` | Kimi 开放平台按量 | 需在路由里指定 | 是 | 同上 | `MOONSHOT_API_KEY` |
| `deepseek-api` | DeepSeek 官方按量 | deepseek-chat | 否 | 同上 | `DEEPSEEK_API_KEY` |
| `openai-api` | OpenAI Responses 接口 | gpt-6.1-sol | 是 | 严格 Schema | `OPENAI_API_KEY` |
| `anthropic-api` | Anthropic 官方 SDK | claude-opus-5-5 | 是 | 原生 Schema | `ANTHROPIC_API_KEY` |

安全约束在插件层统一落实，任何环节都绕不开：

- 原始内容只放在 `<untrusted_source_data>` 块里，块本身不能被内容提前关闭；说明只放在系统提示里。
- 命令行订阅一律关掉工具：Codex 只读沙箱、无 shell、无联网；Claude Code `--tools ""`、不加载 MCP 和技能、不保存会话。原始内容走标准输入，不进命令行参数。
- 所有返回都再用该环节自己的 zod Schema 校验一遍，不合格即失败，不会「差不多就用」。
- 拒答（`refused`）不自动换模型重试：这条内容直接判为不发布，并记下原因。
- 错误统一成几类：`rate_limited`、`timeout`、`failed` 可以稍后重试；`unavailable`（未登录、无额度、无此模型）、`refused`、`invalid_output`、`unsupported` 需要换路由或交给人。
- 记录里只有环节、提供方、模型、耗时、token 和结果，从不写入提示词或模型输出。

密钥放在 `~/.config/prompix/models.env`（权限 600）。命令只报告缺哪个变量名，从不打印值；文件权限过宽会提示。

新增一家提供方：在 `ingest/models/registry.ts` 加一条定义，写一个实现 `ModelProvider` 的适配器，在 `ingest/model-providers.test.ts` 补测试。环节代码和控制面都不用改。

## 控制面（已实现）

目录：`~/.local/share/prompix/pipeline/`（可用 `PROMPIX_PIPELINE_DIR` 改）。

- `config.json`：期望状态（运行／暂停／停止）、每天目标、每个环节用哪个提供方和模型。每次修改都经过完整校验，多个 agent 同时修改会排队，不会互相覆盖。
- `status.json`：后台进程每分钟写一次心跳、当前环节、今天的数量和最近错误。超过 5 分钟没心跳就视为已退出。
- `events.jsonl`：只追加的记录。谁在什么时候改了什么、为什么；每次模型调用的摘要；备注。

`status` 也会报告旧的定时任务（launchd `dev.prompix.collect`）是否启用、上次运行记录是否已过期、锁的持有进程是否还在，避免任何 agent 把一份过期的「running」当成正在运行。

### 命令

```bash
npm run pipeline -- status            # 全貌
npm run pipeline -- status --brief    # 两三行，给指挥官定时看
npm run pipeline -- log --tail 20
npm run pipeline -- providers         # 哪些提供方现在能用
npm run pipeline -- test-provider kimi-code --by codex
npm run pipeline -- test-provider codex-cli --image /path/to/photo.jpg --by codex

npm run pipeline -- target 100 --by codex --reason "先每天 100 条"
npm run pipeline -- route review kimi-code --model k3.1-pro --by codex --reason "用 Kimi 闲置额度"
npm run pipeline -- route translate codex-cli --model gpt-6.1-terra --fallback anthropic-api --fallback-model claude-haiku-5-5 --by claude-code
npm run pipeline -- start --by codex
npm run pipeline -- pause --by claude-code --reason "额度快用完"
npm run pipeline -- note "Lucy 说周末前别动安全复核" --by claude-code
```

环节：`prefilter`（预筛）、`review`（合并审核）、`safety`（安全复核）、`translate`（翻译）、`translationCheck`（翻译检查）。默认全部走 Codex 订阅：预筛和审核用 gpt-5.6-luna，安全复核和翻译检查用 gpt-6-astra，翻译用 gpt-5.6-terra。用 ChatGPT 账号登录的 Codex 只能用它列出的模型（2026-11-06 为 gpt-6-astra、gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna），gpt-6.1-sol 和 gpt-6-luna 会被拒绝；换模型前先 `test-provider codex-cli --model <名字>`。

## 指挥官怎么工作

你对任何一个 agent 说「开始，每天抓 100 个」，它应该：

1. `status` 看当前状态和路由；
2. `target 100 --by <自己>`，必要时 `route …`，再 `start --by <自己>`；
3. 用一两句话告诉你改了什么、预计什么时候能看到结果。

你问「电脑上有没有在跑的管线、跑得怎么样」，任何一个 agent 只需要 `status --brief`，必要时再看 `log`。

盯任务的节奏要省 token：

- 不轮询。后台进程出错、停摆或连续被拒时，通过已有的监控 Worker 发邮件报警，指挥官不需要每分钟去看。
- 如果你要求它「盯着」，用低频定时检查：每 2–4 小时一次 `status --brief`，只有异常时才展开看 `log`。
- 指挥官自己不跑审核，也不把原始内容读进对话；它的上下文只装状态和记录。

## 后台进程

第一版已上线（2026-11-06）：`ingest/worker.ts` 由 launchd 保活（`dev.prompix.worker`，开机自启，退出后自动重启），代码从主仓库目录运行。每分钟写一次心跳，按到期顺序一次只跑一个任务，任务结果记进 `events.jsonl` 和 `status`。

- **来源维护复查**（每 12 小时一次，失败 30 分钟后重试）：带上已发布 ID 做 X 来源复查，并刷新 ClawHub 核验。每次发布都要检查这两项核验。ClawHub 核验 24 小时内有效。X 来源按发帖时间分级：核验时发帖不满 7 天的，核验 24 小时内有效；已满 7 天的，核验 7 天内有效。每次维护都会在核验到期前 12 小时重新复查。作者大多在发帖后不久删帖，所以老帖每周查一次就够，每天的复查开销从约 $0.5 降到几美分；代价是老帖被删后，最多 7 天才下架。X 花费账本给复查预留的额度也按这个算：不满 7 天的帖子按每天查两次预留，满 7 天的按每 6 天查一次预留（`maintenanceRunway`）。原来一律按每天两次全量预留，每天约 $0.9，算上剩余天数会超过每月 $20 的上限，导致新内容的搜索全部被拒。确认原帖已删的条目，立即在数据库里下架，不等下一次发布。一次要下架超过 50 条时拒绝执行并报错，因为这更可能是接口故障。这项任务属于安全职责，不管期望状态是运行、暂停还是停止都会执行。
- **每日采集发布**（期望状态为「运行」时，每个 6 小时 UTC 时段一次，失败 30 分钟后重试，单次最长 3 小时）：在单独的进程里跑 `ingest/daily.ts --publish`，也就是原来的完整流程：采集、编辑审核、图片审核、2.0 审核、翻译和发布。每天 100 条的上限、四个时段的累计额度、图文比例和全部发布前检查都不变。和旧定时任务相比有三处不同：
  - 翻译走管线的 `translate` 路由（`PROMPIX_TRANSLATION_PROVIDER=pipeline`），不再写死 Codex gpt-6-luna。
  - 不处理历史补库 campaign，因为那里的条目没有经过 2.0 审核。
  - 发布前多一道 2.0 审核闸（`ingest/enrichment-daily.ts`，走 `review` 路由）。新条目必须有针对当前内容的有效审核，尺度也必须定得下来：涉及未成年人不安全或不确定的、explicit、unknown 一律不发布；拒答的永不再送审；还没审到的顺延到下一个时段。每次排除写一行到内容目录的 `enrichment/exclusions.jsonl`。
  - 译文复核（`ingest/translation-check-daily.ts`，走 `translationCheck` 路由）：第一次进入版本的译文必须先通过独立的语义复核（漏译、偏义、画面文字和指定回答语言被改等），已上线的译文不重审。没通过的、还没审到的，只在本版里隐去那一种语言，条目照常发布，读者看到原文。结论按译文记在内容目录的 `translations/semantic-ledger.json`；拒答的不再送审。
  - 已上线条目内容没变的，保留它 2.0 审核的结果。从来源重建时丢掉的字段补回来；尺度取两者中更严的，但 unknown 不会覆盖已经判定过的尺度。内容有改动的重新审核，审核通过前继续用线上原版。
- **每日日报**（每天 UTC 0 点后的第一分钟，本机时间上午 9 点）：汇总刚结束的那个 UTC 日，通过监控 Worker 的 `/report` 发到告警邮箱。日报第一行写结论：正常完成，或者具体有什么问题（最后一次运行失败、全天没有一次成功的采集发布、线上数据读不到）。后面依次是线上新增和下架数量（以数据库为准，对照每天目标）、2.0 审核和译文复核排除了多少、每个任务的运行次数、各次结果和用时、成本估算（模型 API 按标价和实际 token 数算，X 按花费账本算，Codex 订阅只记调用次数）。后台进程还没跑过每日采集的日子不发。手动预览或补发用 `npm run pipeline -- report [--since 时间] [--send]`。
- 密钥从 `~/.config/prompix/*.env` 读取，和旧定时任务用同一组文件。
- 子进程（每日流程和它调用的 wrangler）不认后台进程自己加载的系统证书，所以后台进程启动时把系统钥匙串里的根证书导出到控制目录的 `system-roots.pem`，再通过 `NODE_EXTRA_CA_CERTS` 传给子进程。
- 和旧任务共用内容目录的 `daily.lock`，两边不会同时运行。
- 更新代码后执行 `npm run pipeline -- worker restart`。

### 接下来


- 常驻在这台 Mac 上，用 launchd 保活；每轮先读 `config.json`，所以改路由、改目标、暂停都在下一轮生效，不用重启。
- 沿用 Supabase 里已有的任务队列；每个环节有自己的并发数。审核按批处理：订阅命令行每次调用打包 6–10 条，并行 3–4 个，用来摊薄每次调用约 1 万 token 的系统提示开销（Codex 实测）。
- 每个提供方单独统计 token 和限流；遇到 `rate_limited` 先退避，持续受限时暂停该环节并记录，等指挥官或你决定是否换路由。
- 每个环节可以配一个备用路由（`route … --fallback <提供方>`，`--fallback none` 取消）。主路由报 `unavailable`（未登录、无此模型、没有余额）或 `rate_limited`（限流、额度用完）时，这一次调用改走备用，并在记录里写一条 `route.fallback`。拒答、输出不合格等针对内容本身的结果不会交给备用模型。调用记录写的是实际回答的模型。
- 保留现有的安全闸：许可和署名检查、去重、来源新鲜度、尺度标签（暗示性和未定的内容默认隐藏）。没有人工环节：判定全部由流水线完成，拿不准的一律不发布。
  - 涉及未成年人：凡带性暗示、暴露，或把未成年人当作可替换模特的，一律拒绝；判断不了年龄又涉及人物尺度的，也不发布。
  - 真人：按规则自动处理（`ownLikenessOnly` 提示和尺度判定）。
  - 每次排除都记录条目 ID、环节、原因和模型。条目以后重新采集或复查时，可以再判一次。
- 去掉旧管线里没有安全作用的等待：每天 4 次定时、两条线共用的锁、发布窗口和图文比例、每次调用新起进程的额外批次、全局「5 次不明就停」。

## 尚未验证

- Claude Code 订阅：本机登录已过期，需要在终端运行 `claude` 并 `/login` 后再测。另有第三方资料称 2026 年 6 月起 `claude -p` 使用单独的月度额度，官方文档未写明，正式使用前用 `/usage` 确认。
- Kimi 会员 Key：官方说明面向编程工具，批量调用是否算滥用没有明确说法；请先确认会员条款，再小规模试用。
- Kimi、DeepSeek、OpenAI 三个 HTTP 接口目前只有模拟测试，拿到密钥后用 `test-provider` 实测。

## 已实测（2026-11-06，本机）

| 提供方 | 文字 | 看图 | 每次输入 token |
|---|---|---|---|
| `codex-cli` gpt-5.6-luna | 9.7 秒 | 8.2 秒 | 约 1 万（系统提示开销） |
| `anthropic-api` claude-opus-5-5 | 3.0 秒 | 2.6 秒 | 约 300（看图约 1,000） |
| `claude-cli` | 未测：本机登录过期 | | |

这台 Mac 的网络会检查 HTTPS 流量，所用证书只在系统钥匙串里。Node 自带的证书库不认，所以管线命令启动时会把系统证书加入信任列表（`trustSystemCertificates`），效果和 curl、浏览器一致。
