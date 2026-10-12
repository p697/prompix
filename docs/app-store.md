# 首版商店与审核准备

更新：2026-10-12。以下文案已随 0.3.0 创作者、Skill 和国际化范围调整，完整内容与最终验收见 acceptance-0.3.md；尚未提交 App Store Connect，也不代表正式发行验收通过。提交前必须复核最终二进制、线上配置和最新编辑内容。

## 商店文案

| 字段 | 简体中文 | English |
|---|---|---|
| 名称 | Prompix | Prompix |
| 副标题 | 发现值得试试的 AI 提示词 | Discover prompts worth trying |
| 推广文本 | 逛一逛，发现 AI 还能这样用。从一句有趣的对话，到一个心动的画面，把灵感收藏起来，变成自己的创作。 | Find a new way to create. Explore text, image, video and website prompts, save your favorites, and make an idea your own. |
| 关键词 | 提示词,灵感,AI,创作,图片,视频,写作,网页,prompt | AI,prompts,inspiration,creative,writing,image,video,website,ideas |
| 分类建议 | 图形与设计；次分类效率 | Graphics & Design; secondary Productivity |
| 支持网址 | https://prompix.dev/zh/support | https://prompix.dev/support |
| 隐私网址 | https://prompix.dev/zh/privacy | https://prompix.dev/privacy |
| 营销网址 | https://prompix.dev/zh | https://prompix.dev |

支持网址提供可直接联系的 `support@prompix.dev`，无需 Prompix 或 GitHub 账号；公开 GitHub issue 作为另一种反馈方式保留。该地址经 Cloudflare Email Routing 转发到项目负责人的既有已验证邮箱。路由与 DNS 已核对，尚未发送测试邮件验证实际投递；支持邮箱不自动代替 App Store Connect 内单独填写的审核联系人。

### 中文描述

给好奇心，留一点地方。

Prompix 是一个原生 iOS Prompt 发现应用。浏览精选的文本、图片、视频和网页灵感，看清示例与来源，找到下一个想试试的创作。

- 轻松发现：按类型浏览，搜索关键词，或从专题里偶遇一个新想法。
- 认识创作者：从真实作者主页继续浏览作品，收藏作者，打开原平台主页。
- 探索技能：阅读官方开放 Skill 的完整说明、文件与来源，带到兼容的编程助手中使用。
- 看见可能：查看图片与图集、播放视频、打开原创交互网页示例。
- 变成自己的：复制完整 Prompt，或编辑后使用；草稿自动保留在设备上。
- 留在手边：收藏喜欢的条目。文字与已保存的缩略图可以离线查看。
- 来源清楚：每条内容展示作者、来源和许可信息，也提供内容反馈入口。

Prompix 不在 App 内生成图片、视频或 AI 回复。复制后可在合适的外部工具中使用；外部工具可能需要账号或付费。不同模型和设置会产生不同结果。首次联网更新后可浏览视频案例；文本、图片与原创网页示例可在首次离线打开时查看。

无需创建 Prompix 账号。原生界面支持英语、简繁中文、日语、韩语、西班牙语、巴西葡萄牙语、法语和德语。内容提供可切换的 AI 译文并保留原文；复制与编辑使用当前语言，不同语言的草稿独立保存。缺失译文时显示原文。Skill 不在手机内安装或执行。

### English description

Make a little room for curiosity.

Prompix is a native iOS home for prompts worth trying. Browse curated text, image, video and website ideas, explore their examples and sources, and find your next creative starting point.

- Discover by format, search by keyword, or explore an editorial collection.
- Explore real creator profiles, browse their collected work, save creators and visit their original platform.
- Read official open-source Skills, inspect their files and source, and take them to compatible coding assistants.
- View images and galleries, play videos, and open original interactive website examples.
- Copy a complete prompt or edit it first. Your drafts stay on your device.
- Save favorites for later. Saved text and successfully stored thumbnails are available offline.
- Check the author, source and license, or report a content issue.

Prompix does not generate images, videos or AI responses inside the app. Use copied prompts in a suitable external tool, which may require its own account or payment. Results vary by model and settings. Video examples become available after the first online update. Original text, image and website examples are available at first launch offline.

No Prompix account is required. The interface supports English, Simplified and Traditional Chinese, Japanese, Korean, Spanish, Brazilian Portuguese, French and German. Switch between available AI translations and the original. Copy and edit the selected language, with separate local drafts. Missing translations fall back to the original. Skills are not installed or executed on the phone.

## 审核说明草稿

No login, purchase or subscription is required. Content updates are delivered from https://api.prompix.dev, with 30 original text, image and website examples available on first launch offline. Video examples require a successful online content update; the Video channel offers a retry action before that update.

Suggested review path:
1. Open Discover and choose Text. Open a prompt, copy it, then choose Edit to change a local draft.
2. Save the prompt and open Favorites. Saved items and drafts persist after relaunch.
3. Choose Image and open a preview. Some community items contain multiple images with native paging and zoom.
4. Choose Video and tap the preview to play. Video playback is user-initiated.
5. Choose Website and open an original example. WebKit is used only for bundled first-party demonstrations; the app interface is native SwiftUI.
6. Open a creator from Discover, browse their work, save the creator and find them again in Favorites.
7. Select Skills to read the complete source instructions and inspect the source files and installation guidance.
8. Use the language menu in a detail to switch between an available translation and the original; edit each independently.
9. Open Settings for support and privacy, or open an item's report link for attribution/content feedback.

An example video stream is available at https://api.prompix.dev/media/de4abcd733bca4bca95cdb6e9e86c6ef8ab4153acf93b1b29bb2784b356838ef.mp4 (the television explainer example). This is a public content file, not a reviewer account or a login bypass.

The app does not submit prompts to AI services automatically. External tool/source links open through the system. The tarot example is an entertainment and self-reflection writing exercise, not a prediction or professional advice service. Content is editorially selected; there is no public in-app posting or messaging.

## 隐私申报依据

`PrivacyInfo.xcprivacy` 随 App 打包。当前无第三方 Swift SDK，无广告标识、跨 App 跟踪或 ATT 请求。tracking domains 为空。0.3.0 使用 UserDefaults 保存最多六条本机最近搜索，按 CA92.1 声明 NSPrivacyAccessedAPICategoryUserDefaults，仅读写 App 自己的数据，不访问其他 App 或系统偏好。依据 [Apple required-reason API 类型与理由](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)。这不是对最终发行二进制的替代检查。

| 数据路径 | 实际行为 | 当前申报处理 |
|---|---|---|
| 搜索／收藏／草稿 | 在设备上检索和存储；没有上传接口 | 不列为收集 |
| 内容与媒体请求 | Cloudflare 处理 IP、请求 URL、时间等网络元数据；Worker 启用 10% 抽样运行日志 | 其他使用数据、性能数据、其他诊断数据；仅 App Functionality |
| 身份关联 | App 无账号或自建用户 ID，但运行元数据在写入日志前没有已验证的匿名化步骤 | 保守声明 linked=true，不宣称日志已匿名化 |
| 跨服务跟踪／广告 | 没有相关功能 | tracking=false，不请求 ATT |
| 内置网页作品 | 本地 WebKit、临时数据存储、CSP 禁止联网 | 无额外服务端收集 |
| 复制／系统分享／外部网页 | 仅用户主动操作；目标服务自行处理 | 不把系统外的第三方行为描述为 Prompix 内建生成 |
| GitHub 支持 | 跳转公开 GitHub 表单，需要用户自行登录并提交 | 公开隐私页解释账号与提交内容的可见性；提交时再次核对 Apple 的可选反馈披露条件 |
| 邮件支持 | 用户主动发邮件至 support@prompix.dev，经 Cloudflare 转发至支持收件箱；邮件服务处理发件地址、正文和附件 | 隐私页说明投递和问题处理用途，不公开发件内容；提交时核对 Apple 对可选支持反馈的披露条件 |

服务器运行日志只能用于交付、安全和故障排查，不用于兴趣画像。上述分类根据实际用途，而不是因为“没有分析 SDK”就选择 Data Not Collected。最终提交时核对 Cloudflare 当前记录字段、留存和安全配置，并按 App Store Connect 实际问卷填写，不能机械复制这份草稿。

依据：[Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)、[Privacy manifests](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)、[Required reason APIs](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)、[Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)。核对日期为 2026-10-12。

## 截图与年龄问卷准备

当前工程同时支持 iPhone 与 iPad。候选素材采用实际运行截图：iPhone 18 Pro 为 1206×2622，13 英寸 iPad 为 2064×2752；每个尺寸 1–10 张 PNG／JPEG，不带 alpha。按当前 [Apple 截图规范](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/) 准备，上传时仍核对 App Store Connect 对所选设备组的要求。新素材必须来自 0.3.0 实际运行与已经校验的内容译文，不再沿用旧版中文内容流截图；不把静态设计稿作为已实现功能。

以下是针对旧 68 条目录的问卷输入准备，不是已提交的年龄结果；本轮扩充后的内容须重新核对，不能沿用旧范围的判断。Apple 按实际问卷计算分级。历史字段草案与依据存于开发机 `~/.local/share/prompix/release-candidate/submission-preparation.json`，最终提交前随最新内容复核。

| 项目 | 当前准备依据 |
|---|---|
| 用户生成内容／社交发现 | 保守按「是」准备：精选并再分发社区创作者的 Prompt 与媒体；无站内发帖或聊天并不自动意味着该项为「否」 |
| 不受限网页访问 | 否：WebKit 只允许内置作品，外链交给系统浏览器 |
| 聊天、广告、博彩、抽奖、战利品箱 | 无；塔罗与周末玩法是无赌注或奖品的写作练习 |
| 酒精、幻想战斗、武器 | 少量：当前示例有酒吧／酒精品牌元素和持剑幻想战斗，没有写实血腥画面 |
| 健康／身心状态话题 | 有轻度情绪整理和自我照顾的文字玩法；不提供诊断或治疗 |
| 成人、性、恐怖、粗俗内容 | 当前审核草案为无；不能用少量截图代替发布前完整内容复核 |

分类依据为 [Apple 年龄定义](https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/) 与 [设置年龄分级](https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/)。实际发行主体、审核联系人姓名／邮箱／电话、发行地区与 EU trader 状态须按账号事实填写，不从 Git 作者或个人设备名称推断。当前免费且无 IAP，不把付费应用税务／收款配置自动作为阻断项；只处理账号中实际出现的必要协议。

## 提交前仍需完成

- 0.2.0 (6) 的开发验收归档、导出 IPA、签名与包内隐私／资源检查已完成；记录见 [交付质量](quality-release.md)。App Store 分发签名、上传校验及平台生成的隐私报告仍待正式提交阶段处理，不能用开发包静态审计代替。
- 真机启动、滚动、内存、视频、后台恢复与离线测试；完成设计／无障碍关口。
- 历史 build 3 的 14 张真实候选截图保存在开发机 `~/.local/share/prompix/release-candidate/screenshots/`；本轮修改了文案和内容，正式上传前须用最终界面重新制作，不能将历史截图标成 build 6。当前功能检查截图不直接视为商店素材。
- 在 App Store Connect 按实际内容完成年龄分级。存在浏览器外链及娱乐反思玩法，不预填未经问卷确认的年龄。
- 确认发行主体、版权年份、审核联系方式、海外发行区域和账号实际要求的协议／合规事项；不把这些账户事项写进开源仓库。
- 复核支持入口响应方式及隐私申报；用户完成最终验收后再提交审核。
