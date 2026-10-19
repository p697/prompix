# 2000 → 10000 历史补库运行

2026-10-19（日本时间）用户授权恢复：先总量2000，质量与费用正常后继续10000，不逐步请求批准。总预算100美元，充值仍由用户完成。原文＋简中、gpt-6-luna翻译与gpt-6.1-sol独立语义复核沿用已验收策略。

## 调度与计数

`scripts/run-backfill-campaign.ts /external/campaign` 读取不可变配置和既有独立队列。生产完整数据库快照作为基线，既有309条合格原文＋中文先与基线去重。旧500条任务所有已分配来源，包括被拒或未决的来源，均保留为排除项。搜索继续原计划与原游标，不重新购买已有结果。最多3个批次积压，数据库全局最多3个执行任务；队列任务包括采集、完整文字/媒体审核、简中翻译和独立语义检查。

进度明确区分启动时公开库、既有未发布合格内容、新合格内容、待审核和已发布数量。此调度器只导出待验收内容，不激活Feed、不提高每日公开发布额度。候选数不等于补库完成，完成2000/10000的最终核验还必须以当前数据库和当前质量/来源状态重新去重。

2000处由项目owner检查至少50个不同条目、未决质量问题、成本预测与订阅余量，保存 `expansion-10000.json` 后可继续到10000；不需要再次请求用户确认。调度器不能自行生成此审核结论。失败请求或未知提交保存证据并停止新增工作，健康的在途任务完成后退出。来源过期或质量暂缓必须重新核验，不能改时间冒充新鲜。

## 费用与订阅

默认月预算仍最大20美元。显式外部 `PROMPIX_X_CAMPAIGN_BUDGET_FILE` 授权可提高本次任务上限至100美元，文件包含 `version,id,startMonth,expiresAt,totalUSD`；不存在该授权就不能提高上限。所有来源请求仍进入同一个共享账本，不清零旧测试费用、失败或未决记录。跨月合计从授权起始月份开始的全部账本与opening，保守地把旧费用和同期日常费用也纳入100美元上限；授权过期后禁止新请求。充值是余额变化，不记成请求消费。

本次worker的预算配置与旧日常runtime分开；不会因补库而默认放大未来每月预算。旧日常预算可能受本月已累计费用影响；在共享金额接近20美元时必须核对日常维护空间与运行状态，不能把临时历史额度当作长期订阅或自动续费。

`subscription-quota.json` 由owner通过账号限额工具记录实际读数。每个外部请求前检查：允许普通订阅使用、读数不超过65分钟、周已用低于90%；达不到条件暂停新工作，不把未知余量当成免费额度。该检查是保守准入，账号其他会话仍可能同时消耗额度。每小时跟进负责刷新真实读数，禁止自行推算或修改时间来维持运行。

`progress.json`、`measurements.jsonl`、每批文字/媒体/翻译账本、语义响应及SQL attempts持久化保存。费用和速度持续记录；订阅用量是全账号读数，不能精确归因到本批任务。

## 验证与回滚

测试覆盖无授权不能抬高预算、跨月不重置、未决费用保留、授权到期、重复或不完整2000条抽检证据不能扩容，以及订阅数据过期/不足停止新请求。沿用独立队列的锁、fencing、来源和语言验证测试。

回滚先停止campaign并等待在途任务落盘；保留共享账本、数据库任务和外部产物。旧任务继续使用其原有运行副本，不能从新目录重新分配旧来源。主checkout未提交设计文件不得覆盖。

## 首批真实链路修正

语义阶段用生产者保存的原始JSON表示做哈希校验，再做schema验证，避免Zod字段重排产生误报；任何落盘字段变化仍会阻断。完整数据库与去重排除项使用独立的私有快照校验（上限50,000），不再误用公开兼容catalog的1,000条窗口上限。公开响应边界保持不变。两种问题均在外部语义请求之前阻断，修复后须核对原始哈希与SQL attempts证据，再显式恢复原任务，保留失败尝试，不重新采集或翻译。

多批次恢复时，既有exclusions.json按完整JSON值比较，允许对象键顺序规范化但不允许数组顺序或任意字段值变化；验证一致后复用原始文件，不重写字节。该规则只用于私有排除快照，不改变来源、翻译和审核产物的哈希校验。

## 补库期间保护日常复查

日常 runtime 可显式设置 `PROMPIX_X_MAINTENANCE_CAMPAIGN_FILE`，指向同一份有期限的补库预算授权。它只在有效期内允许已有来源的 maintenance lookup 使用该授权总额；新来源搜索和采集仍受原有每月20美元限制。所有服务商、本月和授权起始月份以来的费用、失败与未决请求均进入原共享账本，日额度不变，不扣除历史补库费用以制造空间。授权未开始或到期后恢复普通限制；删去此配置即可回滚。不能与全任务 `PROMPIX_X_CAMPAIGN_BUDGET_FILE` 同时配置，不能据此开启官方API或其他供应商。账本格式不变，旧runtime可回滚；旧runtime不识别此临时授权，达到20美元会重新阻断维护。

## 搜索在调用额度边界失败后的续跑

一次搜索调用用完最后一个请求名额后遇到已分类的临时网络故障或429/5xx，控制器先重读留存响应，再按原退避时间续跑该窗口；其他审核与翻译队列继续。每个窗口/游标最多三次尝试，跨调用与重启累计，失败/未决费用不退回。无响应且未分类、内容解析错误、耗尽三次重试、预算不足仍需人工核对；不会清除请求记录或更换游标绕过限制。已有完整响应优先离线恢复，不重新购买。

## 抽检暂缓单条内容

Owner抽检发现的问题进入既有quality hold，并从合格导出计数中排除。导出先核对原有ready文件SHA和原通过数量，再剔除暂缓ID；其余条目仍须通过来源、媒体、尺度、翻译与时效验证。暂缓不改写原审核产物、不清除失败账本、不自动重跑或解除；损坏的暂缓记录和篡改的产物继续阻断。

## Next stage: 1000 additional qualified items

On 2026-10-19 the user narrowed the active target to another1000 qualified items. An external continuation.json records the run, authorization timestamp, initial newReady count, fixed increment1000 and baseline evidence. It takes precedence over the old10000 expansion and is frozen in continuation.lock.json across restarts. The stopping target is frozen production baseline + seed + initial newReady +1000; separately report the actual current production union. Ordinary daily growth cannot satisfy the increment. Holds reducing prior qualified output require replacement; held items never count as completed. Budget,90% subscription guard, global concurrency and publication limits remain unchanged. Stop for review at this milestone.

Only a complete retained pre-output model-capacity rejection with no output/result file allows a same-model retry of the existing job. Backoff and the cumulative maximum of3 attempts are retained. Save each attempt and event hash; the final rejection reconciles and stops. Partial output, persistence failures and unknown outcomes never retry automatically. Clear stale display errors on resume, while retaining the original attempts and actual failures.

## Retain failed editorial evidence

Historical and daily editorial attempts now persist bounded stdout events, exit status and any output file up to32KB in private attempt-evidence files before temporary cleanup. Events are capped at2MB and explicitly marked when truncated; stderr is drained without retaining credentials or account diagnostics. Nonzero exits, partial/malformed output and storage failures remain blocked, with original attempts and spend retained. This adds no automatic retry and changes no quality decision. Evidence storage failure retains the temporary files and fails closed. Old failed calls whose evidence was already discarded cannot be reconstructed or relabeled as safe capacity retries.

Frozen seed files remain unchanged after24 hours. A separately retained `seed-revalidation/x-availability/state.json`, produced by the existing third-party exact-source recheck with raw response and paid-request ledgers, may refresh only the matching revision and complete dependency scope in memory. Missing, changed, withheld, future or stale rechecks cannot restore eligibility. The controller still stops on unexplained ineligibility. Explicit source-withheld records, owner holds and removals reduce the eligible count while preserving the fixed total target, so additional qualified content must replace those losses; no blind timestamp renewal or new editorial approval is implied.

## Isolate evidenced review outages

The historical controller now leaves a failed review job in `reconcile`, with all downstream jobs still blocked by their dependency, while unrelated batches continue. This applies only to a retained visual timeout with no response or a complete retained editorial pre-output capacity rejection. The manifest, candidate identities, request ledger and evidence hashes must match; each isolation gets an immutable proof under `isolated-reviews/`. There is no provider replay, approval, source reassignment or allowance reset. Previously successful decisions and unattempted candidates remain available for explicit later recovery.

Isolated batches do not fill the three-active-batch scheduling window. The database's global worker cap, quota freshness/90% gate, shared spending ledger, source/quality checks and fixed continuation target remain in effect. Five unresolved jobs open a persistent circuit breaker; restarting does not reset it. Unknown exits, lease expiry, missing or partial evidence, response/manifest changes, database and budget failures still stop the controller. This first isolation change does not implement editorial capacity retry; those items remain pending inspection and do not count as qualified.

Rollback to the previous runtime requires no SQL or ledger migration: it stops on the retained reconcile jobs. Do not remove those jobs or the isolation proofs to make the old runtime continue.

Campaign-local `quality-holds.json` uses the campaign lock and is unioned with shared holds for seeds and qualified exports. This lets an owner exclude a confirmed finding while the independent daily publisher owns the shared lock. Neither scope clears the other, originals remain immutable, and malformed records stop export. Copy the finding to shared holds under the shared lock when available; local campaign holds must remain until an explicit reviewed clearance.


## Qualified history publication

Historical collection remains private and never activates a public release. The separate
`scripts/publish-history-queue.ts /absolute/campaign-root` command drains verified semantic
outputs under the shared content `daily.lock`. Set `PROMPIX_HISTORY_CAMPAIGN` on the daily
publisher to consume the same queue after existing source maintenance and pending-release
recovery, before fresh collection. The campaign configuration must name the same shared root.
The initial bridge consumes independent-queue outputs; older standalone seed artifacts need
separate provenance verification and are not silently imported.

The bridge revalidates immutable output hashes, editorial and complete-media evidence,
Chinese translation, semantic rejection overrides, source identity and owner holds. It
accepts only source checks younger than twelve hours, deferring older rows without replaying
paid reads. This is not a new freshness timestamp. Deduplication compares with the current
full database publication, not a frozen campaign baseline. It preserves original and Chinese
text and existing published rows, removal tombstones and the current generation. Only selected
creator avatars may need mirroring; no collection, translation or review model runs in this
command. Normal public quota (100/day, cumulative six-hour windows, visual priority) and the
transactional database quota remain unchanged. An empty allowance means defer, not publish.

Before staging, register the campaign's `quality-holds.json` through the public root's
`quality-hold-scopes.json`. Existing stage, activation and recovery checks read these live,
flat scopes; a missing registered file fails closed. Do not delete the campaign directory while
registered. Local owner holds therefore remain effective even if they arrive during upload.
A new defect stops activation without rewriting immutable release artifacts. Existing pending
release reconciliation and rollback procedures still apply.

Deployment: enable only after tests/CI, preserve the prior runtime, and wait for the active
public lock owner to finish. First run records `publication-report.json`; verify the database
count/generation, v1/v2 manifests and new v3 details. Moving a row from staged to published is
not another collected item: report campaign-qualified total separately from unpublished count.
Disable `PROMPIX_HISTORY_CAMPAIGN` to stop draining; do not remove registered hold scopes as
a rollback shortcut. The prior publisher must receive equivalent shared holds before rollback.


## Publisher transfer bounds

Production diagnosis found 898 rows with 20.7 MB of original/translated text. The first
25-row query executed in about 4 ms server-side, while a live export waited in ClientWrite;
a full read-only export took about six minutes and another hit the existing 25-second
statement timeout. Indexes were in use. Do not mask this by raising timeouts or weakening RLS.

Exports retain the 25-row keyset cap and additionally target 256 KiB of text per response,
always allowing one schema-bounded row. Short byte-limited pages continue until the actual
end, so large Skill bodies cannot truncate the export. Staging checks immutable revision IDs
and sends original/translation bodies only for missing revisions; every release entry is still
written in the same transaction.

The configured publisher may cache a full release under the external content root's
`database-release-cache/`. Each read recomputes the exact database content hash, verifies the
release still exists, and fetches current removals and removed flags from the database. A
missing, corrupt, oversized or unsafe cache falls back to the bounded authoritative export.
Cache writes are optional and cannot turn a committed stage into a failed mutation. Existing
public activation/source freshness/quality gates remain unchanged. Cache files carry third-party
content and must stay outside Git. They can be deleted without losing authoritative data.


Historical publication reconstructs each exact original source candidate from the retained
batch snapshots before adopting its availability evidence. Mirrored preview URLs are display
assets and cannot reproduce the original source digest. After quota selection, only selected
original posts are copied idempotently into the ordinary X maintenance intake, with unchanged
capture times and post text. The shared intake is reread to reject a conflicting newer source.
This does not copy approval decisions, create new source checks, or fetch anything from X.
