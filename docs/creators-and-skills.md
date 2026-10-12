# 创作者与 Skill 内容

本轮将创作者作为可浏览的内容入口，并加入可阅读、收藏和转交到桌面工具使用的 Skill。旧客户端仍使用 v1 内容协议：原有四种 `kind` 不变，Skill 使用 `kind: text` 与可选的 `contentType: skill`。缺少 `contentType` 的旧条目按 Prompt 处理。

## 创作者协议

每条内容可以携带 `creator`：`id`、`platform`、`displayName`、`profileURL`，以及有来源证明时的 `username`、`externalID`、`bio`、`avatarURL`。不从显示名猜测账号；缺少真实照片时由客户端显示首字母或默认标记。

- YouMind 公共仓库：从作者链接或原帖链接提取 X 账号，保留原作者与 YouMind 收录来源两个层次。
- prompts.chat：其[公开 CSV 导出实现](https://github.com/f/prompts.chat/blob/main/src/app/prompts.csv/route.ts)将 GitHub OAuth 或历史 GitHub 投稿者导出为用户名，其他账号导出为邮箱。只有可识别的单一 GitHub 用户名才生成个人主页；邮箱和多人署名不强行生成账号。
- 官方 Skill：保留 Anthropic/OpenAI 的 GitHub 组织主页。
- X API：`author_id` expansion 与 `user.fields` 一起返回真实账号 ID、名称、简介和照片，避免为每个搜索结果再请求一次作者。

已取得真实数字 ID 的 X 创作者使用 `x-id-<id>` 作为稳定身份；仅有来源链接时使用 `x-<小写用户名>`。缓存保留旧用户名别名，账号更名后不会把同一数字 ID 拆成两个创作者。GitHub 使用 `github-<小写用户名>`。

iOS 创作者收藏随内容更新同步真实账号 ID、名称、头像和主页。客户端优先按平台 ID 关联，其次使用同平台用户名；旧账号改名时，通过新旧目录中稳定的内容 ID 迁移。已知不同的真实账号 ID 不会因同名、用户名被他人重新使用或内容署名变化而合并。收藏文件写入失败时保留旧资料并暂停本次目录替换，避免丢失迁移依据；主页和作品数量始终从当前目录解析。

目录将同一账号的旧用户名身份与已核验数字 ID 合并计数，并优先展示已核验资料。如果同一用户名同时对应两个已知数字 ID，未核验的旧身份独立保留：不会把其作品重复归到两个账号，也不会让一个旧收藏同时标记两个主页。目录、主页作品和收藏判断共享这一规则。

头像先从 allowlist 下载，验证为图片，再转换为最长边 400 px 的 JPEG，按内容哈希写入现有 R2 `media/`。发布的 `avatarURL` 只使用 `api.prompix.dev/media/<sha256>.jpg`，客户端不直接连接 X/GitHub 的照片地址。同一图片复用缓存，照片失败只缺少照片，不删除作者或其作品。

2026-10-12 的初次资料补全针对当前库的 132 个 X 账号，仅发出两次批量用户请求，取得 128 个有效账号的真实 ID 与照片。4 个不可用账号保留来源署名与无照片回退。原始结果、尝试记录与内容均保存在仓库外。

## 采集节奏与开销

已有 X 每日搜索上限仍为一次、10 条帖子；新增作者字段复用该次响应。普通未发布的预演不会调用付费 X 接口。

额外作者资料补全默认关闭。只有发布运行同时配置 `PROMPIX_CREATOR_LOOKUP_ENABLED=true` 与项目的 `X_BEARER_TOKEN` 才会启用：

- 仅查询已通过审核且准备进入内容库、又缺少真实 X ID 的作者；每个 UTC 日期最多一次请求，最多 20 个账号。
- 调用前先写入 `x-creator-state.json` 和 `x-creator-attempts/<日期>.json`。中断、超时或响应不明确也不在当天自动重试。
- 找不到的账号缓存 30 天；正常返回的账号持久化到 `creators.json`。
- `status.json` 分别报告实际请求数、请求作者数、返回作者数和未找到作者数，不把“候选内容数”当作新增内容或付费请求数。
- 头像下载不调用付费 X API；内容哈希与 `media-map.json` 缓存避免重复上传。

## Skill 来源和读取方式

第一批 allowlist 包含十个已逐项检查的官方目录。采集时先解析仓库当前不可变 Git 提交，再从同一提交读取 `SKILL.md` 与该目录的 `LICENSE.txt`。只有与预期 Apache-2.0 许可一致、元数据有效且通过当前正文指纹审核的条目可以入库。

| 官方来源 | 目录 |
|---|---|
| [Anthropic Skills](https://github.com/anthropics/skills) | `frontend-design`、`algorithmic-art`、`canvas-design`、`webapp-testing`、`mcp-builder`、`theme-factory` |
| [OpenAI Skills](https://github.com/openai/skills) | `pdf`、`playwright`、`jupyter-notebook`、`gh-fix-ci` |

`prompt` 保存完整 `SKILL.md`，包括 frontmatter、代码块和文件引用。`skill` 元数据提供 `name`、`description`、`format: agent-skills`、`entrypoint`、`repository`、`directory`、`installURL`，以及同一不可变提交下该目录的完整相对文件列表 `files`。列表通过公开 GitHub Git Trees 接口取得，包含脚本、模板、字体和参考资料；同一仓库与提交的十个 Skill 共享请求，本轮两个仓库各请求一次。采集器只下载正文与许可，文件列表不表示已下载或运行全部配套文件。`installURL` 指向这个版本的完整目录，便于用户取得配套文件。

目录响应最多 7 MB，必须明确没有被截断。重复路径、路径异常、无法完整枚举的子模块、缺少 `SKILL.md` / `LICENSE.txt` 或超过协议的 200 个文件上限都会使该 Skill 的本次更新失败，保留先前快照；不会只展示文件列表的前一部分。单独解析正文和许可不会伪造“只有两个文件”的包清单。

手机端提供阅读、收藏、复制/分享和源目录入口，不执行这些技能，也不把复制一段文本描述为已经安装了完整 Skill。翻译可以帮助阅读，源文件和可执行标识符保持原样。下载的文件只是内容数据，不作为采集器自身的执行指令。

当前聚合链路已包含 YouMind 的四个公共模型仓库、prompts.chat、X 发现，以及本轮两个官方 Skill 仓库；并非只有 Twitter 一个来源。YouMind 的站内私有 API、内部代码和用户数据不参与该链路。

## 验证

测试覆盖来源账号解析、X 别名与数字 ID 合并、作者 expansion 查询参数、头像失败回退和缓存、付费请求尝试账本与 30 天负缓存、Skill 完整正文与不可变出处、真实目录清单及每提交请求复用、不完整目录拒绝、许可变化拒绝、过期指纹拒绝以及旧 v1 模态兼容。合成测试内容与真实采集内容严格分开；真实内容不进入 Git。

接口依据：[X recent search](https://docs.x.com/x-api/posts/search-recent-posts)、[GitHub Git Trees](https://docs.github.com/en/rest/git/trees#get-a-tree)、[Cloudflare R2 上传](https://developers.cloudflare.com/r2/objects/upload-objects/)。许可依据为上述每个官方 Skill 目录在采集提交中的 `LICENSE.txt`，不根据整个 GitHub 站点或仓库名推断许可。
