# 首版商店与审核准备

更新：2026-10-12。文案与申报依据已准备；尚未提交 App Store Connect，也不代表正式发行验收通过。提交前必须复核最终二进制、线上配置和最新编辑内容。

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

### 中文描述

给好奇心，留一点地方。

Prompix 是一个原生 iOS Prompt 发现应用。浏览精选的文本、图片、视频和网页灵感，看清示例与来源，找到下一个想试试的创作。

- 轻松发现：按类型浏览，搜索关键词，或从专题里偶遇一个新想法。
- 看见可能：查看图片与图集、播放视频、打开原创交互网页示例。
- 变成自己的：复制完整 Prompt，或编辑后使用；草稿自动保留在设备上。
- 留在手边：收藏喜欢的条目。文字与已保存的缩略图可以离线查看。
- 来源清楚：每条内容展示作者、来源和许可信息，也提供内容反馈入口。

Prompix 不在 App 内生成图片、视频或 AI 回复。复制后可在合适的外部工具中使用；外部工具可能需要账号或付费。不同模型和设置会产生不同结果。首次联网更新后可浏览视频案例；文本、图片与原创网页示例可在首次离线打开时查看。

无需创建 Prompix 账号。原生界面支持简体中文和英文，Prompt 正文保留来源语言。

### English description

Make a little room for curiosity.

Prompix is a native iOS home for prompts worth trying. Browse curated text, image, video and website ideas, explore their examples and sources, and find your next creative starting point.

- Discover by format, search by keyword, or explore an editorial collection.
- View images and galleries, play videos, and open original interactive website examples.
- Copy a complete prompt or edit it first. Your drafts stay on your device.
- Save favorites for later. Saved text and successfully stored thumbnails are available offline.
- Check the author, source and license, or report a content issue.

Prompix does not generate images, videos or AI responses inside the app. Use copied prompts in a suitable external tool, which may require its own account or payment. Results vary by model and settings. Video examples become available after the first online update. Original text, image and website examples are available at first launch offline.

No Prompix account is required. The interface supports English and Simplified Chinese; prompt content retains its original language.

## 审核说明草稿

No login, purchase or subscription is required. Content updates are delivered from https://api.prompix.dev, with 30 original text, image and website examples available on first launch offline. Video examples require a successful online content update; the Video channel offers a retry action before that update.

Suggested review path:
1. Open Discover and choose Text. Open a prompt, copy it, then choose Edit to change a local draft.
2. Save the prompt and open Favorites. Saved items and drafts persist after relaunch.
3. Choose Image and open a preview. Some community items contain multiple images with native paging and zoom.
4. Choose Video and tap the preview to play. Video playback is user-initiated.
5. Choose Website and open an original example. WebKit is used only for bundled first-party demonstrations; the app interface is native SwiftUI.
6. Open Settings for support and privacy, or open an item's report link for attribution/content feedback.

The app does not submit prompts to AI services automatically. External tool/source links open through the system. The tarot example is an entertainment and self-reflection writing exercise, not a prediction or professional advice service. Content is editorially selected; there is no public in-app posting or messaging.

## 隐私申报依据

`PrivacyInfo.xcprivacy` 随 App 打包。当前无第三方 Swift SDK，无广告标识、跨 App 跟踪或 ATT 请求。文件包含空的 tracking domains 和 required-reason API 数组；当前源码及本地 Debug 二进制没有发现直接使用 UserDefaults、文件时间戳、磁盘容量、系统启动时间等受管 API。这不是对最终发行二进制的替代检查。

| 数据路径 | 实际行为 | 当前申报处理 |
|---|---|---|
| 搜索／收藏／草稿 | 在设备上检索和存储；没有上传接口 | 不列为收集 |
| 内容与媒体请求 | Cloudflare 处理 IP、请求 URL、时间等网络元数据；Worker 启用 10% 抽样运行日志 | 其他使用数据、性能数据、其他诊断数据；仅 App Functionality |
| 身份关联 | App 无账号或自建用户 ID，但运行元数据在写入日志前没有已验证的匿名化步骤 | 保守声明 linked=true，不宣称日志已匿名化 |
| 跨服务跟踪／广告 | 没有相关功能 | tracking=false，不请求 ATT |
| 内置网页作品 | 本地 WebKit、临时数据存储、CSP 禁止联网 | 无额外服务端收集 |
| 复制／系统分享／外部网页 | 仅用户主动操作；目标服务自行处理 | 不把系统外的第三方行为描述为 Prompix 内建生成 |
| GitHub 支持 | 跳转公开 GitHub 表单，需要用户自行登录并提交 | 公开隐私页解释账号与提交内容的可见性；提交时再次核对 Apple 的可选反馈披露条件 |

服务器运行日志只能用于交付、安全和故障排查，不用于兴趣画像。上述分类根据实际用途，而不是因为“没有分析 SDK”就选择 Data Not Collected。最终提交时核对 Cloudflare 当前记录字段、留存和安全配置，并按 App Store Connect 实际问卷填写，不能机械复制这份草稿。

依据：[Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)、[Privacy manifests](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)、[Required reason APIs](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)、[Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)。核对日期为 2026-10-12。

## 提交前仍需完成

- 最终发行归档、有效签名、隐私报告和上传校验；检查包内 manifest 与资源。
- 真机启动、滚动、内存、视频、后台恢复与离线测试；完成设计／无障碍关口。
- 最终版本真实截图：发现、详情、编辑、收藏、四类示例；按实际支持设备生成，不用概念稿替代。
- 在 App Store Connect 按实际内容完成年龄分级。存在浏览器外链及娱乐反思玩法，不预填未经问卷确认的年龄。
- 确认发行主体、版权年份、审核联系方式、海外发行区域、协议和税务状态；不把这些账户事项写进开源仓库。
- 复核支持入口响应方式及隐私申报；用户完成最终验收后再提交审核。
