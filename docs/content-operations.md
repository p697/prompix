# 内容运行手册

## 本机运行

- 任务：`dev.prompix.collect`，每天本机时间 08:00；当前 Mac 为 Asia/Tokyo。
- 安装／升级：在已校验的 checkout 运行 `python3 scripts/install-scheduler.py`。脚本先安装独立运行目录，再原子切换 runtime 链接和重新注册 launchd。
- 手动执行：`launchctl kickstart gui/$(id -u)/dev.prompix.collect`。
- 状态：`launchctl print gui/$(id -u)/dev.prompix.collect`。
- 日志：`~/.local/share/prompix/daily.log`，超过 1 MB 保留一份 previous。
- 结果：`~/.local/share/prompix/content/status.json`，包含逐来源成功／失败、版本、媒体失败列表。
- 本地预览：`npm run daily`；人工发布：`npm run daily -- --publish`。
- 下架：`npm run remove -- <id> <reason>`，再发布。不得将包含第三方内容的 JSON、媒体或日志提交到仓库。

launchd 是用户任务，须登录该用户；关机时不会运行。进程锁避免并发，崩溃后的失效锁一小时后可恢复。升级前确认任务未在运行；运行目录保留上次版本以便回退。安装器把实际 Node、Wrangler 和 Git 的可执行目录写入后台 PATH；使用 Homebrew keg-only Node 时同样可被上传工具的 shebang 找到。

公开 GitHub 来源使用本机 Git 的 `ls-remote` 解析默认分支，再按不可变 commit 下载文件；运行环境须有 Git。这样不依赖共享出口的匿名 REST API 额度。仓库与文件名均使用显式白名单，解析或网络失败仍保留上次快照。

2026-10-11 已在付款设置完成后通过已安装的 launchd 任务验证 X：成功获取 10 条候选并持久化增量游标。候选保存在内容目录的 `x-discovery/YYYY-MM-DD.json`，仍须编辑整理后才能发布；一次搜索成功不代表这些帖子已出现在 App。后续运行保留当天请求名额，不重复付费读取。是否成功须检查 `status.json` 的 `sources.x`，不能只看任务退出码。

## 凭据与费用

X 凭据从 `~/.config/prompix/x.env` 加载，文件权限 0600，只包含变量 `X_BEARER_TOKEN`。无需把 Key 发到聊天、App 或 GitHub。账号充值／付款方式由用户完成，自动充值没有启用。

当前 X 发现策略最多每天 10 条返回帖子、一次请求；[官方按量价格](https://docs.x.com/x-api/getting-started/pricing)列出 Posts Read 为每条 $0.005，预计上限约 $0.05／天（不包含未来价格变化或另行启用的资源）。实际以控制台账单为准。失败尝试也占用本机当天名额，避免异常重试花费；人工重试前检查 `x-state.json` 和控制台用量。

Cloudflare 上传显式使用 `services/content/wrangler.jsonc` 中指定的项目账号，避免登录多个账号后后台任务无法选择。使用本机已授权的 Wrangler OAuth；过期后若刷新失败，重新 `wrangler login`，无需将 OAuth 凭据复制到项目。Worker 通过 R2 binding 读取，不携带发布密钥。Cloudflare 套餐按当前账号计费，不默认启用付费增值产品。

## 常见故障

| 表现 | 处理 |
|---|---|
| X HTTP 402 | 额度不足；完成付款设置／充值后重试，其他来源无需停机 |
| 单来源解析失败或空结果 | 保留上次快照，检查上游 README／CSV 格式，再修改合成测试 |
| 媒体来源不在白名单 | 检查真实公开链接后再显式补充，不能开放任意 URL 抓取 |
| 上传／验证失败 | latest 保持旧版本；检查网络、Wrangler 登录和存储空间 |
| App 更新失败 | 继续读已验证缓存；检查线上清单和 `npm run check:deployment` |
| 不需要定时采集 | `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.prompix.collect.plist`；内容服务仍可读 |

发布版本保存在 R2 和本机 releases 下。使用下面的回滚命令，不直接上传旧 manifest；不要为恢复一次抓取而清空收藏或整个内容目录。

## 回滚与恢复发布

1. 从本机 `releases/<version>/manifest.json` 选择目标，执行 `npm run rollback -- <version>`。默认仅演练：读取线上当前与目标目录、核对校验和与条目数，合并目标／当前／本地全部下架 ID，生成独立的 `rollback-*` 版本；不切换线上、不改变下架记录或发布状态。
2. 确认 `rollback-status.json` 的目标和数量后，运行 `npm run rollback -- <version> --publish`。检查旧版本媒体可读取，上传并复核新目录，最后激活清单；上传失败记录到 `rollback-status.json` 和 `operations/rollback-*.json`。
3. 回滚激活前写入 `publication-hold.json`。下一次每日任务仍采集候选，但跳过发布，状态中带 `publicationHold`。不手动删除此文件；这样有歧义的上传响应也不会让次日任务覆盖修复版。
4. 修复采集或编辑问题后，执行 `npm run daily` 查看候选，再运行 `npm run daily -- --publish --resume-publishing`。只有线上激活校验通过后才清除 hold。最后运行 `npm run check:deployment`。

采集、回滚、下架共用同一进程锁，避免本机发布交错。恢复发布会把线上有效下架记录合并到本地，因此恢复较旧备份不会让已下架条目重新出现。暂停发布期间的紧急下架：先 `npm run remove -- <id> <reason>`，再以当前线上版本作为回滚目标执行第 1、2 步。客户端下次更新会应用下架记录；保存在用户剪贴板或已经导出的内容无法远程撤回。

回滚要求本机目标清单仍在且对应远程目录可验证。丢失本地清单、媒体失效或当前版本无法校验时会停止，不猜测版本、不删除远程媒体。当前命令用于已建立的生产内容库；首次初始化仍通过经过检查的发布流程执行。

## 编辑发布

候选保存在 `candidates/`，编辑记录保存在仓库外的 `editorial.json`。用 `npm run review -- <candidate-id> /absolute/path/editorial-metadata.json` 写入标题、用途、示例、标签、封面和可选排序；字段说明见 [采集说明](../ingest/README.md)。原始正文与作者保持不变。编辑记录绑定正文指纹，来源正文变化后需要重新确认。

社区文本默认不发布，网页还须有作品链接与真实预览。图片条目需要核对正文与所选图片，不能假定上游首图就是对应结果；可通过 imageURL 指定已检查的图片，或使用 imageURLs 指定 1–8 张经逐张核对的有序图集，首张成为封面。新增该字段前先升级每日运行副本；所有图片完成镜像才发布该条目。编辑命令只准备内容，下一次 daily 发布才生效。原创内置目录目前 36 条，不使用旧生成脚本覆盖维护。

2026-10-11 后台发布修复：为 Homebrew Node 的实际目录设置 PATH，并为 R2 上传显式传入包含项目账号的 Wrangler 配置。已通过真实 launchd 重跑完成新媒体上传与清单激活，发布 `edition-47a6001f8b85e023`（56 条），四个公开来源正常，媒体错误为零，X 当日额度保护继续生效。


2026-10-11 回滚演练：线上 `edition-47a6001f8b85e023` 的 56 条内容被重建为 `rollback-cf6d201a47711f46`，保留既有下架 ID。真实激活后执行每日任务，采集正常且 `publicationHold` 阻止覆盖；随后显式恢复发布，回到原编辑版本，暂停文件已清除。两阶段部署检查均通过。19 项内容测试覆盖校验失败、媒体缺失、并发锁、上传失败、版本变更、歧义响应、不可变重试，以及大小写／空格编辑必须改变发布版本。运行证据在开发机 `~/.local/share/prompix/quality-publication-held.log`、`quality-publication-resume.log` 及内容目录的回滚报告中。
