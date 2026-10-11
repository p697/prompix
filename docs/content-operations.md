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

launchd 是用户任务，须登录该用户；关机时不会运行。进程锁避免并发，崩溃后的失效锁一小时后可恢复。升级前确认任务未在运行；运行目录保留上次版本以便回退。

公开 GitHub 来源使用本机 Git 的 `ls-remote` 解析默认分支，再按不可变 commit 下载文件；运行环境须有 Git。这样不依赖共享出口的匿名 REST API 额度。仓库与文件名均使用显式白名单，解析或网络失败仍保留上次快照。

2026-10-11 已在付款设置完成后通过已安装的 launchd 任务验证 X：成功获取 10 条候选并持久化增量游标。候选保存在内容目录的 `x-discovery/YYYY-MM-DD.json`，仍须编辑整理后才能发布；一次搜索成功不代表这些帖子已出现在 App。后续运行保留当天请求名额，不重复付费读取。是否成功须检查 `status.json` 的 `sources.x`，不能只看任务退出码。

## 凭据与费用

X 凭据从 `~/.config/prompix/x.env` 加载，文件权限 0600，只包含变量 `X_BEARER_TOKEN`。无需把 Key 发到聊天、App 或 GitHub。账号充值／付款方式由用户完成，自动充值没有启用。

当前 X 发现策略最多每天 10 条返回帖子、一次请求；[官方按量价格](https://docs.x.com/x-api/getting-started/pricing)列出 Posts Read 为每条 $0.005，预计上限约 $0.05／天（不包含未来价格变化或另行启用的资源）。实际以控制台账单为准。失败尝试也占用本机当天名额，避免异常重试花费；人工重试前检查 `x-state.json` 和控制台用量。

Cloudflare 上传使用本机已授权的 Wrangler OAuth；过期后若刷新失败，重新 `wrangler login`，无需将 OAuth 凭据复制到项目。Worker 通过 R2 binding 读取，不携带发布密钥。Cloudflare 套餐按当前账号计费，不默认启用付费增值产品。

## 常见故障

| 表现 | 处理 |
|---|---|
| X HTTP 402 | 额度不足；完成付款设置／充值后重试，其他来源无需停机 |
| 单来源解析失败或空结果 | 保留上次快照，检查上游 README／CSV 格式，再修改合成测试 |
| 媒体来源不在白名单 | 检查真实公开链接后再显式补充，不能开放任意 URL 抓取 |
| 上传／验证失败 | latest 保持旧版本；检查网络、Wrangler 登录和存储空间 |
| App 更新失败 | 继续读已验证缓存；检查线上清单和 `npm run check:deployment` |
| 不需要定时采集 | `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.prompix.collect.plist`；内容服务仍可读 |

发布版本保存在 R2 和本机 releases 下。回滚时选择已验证的旧 manifest 上传到 `v1/latest.json`，但必须保留有效移除记录，不能直接复活已下架条目。不要为恢复一次抓取而清空收藏或整个内容目录。
