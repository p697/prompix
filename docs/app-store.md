# 首版商店与审核准备

更新：2026-10-12。当前签名候选为 **0.3.2（9）**，原生 iPhone / iPad App，本地归档与IPA审计见[交付记录](quality-release.md)。Granola 方向的此前视觉、旧目录升级与功能检查见 [0.3.1 验收](acceptance-0.3.1.md)。用户尚未验收这次新视觉；本文和准备好的素材不代表用户批准上架，也不代表已上传、提交审核或获得编辑推荐。

## 九语言商店文案

可填写的草稿集中在 [store-metadata.json](store-metadata.json)，包含名称、副标题、推广文本、关键词、完整描述与三个公开网址。内容只介绍实际功能：四类 Prompt、Skills、创作者、收藏、本地草稿、九语言阅读、复制和来源；不承诺 App 内生成、运行 Skill、云同步或每天固定新增数量。

| 商店语言 | 副标题 |
|---|---|
| English (US) | Discover prompts worth trying |
| 简体中文 | 发现值得试试的 AI 提示词 |
| 繁體中文 | 發現值得一試的 AI 提示詞 |
| 日本語 | 試したくなるプロンプトを発見 |
| 한국어 | 써 보고 싶은 프롬프트 발견 |
| Español (España) | Descubre prompts para crear |
| Português (Brasil) | Descubra prompts para criar |
| Français (France) | Des prompts pour vos idées |
| Deutsch | Prompts für deine Ideen |

九份文案已校验名称与副标题不超过 30 字符、推广文本不超过 170 字符、描述不超过 4,000 字符、关键词不超过 100 UTF-8 字节。关键词按逗号分隔、无重复项，每项超过两个字符；未使用其他 App 或公司的名称。描述说明 AI 翻译、原文回退、外部工具可能收费、离线与视频范围。依据 [Apple 版本信息字段](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information/)。这些是可评审草稿，尚未经过各市场母语人员润色，也没有自动写入 App Store Connect。

建议主分类为 Graphics & Design、次分类为 Productivity，最终分类与商店主语言仍待发行配置时确认。首个公开版本不填 “What's New”；该字段用于后续版本更新。预览视频可选，不是首发必须项。

公开官网目前只有英文与简体中文。简繁中文商店草稿均链接到 `/zh`，其余语言链接英文页面；不将九语言 App 误写成九语言支持网站。

| 用途 | English | 简体中文 |
|---|---|---|
| 支持 | https://prompix.dev/support | https://prompix.dev/zh/support |
| 隐私 | https://prompix.dev/privacy | https://prompix.dev/zh/privacy |
| 营销 | https://prompix.dev | https://prompix.dev/zh |

支持入口为 `support@prompix.dev`，无需 Prompix 或 GitHub 账号。该地址经 Cloudflare Email Routing 转发到项目负责人的既有已验证邮箱；路由与 DNS 已核对，实际邮件投递仍未用测试邮件验证。它不能自动代替 App Store Connect 要求的审核联系人姓名、邮箱与国际格式电话。

## 审核说明草稿

以下英文段落可放入 Review Notes；其功能边界与当前代码一致，正式提交时复核线上视频及最终包。无需审核账号。

No login, purchase or subscription is required. Prompix is a curated prompt discovery app. The interface is native SwiftUI. It does not generate AI responses, images or videos, or install or execute Skills. It does not automatically submit prompt text to any AI service.

Content updates come from https://api.prompix.dev. Thirty original text, image and website examples are bundled for first launch offline. Video examples require a successful online content update; the Video channel offers a retry action before that update.

Suggested review path:
1. Open Discover and choose Text. Open a prompt, copy it, and choose Edit to create a local draft.
2. Save it and open Favorites. Favorites and drafts persist after relaunch.
3. Choose Image and open a preview. Some items have multiple images with native paging and zoom.
4. Choose Video and tap a preview. Playback is user-initiated.
5. Choose Website and open an original example. WebKit only displays bundled first-party demonstrations; external links open through the system.
6. Open a creator from Discover, browse collected works, save the creator and find them in Favorites.
7. Select Skills to read source instructions, files and usage guidance.
8. Switch a detail between an available AI translation and the original. Copy and edit use the selected language; each language has its own local draft.
9. Open Settings for support and privacy, or an item's report link for content feedback.

Public video test stream: https://api.prompix.dev/media/de4abcd733bca4bca95cdb6e9e86c6ef8ab4153acf93b1b29bb2784b356838ef.mp4

Content is editorially selected from allowlisted sources and published as a reviewed catalog. There is no public in-app posting, messaging, comments or public user profile. Creator profiles identify the original external authors. Tarot and astrology prompts are entertainment and self-reflection writing exercises, not a prediction, gambling or professional advice service. Original sources and a private email report option are available.

## 隐私申报依据

`ios/Prompix/Resources/PrivacyInfo.xcprivacy` 随 App 打包。当前无第三方 Swift SDK、广告标识、跨 App 跟踪或 ATT 请求；tracking domains 为空。UserDefaults 保存 App 自己的偏好及最多六条本机最近搜索，声明 `NSPrivacyAccessedAPICategoryUserDefaults` / `CA92.1`。这份源文件审计不能代替最终分发包的隐私报告。

| 数据路径 | 已确认的代码行为 | 当前申报处理 |
|---|---|---|
| 搜索、内容与作者收藏、草稿 | 在设备上检索和存储；无上传接口 | 不列为收集；设备备份另由 iOS 设置管理 |
| 目录与媒体请求 | Cloudflare 接收 IP、请求 URL、时间等交付元数据；内容 Worker 开启 10% 抽样运行日志 | manifest 声明 Other Usage Data、Performance Data、Other Diagnostic Data，目的仅 App Functionality |
| 身份关联 | 无 App 账号或自建用户 ID；未验证服务日志写入前匿名化 | manifest 保守声明 linked=true；不声称日志匿名 |
| 广告与跨服务跟踪 | 没有相关功能 | tracking=false |
| 内置网页 | 本地 WebKit、非持久数据存储，CSP 禁止联网 | 不增加服务端收集 |
| 复制、分享、外部工具 | 仅用户主动操作；不自动传递 Prompt | 对外部工具的账号及处理方式作清楚说明 |
| GitHub 支持 | 用户主动打开并提交公开 issue | 隐私页说明公开可见性；最终核对 Apple 可选反馈披露条件 |
| 邮件支持 | 发件地址、正文和附件经路由进入支持收件箱 | 用于响应与调查请求；不公开发布；最终核对可选反馈披露条件 |

### 日志与保留范围

- `services/content/wrangler.jsonc` 明确开启 `observability.enabled`、`head_sampling_rate: 0.1`。默认 invocation logs 包含请求、响应及执行上下文；业务代码唯一自定义错误日志是 `content_read_failed` 与对象 key，没有自行记录搜索词、草稿、收藏或请求头。
- Cloudflare 官方 Workers Logs 文档在本次核对时列出 Free 保留 3 天、Paid 保留 7 天，最大 7 天。尚未核实本账号套餐；可以将“最多 7 天”准确限定到内容服务的标准 Workers Logs。此期限不涵盖 Cloudflare 自身网络安全数据、独立导出副本或支持邮箱。仓库未配置 Logpush、Tail Worker 或其他日志导出，但账户侧配置仍须发行时核对。[Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- `services/site/wrangler.jsonc` 是静态资源站点，没有启用上述 Worker 日志配置。这不等于 Cloudflare 不处理网站网络元数据。
- 支持邮件按处理请求及相关跟进的需要保留；用户可请求删除，仍需履行的法定义务或未解决争议除外。没有已验证的固定周期自动删除规则，不能承诺“30 天自动清空”。网站源码的保留与删除段落应与实际执行一致，部署后再核对公开页面。

[Apple 隐私政策要求](https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage)涵盖收集、用途、分享与保留／删除方式。[App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)以实际离机处理为依据；没有分析 SDK 不等于 Data Not Collected。可选支持反馈只有满足 Apple 全部条件才可不披露，不能只因“用户主动发邮件”自动排除。发行前核对最终分发包、线上配置和 App Store Connect 问卷。[Privacy manifests](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)、[Required reason APIs](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)

## 截图与演示

已有构建8商店候选材料和`~/.local/share/prompix/granola-redesign/demo/index.html`保留为历史证据，画面使用345条目录，不能标成346条或最终构建。当前0.3.2演示位于`~/.local/share/prompix/native-language-downloads/demo/index.html`，包含真实升级首页以及最终日语详情、编辑器共3张模拟器截图；这是截图浏览页，不是可交互App。正式提交前须从最终构建重新拍摄所需设备与语言的商店截图，不把历史材料重新标注成最终版本。

工程同时支持 iPhone 与 iPad。商店拟用 iPhone 1206×2622 与 13 英寸 iPad 2064×2752 的真实截图；每个所需设备组 1–10 张 RGB PNG / JPEG、不带 alpha。应检查实际最终文件、设备比例、语言、内容及顺序，不将测试通过或图库演示直接写成“商店素材已上传”。详细素材与二进制进度统一记在 [交付质量](quality-release.md)。规范依据：[Apple 截图要求](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)。

建议顺序为发现、创作者、内容详情、编辑、Skills、收藏。核心价值在前三张体现，不使用“编辑推荐”等未经获得的标识，不复用 Granola 品牌资产或静态概念图冒充 App。

## 当前目录的年龄问卷依据

旧 68 条目录的问卷草案已失效。2026-10-12 本次检查固定到 `edition-f0aceae77aac3663`，346 条（201 图片、96 普通文本、33 视频、6 网页、10 Skills），目录 SHA-256 为 `6e0cb598a346a683898a797452c3a04af3fe6a86ec0e9bf5fd35ea09a8e0409f`。每日采集会继续更新；提交前必须针对那时的目录重核。

第三方正文、命中上下文与媒体地址仅保存在开发机：

- 当前目录：`~/.local/share/prompix/release-readiness-8/production-catalog.json`。
- 预筛报告：`~/.local/share/prompix/release-readiness/age-rating-audit-0.3.1.json`。
- 语义复核说明：`~/.local/share/prompix/release-readiness/age-rating-review-notes.md`。
- 媒体逐项记录：`~/.local/share/prompix/release-readiness/age-rating-media-review-0.3.1.json`，含每条 ID、文件路径、SHA-256、来源对应方式与实际观察。

此次对全部 346 条的原始及展示文字、所有译文字段和 Skill 信息进行中英文词汇预筛，浏览标题索引并复核命中上下文，另完整阅读新增条目的原文。55 条有词汇命中，含否定指令、颜色名、衣服和机器人部位等误报；匹配数不是问卷频次。

随后实际查看 **37 张高信号及对照图片**（全部 36 个命中图片条目，加一条泳装），并查看 **全部 33 条视频共 233 个代表帧**：每条 5、8 或 12 帧。媒体由既有本地采集缓存对应线上目录，没有新增远程下载；25 条视频的源文件／原采样记录 SHA-256 与发布文件名相同，其余 8 条通过原始 URL 的发布映射对应。33 条的视频探测均无音轨。源图转码前后的分辨率或编码可能不同，逐项记录保留对应依据。

**此轮高信号媒体复核已完成；覆盖范围不是全部 201 条图片或所有图集附图，也不是视频连续播放或九语言逐字审核。** 代表帧之间的瞬间不能据此排除。下表是当前固定目录的问卷准备描述，频次建议仍须与正式问卷和最终发布目录对应，不是 Apple 分级结果。

| 问卷主题 | 已有证据及剩余工作 |
|---|---|
| 武器、暴力、血迹 | 图片已确认动漫对打、持剑人物，以及写实风格的僵尸战场、面部／衣物／武器血迹。武器、幻想暴力及写实暴力按“存在、少量”准备；所看媒体未见断肢、内脏或持续施虐，不因题材虚构就把写实暴力填“无” |
| 恐怖／恐惧 | 实际图像确认吸血鬼嘴角血、骷髅、幽灵与暗黑猎犬；视频含怪物巴士等短暂奇幻形象。按“存在、少量”准备 |
| 酒精、烟草、药物 | 已看到鸡尾酒、红酒杯、啤酒品牌及酒字招牌，按酒精引用“存在、少量”准备；所看媒体未见烟草／非法药物，睡衣的 champagne 只是颜色 |
| 成熟、暗示性、裸体 | 已看到低胸／身体强调构图及私密氛围自拍，成熟或暗示主题按“存在、少量”准备。另核对普通连体泳衣、舞蹈服装和露肩时装，不把它们直接算裸体；所看媒体未见私密部位裸露或性行为。机器人胸部与人像裁切词为误报 |
| 健康／身心主题 | 存在情绪反思和饮食话题。实际营养信息图还出现药物相互作用与健康状况提示，因此医学信息引用按“存在、少量”准备，不能只归为生活反思；本次没有验证图中医学主张的正确性 |
| 博彩／抽奖 | App 没有下注、奖金、抽奖或战利品箱机制。塔罗、星盘和随机周末写作题不能仅因词名判成赌博 |
| 粗俗语言 | 词表与已看媒体文字未发现粗俗用语；有善意吐槽和轻喜剧。全部视频无音轨，仍不把文字预筛说成九语言逐字审核 |
| 网页访问、聊天、广告 | WebKit 只显示内置作品，外链经系统打开；无站内聊天或广告。问卷按实际能力填写 |
| UGC／社交发现 | 本产品是编辑筛选的外部内容聚合，无站内用户投稿、评论、消息或公开用户账号。Apple 的宽泛分发／社交发现定义与此模式有交集，但不能从“来源是 X”直接推定全部社交要求，也不能从“无发帖”直接断言不适用。正式问卷与审核说明应如实解释流程，必要时由 App Review 明确分类 |

不在准备文档中预定 4+、9+、13+ 或其他年龄。依据 [Apple 年龄描述定义](https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/)、[年龄问卷操作](https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/)。内容分类问卷与 [审核指南 1.2](https://developer.apple.com/app-store/review/guidelines/#user-generated-content) 的适用性分别核对；本次没有把屏蔽创作者等功能认定为必须新增的条件，也没有据此自动删减内容。

## 剩余准备与需要真实信息的项目

可自主继续完成：最终截图整理、发布前目录增量及未覆盖媒体复核、商店语言润色、公开支持和隐私入口检查、最终分发包的签名／隐私资源核对、正式上传前校验。模拟器与本机证据不能代替尚未完成的真机性能或用户视觉验收；不为了准备材料反复安装用户手机。

发行阶段才集中确认以下真实信息，不从 Git 作者、设备名或域名持有人推断：

1. 用户对 0.3.1 新视觉与产品的验收，以及是否正式提交审核。
2. Apple Developer 账号中的发行主体、版权权利人及年份、可响应的审核联系人姓名／邮箱／国际电话。
3. 最终发行地区、商店主语言与分类；EU trader 状态依据实际经营事实填写，不能因免费就自动选择 non-trader。若选择欧盟并属于 trader，按账号要求提供／验证联系方式及所需资料。[Apple EU trader 要求](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/)
4. 账号实际提示的协议或资料缺口。没有 IAP 不意味着任意账户合规字段都可跳过，也不提前假设全部收费产品收款手续是本 App 阻断项。

审核联系方式、法律主体材料、账号信息与任何密钥不进入此公开仓库。具体剩余关口和完成证据以 [交付质量](quality-release.md) 为准；用户完成最终验收后再提交审核。
