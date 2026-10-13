# 首版商店与审核准备

更新：2026-10-13。当前本地签名候选为 **0.4.7（20）**，使用 iOS 27.1 RC SDK；归档、开发安装包和 App Store 分发包的核对见[当前发行记录](release-0.4.7.md)。最新用户手机阶段包仍为 **0.4.6（17）**，本轮没有重新安装。Duo 模拟器候选的实际范围与拼音跨屏限制见 [Duo 验收](iphone-duo.md)。本文和本地材料不代表用户批准上架，也不代表二进制已上传、通过 Apple 服务端验证、提交审核或获得编辑推荐。

## App Store Connect 草稿

2026-10-13已在现有开发者账号创建[Prompix商店记录](https://appstoreconnect.apple.com/apps/6822283489/distribution)，Apple ID为`6822283489`，沿用`com.p697.prompix`，SKU为`prompix-ios`。版本为0.4.7、状态为“准备提交”，主语言英语（美国），主分类图形和设计、次分类效率。已保存英文和简体中文的名称、副标题、推广文本、描述、关键词、支持与营销网址；版本采用手动发布，审核说明已保存并取消“需要登录”。

随后补齐繁体中文、日语、韩语、西班牙语（西班牙）、葡萄牙语（巴西）、法语和德语；九语名称、副标题、推广文本、描述、关键词、支持与营销网址均已保存。隐私网址也已按九语保存：简繁中文指向现有简中页面，其余指向英文页面。离开页面并重新加载后，逐语言回读上述八个字段，全部与仓库原稿一致。截图与逐字段证据保存在开发机外置盘 `Prompix-Codex/Evidence/app-store-draft-20261013/nine-locale-readback.json` 和 `nine-locale-privacy-proof.jpg`。

英文和中文隐私页已通过普通Chrome实际打开并读取正文，独立curl请求也均返回HTTP 200及正确语言的页面。先前单独的Python HTTP请求返回403，网页提取工具不可用；保留这些结果，不推断所有自动审核抓取均通过。隐私收集问卷的六类数据及用途、身份关联、跟踪选项已保存为草稿并在刷新后回读；尚未点“发布”。年龄分级、版权、联系人、发行地区、最终截图及构建版本仍未完成。没有填写无法由项目事实证明的主体资料。

页面已有非交易商声明提示，这是账号／新App的既有状态，本轮未修改，也未验证其法律事实；不将它当作发行地区已确认。商店记录和文案保存不等于二进制上传、TestFlight可用、正式提交审核或公开上架。

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

九份文案已校验名称与副标题不超过 30 字符、推广文本不超过 170 字符、描述不超过 4,000 字符、关键词不超过 100 UTF-8 字节。关键词按逗号分隔、无重复项，每项超过两个字符；未使用其他 App 或公司的名称。描述说明 AI 翻译、原文回退、外部工具可能收费、离线与视频范围。依据 [Apple 版本信息字段](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information/)。九语文案均已保存到App Store Connect草稿；尚未经过各市场母语人员润色，不代表内容库九语全文覆盖或正式上架完成。

商店草稿已采用主分类 Graphics & Design、次分类 Productivity，主语言为英语（美国）。首个公开版本不填 “What's New”；该字段用于后续版本更新。预览视频可选，不是首发必须项。

公开官网目前只有英文与简体中文。简繁中文商店草稿均链接到 `/zh`，其余语言链接英文页面；不将九语言 App 误写成九语言支持网站。

| 用途 | English | 简体中文 |
|---|---|---|
| 支持 | https://prompix.dev/support | https://prompix.dev/zh/support |
| 隐私 | https://prompix.dev/privacy | https://prompix.dev/zh/privacy |
| 营销 | https://prompix.dev | https://prompix.dev/zh |

支持入口为 `support@prompix.dev`，无需 Prompix 或 GitHub 账号。该地址经 Cloudflare Email Routing 转发到项目负责人的既有已验证邮箱；路由与 DNS 已核对，实际邮件投递仍未用测试邮件验证。它不能自动代替 App Store Connect 要求的审核联系人姓名、邮箱与国际格式电话。

## 历史 App Store 分发包（0.3.2）

2026-10-12 从既有 0.3.2（9）归档成功导出 App Store Connect 分发 IPA，未重新编译或更改版本号。导出选项为 `method=app-store-connect`、`destination=export`、`manageAppVersionAndBuildNumber=false`，使用 Cloud Managed Apple Distribution 签名。该操作只生成本地包，不上传或提交审核；Apple 将这种导出与上传明确区分，见[分发导出说明](https://help.apple.com/xcode/mac/current/en.lproj/dev23ea8b877.html)。

独立于导出命令的本地检查共24项通过：严格签名有效，分发描述文件不含登记设备名单、非企业配置，调试权限关闭，应用标识与证书匹配；27份资源与已审归档逐字节一致，Info.plist全部字段相同（仅二进制序列化变化），可执行文件与归档及调试符号的UUID一致。隐私清单与此前审计相同，声明不跟踪，且没有测试包或测试视频。上传调试符号已启用，未限制为仅内部TestFlight。

本机证据位于 `~/.local/share/prompix/release-candidate-9/`：`app-store-export/Prompix.ipa`、`app-store-export.log`、`ExportOptions-AppStore.plist`、`app-store-export-audit.json`。IPA为8,461,857字节，SHA-256为`2722ce7d74ee13042242ea93f63cf2f9fec06eb8e8b857bcebc541fade395c1b`。原开发验收IPA保持不变。此分发IPA用于后续商店上传，不能用作登记手机的开发安装包；本地导出和签名审计也不等于Apple服务端上传校验、TestFlight可用或审核通过。

## 审核说明草稿

以下英文段落可放入 Review Notes；其功能边界与当前代码一致，正式提交时复核线上视频及最终包。无需审核账号。

No login, purchase or subscription is required. Prompix is a curated prompt discovery app. The interface is native SwiftUI. It does not generate AI responses, images or videos, or install or execute Skills. It does not automatically submit prompt text to any AI service.

Content updates come from https://api.prompix.dev. Thirty original text, image and website examples are bundled for first launch offline. Video examples require a successful online content update; the Video channel offers a retry action before that update.

Suggested review path:
1. Open Discover and choose Text. Open a prompt, copy it, and choose Edit to create a local draft.
2. Save it and open Favorites. Favorites and drafts persist after relaunch.
3. Choose Image and open a preview. Some items have multiple images with native paging and zoom.
4. Choose Video and tap a preview. Playback is user-initiated.
5. Choose Website and open an example. WebKit displays bundled first-party demonstrations; the reviewed community website example opens in the system browser.
6. Open a creator from Discover, browse collected works, save the creator and find them in Favorites.
7. Choose Use Prompt to edit the current text, optionally fill recognized variables, copy or share it, and open a suitable external tool. Only documented tool links prefill text; Prompix never sends it automatically. Skills show pinned source files and, where supported, an installation command for a compatible external coding assistant. Prompix does not execute that command.
8. Switch a detail between an available AI translation and the original. Copy and edit use the selected language; each language has its own local draft.
9. Open Settings for support and privacy, or an item's report link for content feedback.

On iPhone Duo with iOS 27.1, open and close the device while browsing. Expanded media details place reading and the preview side by side. The current candidate preserves the text buffer, but uncommitted Pinyin candidates may end when switching displays; this limitation remains under investigation. Simulator records do not establish physical-device performance.

Public video test stream: https://api.prompix.dev/media/de4abcd733bca4bca95cdb6e9e86c6ef8ab4153acf93b1b29bb2784b356838ef.mp4

Content is editorially selected from allowlisted sources and published as a reviewed catalog. There is no public in-app posting, messaging, comments or public user profile. Creator profiles identify the original external authors. Tarot and astrology prompts are entertainment and self-reflection writing exercises, not a prediction, gambling or professional advice service. Original sources and a private email report option are available.

## 隐私申报依据

`ios/Prompix/Resources/PrivacyInfo.xcprivacy` 随 App 打包。当前无第三方 Swift SDK、广告标识、跨 App 跟踪或 ATT 请求；tracking domains 为空。UserDefaults 保存 App 自己的偏好及最多六条本机最近搜索，声明 `NSPrivacyAccessedAPICategoryUserDefaults` / `CA92.1`。这份源文件审计不能代替最终分发包的隐私报告。

| 数据路径 | 已确认的代码行为 | 当前申报处理 |
|---|---|---|
| 搜索、内容与作者收藏、草稿 | 在设备上检索和存储；无上传接口 | 不列为收集；设备备份另由 iOS 设置管理 |
| 目录与媒体请求 | Cloudflare 接收 IP、请求 URL、时间等交付元数据；内容 Worker 开启 10% 抽样运行日志 | manifest 声明 Other Usage Data、Performance Data、Other Diagnostic Data，目的仅 App Functionality |
| IP 推断地区 | 已存日志包含非空国家、城市、地区及 IP 推断经纬度；App 无设备定位请求 | 新增 Coarse Location，目的 App Functionality；不能把 IP 估计当作设备精确定位 |
| 身份关联 | 无 App 账号或自建用户 ID；未验证服务日志写入前匿名化 | manifest 保守声明 linked=true；不声称日志匿名 |
| 广告与跨服务跟踪 | 没有相关功能 | tracking=false |
| 内置网页 | 本地 WebKit、非持久数据存储，CSP 禁止联网 | 不增加服务端收集 |
| 复制、分享、外部工具 | 用户主动打开支持预填的工具时会传递准备文字；Claude Code 使用 URL 查询参数，Lovable 使用片段参数，不自动确认发送 | 不能承诺目标服务在发送前收不到文字；隐私页明确外部处理边界 |
| GitHub 支持 | 用户主动打开并提交公开 issue，账号名与反馈公开可见 | 纳入 Customer Support，目的 App Functionality；不默认依赖可选披露豁免 |
| 邮件支持 | 发件地址、正文和附件经路由进入支持收件箱 | 纳入 Email Address 与 Customer Support，目的 App Functionality；用于响应与调查，不公开发布 |

2026-10-13 晚完成线上只读核对后，App Store Connect 草稿共六项：Email Address、Coarse Location、Customer Support、Other Usage Data、Performance Data、Other Diagnostic Data。六项均仅用于 App Functionality、关联用户身份、不用于跟踪。保存后重新加载页面，六项、六个用途和六个身份关联摘要均保留，产品页面预览未出现跟踪类别。未发布问卷、上传二进制或提交审核。

源码隐私清单同步增加地区和支持三项；**已交付的 build 20 和两个签名 IPA 保持不变，仍含旧三项清单**。下一候选归档必须纳入新资源并重新核对，不能将现有 IPA 当作申报已同步的最终上架包。此次只修改声明与说明，没有增加收集行为、定位权限或 SDK。

支持流程跳转到外部邮箱／GitHub，无法证明满足 Apple 可选披露要求中的全部界面条件，因此草稿主动披露支持类型；不因用户可能在自由文本里提到任意个人资料而加入所有敏感类别。依据 [Apple Optional disclosure](https://developer.apple.com/app-store/app-privacy-details/#optional-disclosure)、[清单数据类型](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype)。保存草稿与最终发布是不同步骤，见 [Apple 问卷操作](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/)。

### 日志与保留范围

- `services/content/wrangler.jsonc` 明确开启 `observability.enabled`、`head_sampling_rate: 0.1`。默认 invocation logs 包含请求、响应及执行上下文；业务代码唯一自定义错误日志是 `content_read_failed` 与对象 key，没有自行记录搜索词、草稿、收藏或请求头。
- Cloudflare 官方 Workers Logs 文档在本次核对时列出 Free 保留 3 天、Paid 保留 7 天，最大 7 天。尚未核实本账号套餐；可以将“最多 7 天”准确限定到内容服务的标准 Workers Logs。此期限不涵盖 Cloudflare 自身网络安全数据、独立导出副本或支持邮箱。仓库未配置 Logpush、Tail Worker 或其他日志导出，但账户侧配置仍须发行时核对。[Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- `services/site/wrangler.jsonc` 是静态资源站点，没有启用上述 Worker 日志配置。这不等于 Cloudflare 不处理网站网络元数据。
- 2026-10-13 线上 `prompix-content` 设置核对：日志启用且持久保存、采样0.1、invocation logs启用、traces关闭、查询参数不脱敏；没有Tail消费者、实时Tail会话、Worker Logpush，账号和本站zone的Logpush任务列表均为空。近24小时该Worker的5条已存事件验证了请求IP、URL、地区字段及CPU／墙钟耗时非空；证据只保留字段名、类型和非空标志，不保存实际访客IP、位置、请求头或日志内容。这个范围不涵盖Cloudflare自身安全处理、其他历史导出或邮箱保留。IP地区是估计值，依据 [Cloudflare说明](https://developers.cloudflare.com/network/ip-geolocation/)。证据位于外置盘 `Prompix-Codex/Evidence/privacy-draft-20261013/`，含配置、字段核验、ASC回读与草稿截图。
- 支持邮件按处理请求及相关跟进的需要保留；用户可请求删除，仍需履行的法定义务或未解决争议除外。没有已验证的固定周期自动删除规则，不能承诺“30 天自动清空”。网站源码的保留与删除段落应与实际执行一致，部署后再核对公开页面。

[Apple 隐私政策要求](https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage)涵盖收集、用途、分享与保留／删除方式。[App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)以实际离机处理为依据；没有分析 SDK 不等于 Data Not Collected。可选支持反馈只有满足 Apple 全部条件才可不披露，不能只因“用户主动发邮件”自动排除。发行前核对最终分发包、线上配置和 App Store Connect 问卷。[Privacy manifests](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)、[Required reason APIs](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)

## 截图与演示

已有构建8商店候选材料和`~/.local/share/prompix/granola-redesign/demo/index.html`保留为历史证据，画面使用345条目录，不能标成346条或最终构建。当前0.3.2演示位于`~/.local/share/prompix/native-language-downloads/demo/index.html`，包含4张真实模拟器截图：此前352条版的首页与修正译文后的日语详情、346条阶段的创作者主页，以及`edition-v2-b740a025a93331a3`的中文社区网页详情`website-detail.png`。各画面的来源分别保留，不能因两版均为352条而混同。新增网页的分类数量7、详情和点击后由iOS Safari打开托管作品已实际验证，证据为`~/.local/share/prompix/native-web-quality-9/ui-evidence.json`；该检查不代表全部原生界面或九语言UI复验。

演示另含约53秒真实模拟器操作录屏，固定到此前352条版`edition-v2-e1db02bde684049f`，展示发现页、创作者主页、视频详情与原生播放。成片保存为`~/.local/share/prompix/native-walkthrough-9/creators-and-video-30fps.mp4`，同目录`evidence.json`记录SHA-256及范围；演示目录副本名为`walkthrough.mp4`。成片时长52.83秒，仅做H.264／30fps兼容转码，没有重排操作或加入模拟功能画面。本轮未操作用户手机。这个截图与录像浏览页不是可交互App，也不代表全App验收、源视频连续语义审核或商店预览已完成。正式提交前须从最终构建重新拍摄所需设备与语言的商店截图，不把历史材料重新标注成最终版本。

工程同时支持 iPhone 与 iPad。商店拟用 iPhone 1206×2622 与 13 英寸 iPad 2064×2752 的真实截图；每个所需设备组 1–10 张 RGB PNG / JPEG、不带 alpha。应检查实际最终文件、设备比例、语言、内容及顺序，不将测试通过或图库演示直接写成“商店素材已上传”。详细素材与二进制进度统一记在 [交付质量](quality-release.md)。规范依据：[Apple 截图要求](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)。

建议顺序为发现、创作者、内容详情、编辑、Skills、收藏。核心价值在前三张体现，不使用“编辑推荐”等未经获得的标识，不复用 Granola 品牌资产或静态概念图冒充 App。

## 当前目录的年龄问卷依据

旧 68 条目录的问卷草案已失效。2026-10-12 的346条基线检查固定到 `edition-f0aceae77aac3663`（201 图片、96 普通文本、33 视频、6 网页、10 Skills），目录 SHA-256 为 `6e0cb598a346a683898a797452c3a04af3fe6a86ec0e9bf5fd35ea09a8e0409f`。其后的两轮增量审读分别记录如下；提交前仍须针对那时的目录重核。

第三方正文、命中上下文与媒体地址仅保存在开发机：

- 346条基线目录：`~/.local/share/prompix/release-readiness-8/production-catalog.json`。
- 预筛报告：`~/.local/share/prompix/release-readiness/age-rating-audit-0.3.1.json`。
- 语义复核说明：`~/.local/share/prompix/release-readiness/age-rating-review-notes.md`。
- 媒体逐项记录：`~/.local/share/prompix/release-readiness/age-rating-media-review-0.3.1.json`，含每条 ID、文件路径、SHA-256、来源对应方式与实际观察。

基线检查对全部 346 条的原始及展示文字、所有译文字段和 Skill 信息进行中英文词汇预筛，浏览标题索引并复核命中上下文，另完整阅读新增条目的原文。55 条有词汇命中，含否定指令、颜色名、衣服和机器人部位等误报；匹配数不是问卷频次。

随后实际查看 **37 张高信号及对照图片**（全部 36 个命中图片条目，加一条泳装），并查看 **全部 33 条视频共 233 个代表帧**：每条 5、8 或 12 帧。媒体由既有本地采集缓存对应线上目录，没有新增远程下载；25 条视频的源文件／原采样记录 SHA-256 与发布文件名相同，其余 8 条通过原始 URL 的发布映射对应。33 条的视频探测均无音轨。源图转码前后的分辨率或编码可能不同，逐项记录保留对应依据。

**基线高信号媒体复核已完成；覆盖范围不是全部 201 条图片或所有图集附图，也不是视频连续播放或九语言逐字审核。** 代表帧之间的瞬间不能据此排除。

同日对352条版`edition-v2-e1db02bde684049f`完成相对346条基线的增量审读：阅读新增6条原文及54份翻译记录，实际查看3张新增发布图片，并以目录语义相等校验复用已审读的49个翻译prompt修正。其余变化为11个法语example尾随空格、95条来源revision及排列顺序；保留条目的原文与媒体未变。本轮未观察到新的年龄问卷内容类别，已明确记录滑板图中的非性化赤裸上身运动场景。证据在`~/.local/share/prompix/release-readiness-9/incremental-content-audit-0.3.2-9.json`及同目录审读说明；结论仅覆盖该版增量，不代表全部352条、全部媒体或九语言全库逐句复核。

随后发布的`edition-v2-b740a025a93331a3`仍为352条：因字母／动物对应错误暂缓发现目录中的动物字母海报，新增一条prompts.chat社区网页Prompt及原创Outline演示，其余351条逐项保持不变，移除墓碑没有变化。质量暂缓不作为删除用户收藏或草稿的指令。新增条目的英文原文及八种译文已逐项审读，22处译文字段经有记录的授权Agent逐项校正；托管作品已完成桌面与移动端真实交互、HTML及预览图哈希核对。本轮未观察到新的年龄问卷内容类别。作品及发布证据为`~/.local/share/prompix/web-community-review/artifact.json`；中文原生详情与Safari打开证据另存于`native-web-quality-9/ui-evidence.json`。这次单条网页检查不扩展此前图片、视频或全库语言审读的覆盖范围。

2026-10-13 对当前527条版 `edition-v2-3f5988eec9fb6296` 完成相对352条基线的有界增量审查。目录SHA-256为 `90be1987c2de6a6a5666e1bfe2e689aee74da98fd871ab4bb3665bced0b2a1e7`：新增175条、删除0条，原有352条正文、翻译和媒体未变；81条更新来源定位信息，一位既有作者增加头像。新增175条原文全部有全文审读依据，其中62条经精确字段匹配复用先前审读、113条本次新读；不把结构校验或抽检当作所有译文审读。

实际查看新增作品的55张发布图片（含图库附图及视频封面）和9个视频的108个代表帧。64个已发布文件共62,877,903字节，全部与冻结目录的SHA-256一致。小乌龟视频的原文及2.699、26.989、29.500秒代表帧确认长烟斗与烟雾，因此当前目录不能再写“未见烟草”。9个新视频全部有音轨且本轮尚未审听；旧33个无音轨结论只属于旧基线。

私有证据在外置盘 `Prompix-Codex/Evidence/release-content-527-20261013/`，主报告为 `age-rating-delta-527.json`，逐项观察为 `media-age-delta-review.json`。剩余范围包括旧203条图片中的164条未逐图审读作品及旧附图、代表帧之间的内容、9个新视频音轨、新增全语种译文、头像和外链／Skill引用文件。这个增量报告不代表527条全媒体、全语言已经通过发行审查，也不确定或提交年龄等级。

下表汇总固定基线及上述增量观察，频次建议仍须与正式问卷和最终发布目录对应，不是 Apple 分级结果。

| 问卷主题 | 已有证据及剩余工作 |
|---|---|
| 武器、暴力、血迹 | 图片已确认动漫对打、持剑人物，以及写实风格的僵尸战场、面部／衣物／武器血迹。武器、幻想暴力及写实暴力按“存在、少量”准备；所看媒体未见断肢、内脏或持续施虐，不因题材虚构就把写实暴力填“无” |
| 恐怖／恐惧 | 实际图像确认吸血鬼嘴角血、骷髅、幽灵与暗黑猎犬；视频含怪物巴士等短暂奇幻形象。按“存在、少量”准备 |
| 酒精、烟草、药物 | 已看到鸡尾酒、红酒杯、啤酒品牌及酒字招牌，旧基线按酒精引用“存在、少量”准备；527条增量已确认视频吸烟，须在同一个酒精／烟草／药物描述项纳入烟草依据，提交时复核频次。所看媒体未见非法药物，睡衣的 champagne 只是颜色 |
| 成熟、暗示性、裸体 | 已看到低胸／身体强调构图及私密氛围自拍，成熟或暗示主题按“存在、少量”准备。另核对普通连体泳衣、舞蹈服装、露肩时装及新增滑板图的非性化赤裸上身运动场景；所看媒体未见私密部位裸露或性行为。机器人胸部与人像裁切词为误报 |
| 健康／身心主题 | 存在情绪反思和饮食话题。实际营养信息图还出现药物相互作用与健康状况提示，因此医学信息引用按“存在、少量”准备，不能只归为生活反思；本次没有验证图中医学主张的正确性 |
| 博彩／抽奖 | App 没有下注、奖金、抽奖或战利品箱机制。塔罗、星盘和随机周末写作题不能仅因词名判成赌博 |
| 粗俗语言 | 词表与已看媒体文字未发现粗俗用语；有善意吐槽和轻喜剧。旧33个视频无音轨，新9个视频均有音轨且未审听；仍不把文字预筛说成九语言逐字审核 |
| 网页访问、聊天、广告 | WebKit 只显示内置作品，外链经系统打开；无站内聊天或广告。问卷按实际能力填写 |
| UGC／社交发现 | 本产品是编辑筛选的外部内容聚合，无站内用户投稿、评论、消息或公开用户账号。Apple 的宽泛分发／社交发现定义与此模式有交集，但不能从“来源是 X”直接推定全部社交要求，也不能从“无发帖”直接断言不适用。正式问卷与审核说明应如实解释流程，必要时由 App Review 明确分类 |

不在准备文档中预定 4+、9+、13+ 或其他年龄。依据 [Apple 年龄描述定义](https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/)、[年龄问卷操作](https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/)。内容分类问卷与 [审核指南 1.2](https://developer.apple.com/app-store/review/guidelines/#user-generated-content) 的适用性分别核对；本次没有把屏蔽创作者等功能认定为必须新增的条件，也没有据此自动删减内容。

## 剩余准备与需要真实信息的项目

可自主继续完成：最终截图整理、发布前目录增量及未覆盖媒体复核、商店语言润色、公开支持和隐私入口检查、最终分发包的签名／隐私资源核对、正式上传前校验。模拟器与本机证据不能代替尚未完成的真机性能或用户视觉验收；不为了准备材料反复安装用户手机。

发行阶段才集中确认以下真实信息，不从 Git 作者、设备名或域名持有人推断：

1. 用户对当前 0.4.7 产品、Duo 实际演示及已知限制的验收，以及是否正式提交审核。
2. Apple Developer 账号中的发行主体、版权权利人及年份、可响应的审核联系人姓名／邮箱／国际电话。
3. 最终发行地区及现有商店主语言／分类是否调整；EU trader 状态依据实际经营事实填写，不能因免费就自动选择 non-trader。若选择欧盟并属于 trader，按账号要求提供／验证联系方式及所需资料。[Apple EU trader 要求](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/)
4. 账号实际提示的协议或资料缺口。没有 IAP 不意味着任意账户合规字段都可跳过，也不提前假设全部收费产品收款手续是本 App 阻断项。

审核联系方式、法律主体材料、账号信息与任何密钥不进入此公开仓库。具体剩余关口和完成证据以 [交付质量](quality-release.md) 为准；用户完成最终验收后再提交审核。
