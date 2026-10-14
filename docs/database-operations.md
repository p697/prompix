# 数据库内容服务运维

Prompix 使用独立 Supabase 项目 `erlxnflhvudlfqcdgfhv`。应用只访问 `https://api.prompix.dev/v3/`，Worker 经 Hyperdrive 使用只读账号。采集使用单独的发布账号；管理员权限不进入 App、Worker 或定时运行副本。凭据、CA 和备份始终保存在 Git 之外。

## 日常检查与分析

在已安装依赖的工作树运行下列只读命令。数据库连接来自权限为 0600 的外部配置；输出只含统计和运行身份，不输出连接串、正文或 provider 错误。

```sh
node --env-file="$HOME/.config/prompix/database.env" --import tsx scripts/report-database.ts
node --env-file="$HOME/.config/prompix/database.env" --import tsx scripts/check-database-publication.ts
```

报告包含活动版本、generation、下架序号、内容类型/署名/译文覆盖、全部版本与修订数量、schema 大小、最近输入任务以及七天失败数。`ingest_runs` 只能由发布/运维角色读取。它不是用户行为分析系统；没有新增搜索历史或用户收藏表。

每次自然运行需同时核对本地 `status.json`、`prompix.ingest_runs`、持久 publication intent 和 DB/v2/v1 活动指针。02/08/14/20 JST 的 launchd 任务仍运行在维护机器上：关机、断网或 SSD 离线会影响更新，公开读取服务不依赖这台机器在线。不能把本机采集器描述为高可用云调度。连续失败或超过两个正常运行窗口未成功，应优先检查锁、挂载、证书、网络、磁盘和预算；不清除未决请求，不手动重置额度。

## 备份与恢复演练

[Supabase Pro 每日备份](https://supabase.com/docs/guides/platform/backups)提供最近七天恢复点，PITR 是另收费能力，本项目没有为此新增付费。新项目应在控制台确认实际恢复点，套餐权益不能证明某次备份已完成。2026-10-15 01:44 JST 控制台已显示一个物理恢复点 `2026-10-14 13:21:53 UTC`，早于本次内容导入；它不能代替下文已经验证的完整内容发布备份。托管备份不会替代 R2 媒体、采集来源、外部凭据或本机运行账本的备份。

应用级发布备份在一个只读、可重复读事务中导出完整活动内容、所有已批准译文和全局下架 ID，附 SHA-256 清单。目标必须是仓库外的绝对路径；已有文件不会被覆盖。

```sh
node --env-file="$HOME/.config/prompix/database.env" --import tsx scripts/backup-database-publication.ts /absolute/external/publication.json
node --import tsx scripts/check-database-backup.ts /absolute/external/publication.json
```

第二条命令仅在新的本地 PGlite/PostgreSQL 中应用全部迁移、导入并激活备份，核对每个内容对象、下架集合及公开分页结果；不连接或写入生产。发布备份不包含旧发布历史、输入任务审计、角色密码或 R2 二进制，不是完整 PostgreSQL 灾难恢复。当前脚本按需运行，尚未另装自动备份任务。

2026-10-15 的真实发布备份包含 648 条内容、3,788 份译文和 1 条下架，12,734,642 字节，SHA-256 为 `cda09d380506f14891134df99741a533335dbf0cfd4a29efd490680a3acd2c73`。隔离恢复演练通过；原始文件与报告位于开发 SSD `Evidence/DatabaseFeed/`，不进入公开仓库。没有对生产库执行破坏性恢复，也没有据此宣称已测得灾难恢复时间。

## 发布失败与回退

数据库→v2→v1 跨服务发布依靠持久 intent 恢复，不是假设三者能够原子提交。失败后保留 intent，下一次正常运行继续相同目标；先核对 generation，不能另起一轮付费准备掩盖失败。数据库不可用时保留已激活快照；客户端使用已验证缓存并提供重试。

需要回退内容时沿用 `npm run rollback -- <feed-version> [--publish]` 与[采集说明](../ingest/README.md)，传完整 `feed-...` 发布 ID。不要把最多 1,000 条的 v1/v2 窗口当作全库恢复源。回退写入发布 hold，并保留当前全局下架记录；修复原因后再按现有 hold 流程恢复正常发布。

托管库恢复或更换区域前，先停止写入、导出最新下架记录和 publication intent、记录三个通道指针，并验证可用恢复点。恢复后重新核对角色和 TLS、旋转或重置必要密码、恢复最新下架状态、再接通 Hyperdrive 和发布器。恢复旧物理备份可能倒退下架状态，因此不能直接将旧库对外开放。不要直接切回不能识别 DB intent 的旧采集运行副本。

## 清理与容量

内容下架使用已有 `npm run remove` 工作流：永久 tombstone 覆盖所有历史快照和分页游标，兼容导出同步更新；质量暂缓使用 `npm run quality:hold`，两者语义不同。客户端按独立下架序列清理，某条内容未出现在当前页面不代表应该删除。

运行报告可识别七天前仍未发布的暂存版本、失败输入及存储增长。当前保留不可变历史以支持回退，没有安装自动物理删除数据库版本的任务。清理前必须确认版本不是 active/pending/hold 目标、没有仍有效游标或审计引用，且完整备份验证通过；不要直接截断 revisions、translations、removals 或重置 sequence。当前 648 条版本约 62.7 MB（表与索引），不是所有 PostgreSQL 文件总量，也不能据此保证未来容量不增长。

原生普通缓存有数量/字节上限与 LRU 回收，收藏和草稿不跟随缓存淘汰。现有采集文件清理由 scheduler 的受锁、白名单和保留期规则负责；备份、个人文件和未决付费结果不能混入临时缓存清理。
