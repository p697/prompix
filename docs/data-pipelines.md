# 数据流水线：日常更新与按量补库

2026-10-19：用户要求停止本轮扩量，收拢现有库存，转入推荐与标签验证。
旧的2000/10000与“再增加1000”均是历史授权，不是当前自动恢复指令。

## 两个入口，一套证据与发布规则

| | 日常更新 | 按量补库 |
|---|---|---|
| 入口 | `ingest/daily.ts --publish` | `scripts/run-backfill-campaign.ts /absolute/campaign` |
| 调度 | 本机launchd，当前日本时间02/08/14/20点 | 用户指定新增数量后，冻结一个独立阶段，再启动持久runtime |
| 工作 | 来源复查、已审核历史队列消费、新发现、审核、翻译、发布 | collect→review（文字及媒体）→translate→semantic独立SQL队列 |
| 停止条件 | 单次运行结束、预算或完整性保护 | 当前合格基线＋指定增量、暂停、额度/费用/故障保护 |
| 发布 | 普通新增仍受100/日和窗口额度约束 | 独立history publisher；已明确授权的冻结历史ID可在普通额度外发布 |
| 状态 | shared content `status.json`、SQL audit、发布intent | campaign `progress.json`、SQL jobs/attempts、逐阶段不可变产物 |

二者共用来源身份、去重、原文、原始响应、审核、尺度标签、翻译证据、质量hold和费用账本。
日常入口尚非全部SQL独立队列化，不把这次收尾描述为重写了整个日常调度器。
原文＋简中为必需语言；翻译gpt-6-luna，独立语义复核gpt-6.1-sol；其他语言按需。
生产采集不启用官方X付费回退。第三方搜索命中不等于完整内容，更不等于合格新增。

## 持久化与恢复边界

- 代码在Git/CI中，运行从已验证的固定提交安装到仓库外runtime；不要从脏checkout启动长期任务。
- SQL保存队列、尝试、租约和发布；本机外部目录保存原始响应、媒体/翻译证据、共享账本和哈希。
- 本机目录并非云端备份，launchd也不是云端全天候调度。主机/磁盘/网络离线时不能承诺按时完成。
- 一个campaign只允许一个控制器；SQL全局最多3个任务。日常与历史发布争用shared `daily.lock`，不能删活锁。
- 暂停只停止领取新任务，在途任务完成落盘；待处理任务保留。恢复先查实际PID、锁、SQL租约与未知结果。
- 失败/未知调用仍计费；只有匹配的完整留存响应才可离线恢复，不能盲目重试。
- 已批准预算、实际订阅快照（65分钟内、周用量低于90%）与原有审核都继续生效。
- 授权历史发布时，先冻结具体ID，保留限时授权；发布后逐条核对原文、中文、来源和媒体，并检查游标分页及配额。
- 到目标后可有少量已在途产出；最终按去重后的合格净新增报告，不能以搜索条数或模型通过前的草稿充数。

## 以后要求“再增加500/1000条”

使用已配置、持久化的同一个campaign与队列，保留原搜索游标、已分配来源、hold、失败和账本。
以下命令由owner在获用户明确数量授权后执行；密钥仍在仓库外env文件，命令省略加载细节。

1. `node --import tsx scripts/manage-backfill.ts pause /absolute/campaign`，等待原控制器退出、零active leases。
2. `... scripts/manage-backfill.ts status /absolute/campaign` 查状态；通过账号工具记录真实订阅读数，检查费用授权有效期与余额。
3. `... scripts/manage-backfill.ts authorize-stage /absolute/campaign october-extra-500 500`。
   此步骤只做SQL/文件核验，无搜索、翻译、审核或发布。它复核当前合格内容，冻结ID计数证据与哈希，
   写入不可覆盖的 `stages/<id>.json` 和 `stage-locks/<id>.json`，再切换 `active-stage.json`。
   新阶段优先于旧continuation/10000目标；旧阶段原样保留。同一ID不能换目标，重复执行不能重置基线。
4. 复核新阶段、四/五个隔离批次等故障保护、预算与实际quota；确认可运行后，显式移走pause文件并从固定runtime启动原控制器。
   暂停状态启动会在worker启动前拒绝。新阶段授权本身不自动恢复。
5. 跟进刷新真实quota，检查 `progress.json`、队列和持久日志。合格历史内容走独立发布入口，日常新发现额度不变。
6. 达标后做质量抽样、来源/标签分布、实际耗时、增量费用和全账号订阅变化复盘；不自动再扩下一阶段。

阶段增量支持1..10000，当前累计计数上限仍为10000。达到规模上限应另做容量评估，不静默放大。
新阶段以当时**实际合格**seed和队列结果冻结目标；之后撤稿/hold导致旧合格减少时，必须补足缺口。
日常独立新增不满足这个目标。公开库存数量、合格未发布与本阶段净新增三项分开报告。

## 常见阻塞与交接

| 状态 | 处理 |
|---|---|
| 日常任务占发布锁 | 保留冻结清单，等锁释放；不将互斥失败当作已开始发布，不并发强行发布 |
| 发布结果未知 | 查原run/intent和数据库提交，禁止重放采集或模型请求 |
| 来源超过发布新鲜度 | 用原服务商和共享账本有界复核；不改旧时间戳 |
| 模型/网络未知结果 | 保留原attempt和未决费用，隔离可证明的批次；达到断路阈值停止检查 |
| 月预算耗尽 | 分别检查日常与限时补库授权；充值不是花费，也不自动扩大预算 |
| 订阅快照过期/周用量≥90% | 不新增请求，重新取得真实读数或等待；不推算或仅改时间 |

当前日常与补库费用保守共用账本，历史测试/补库累计可能挤占普通月度新发现额度。
限时maintenance授权只保障已有来源复查，不授权日常无限新搜索；任务“在运行”不等于必然有新发现。
这属于后续日常月度预算归因的独立改进项，不能通过删除旧费用或将补库预算永久开放来解决。

详细恢复/冻结发布规则见[历史补库](backfill-campaign.md)，队列契约见[独立队列](independent-ingest-queues.md)。

### Historical visual evidence handoff

Historical publication copies exact matching visual decisions from batch/seed caches into the shared visual cache under `daily.lock`. This is necessary even when the campaign has no unpublished items: daily retention reapplies presentation from shared evidence. The copy checks the complete media identity and attachment coverage; a newer shared decision wins, and equal-time contradictory evidence stops publication. Campaign directories can then be archived without losing published labels. Copying evidence does not create a relevance approval, invoke a model or consume a new-content allowance. Existing immutable batch evidence and cost ledgers are never rewritten.

A repaired label must be published through the normal versioned publisher and checked against the public API. Missing/changed media remains `unknown`; never restore labels by trusting the old presentation string alone.

For an existing affected edition, `node --import tsx scripts/repair-history-presentation.ts /absolute/campaign-root` takes the shared publisher lock, requires no pending release/hold, reads the authoritative edition and copies exact retained evidence before publishing presentation-only changes. It is idempotent: unchanged labels produce no new edition. Explicit findings stop for a removal publication. Load the usual database/publication environment; this command adds no items and has no model or source-fetch path.

### Stage-scoped subscription headroom

2026-10-20：用户授权本次 `additional-1000-20261020` 使用至95%，到线停止；不是全局取消订阅保护。
默认仍为90%。明确获批后，owner在私有campaign目录写入不可变
`subscription-grants/<stage-id>.json`：`version:1, run, stageID, authorizedAt, expiresAt, stopAtPercent:95`。
授权最长七天，必须匹配run和当前stage；新stage冻结时使用拟创建的stageID核验，运行时使用冻结stageID。
失配、到期或格式错误会停止；没有授权则使用90%。该文件不修改真实quota快照，也不改变预算、质量或目标。
控制器在领取任务、每次模型请求及搜索调用前重新读取授权与快照；周用量达到95%停止新增请求，
已在途请求完成保存，因此不能承诺全账号用量绝不越过95%。快照仍必须65分钟内且ordinaryUsageAllowed为true。
全账号其他任务也会消耗额度；授权不能保证完成指定数量，也不允许自动改走付费模型。

跨天恢复会合并shared、seed-revalidation、source-revalidation中最新的确切来源核验，在内存中覆盖checkedAt后重新验证原审核与翻译；保留原始产物及哈希。新的撤回优先，同时间矛盾或未知过期停止。复查不等于新的质量审核；待翻译/语义任务同样接受匹配核验，以免旧队列跨天不可恢复。

### Enlarged retained-library maintenance

`PROMPIX_X_RECHECK_DAILY_CEILING` exposes the bounded recheck ceiling to the existing daily runtime. Default40 and default16 requested attempts remain unchanged; a privately configured value up to80 permits retaining an X library larger than800 sources. The same daily ledger and cumulative dollar budget apply, and configuration cannot silently expand the ceiling by raising only the request count.

On 2026-10-23, expired maintenance authorization and insufficient daily request capacity were found after the published library had fallen to686. The authorized backfill renewed source checks, restored eligible previously published items through the versioned publisher, and froze another1,000 from the current qualified baseline. Restored old IDs are excluded from the new-stage increment. Maintenance uses a separately expiring allowance within the previously approved100-dollar aggregate, sharing the original ledger; the normal20-dollar growth ceiling remains in place. Missing Chinese, changed sources and quality holds remain excluded.
