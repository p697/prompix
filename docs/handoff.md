# 一键使用规格

## 1. 目标

用最少的步骤把提示词送进用户正在用的 AI App。做不到直接带入时，平滑退回"复制 + 打开"。

## 2. 能力矩阵（2026-10 核实）

依据：各 App 公开的 `apple-app-site-association`（决定 iOS 通用链接能否唤起原生 App）、`assetlinks.json`（决定 Android App Links），以及官方文档。

| App | iOS | Android |
|---|---|---|
| ChatGPT | `https://chatgpt.com/?prompt=<编码后的文本>`（也认 `?q=`），由 App 官方认领：唤起 App 并预填 | 同一链接（App Link）；也可以用系统分享 |
| Grok | `https://grok.com/?q=<编码后的文本>`，App 认领全站路径：唤起 App 并预填 | 同一链接 |
| Gemini | App 不认领任何带提示词的链接：只能复制后打开 `https://gemini.google.com/app` | 系统分享 `ACTION_SEND`（text/plain）定向 `com.google.android.apps.bard`，可以预填 |
| Claude | App 认领 `https://claude.ai/new`，只打开新对话、不预填：复制后打开。`claude://code/new?q=` 只适用于 Claude Code | 系统分享定向 `com.anthropic.claude`，落在新对话还是当前对话待实测 |

通用限制：

- 四家都只预填、不承诺自动发送。ChatGPT 在 Android 上有自动发送参数，但受登录状态和远程配置控制，v1 不使用。
- 四家都不支持"提示词 + 图片"一次带入。
- 第三方 App 不能直接调用别家 App 的快捷指令操作（App Intents）。
- iOS 27 把 `LSApplicationQueriesSchemes` 的配额从 50 条降到 25 条，并废弃了 `canOpenURL` 检测。所以直接调用 `open`，再根据返回结果决定是否降级。
- 商标：四家都禁止在第三方 App 名称里使用其品牌。按钮可以写"Open in X"这类纯文字；使用彩色 logo 需要书面许可；不能写"合作伙伴"。

## 3. v1 策略

| App | iOS | Android |
|---|---|---|
| ChatGPT | `prefill_link` | `prefill_link` |
| Grok | `prefill_link` | `prefill_link` |
| Gemini | `copy_then_open` | `share_intent` |
| Claude | `copy_then_open`（只对文本提示词和 Skill 开放） | `share_intent`（只对文本提示词和 Skill 开放） |

规则：

- **始终备份到剪贴板**：无论哪种策略，都先把最终提示词写入剪贴板。
- **失败降级**：`open` 返回失败或没装目标 App 时，提示"已复制"，并打开该 App 的网页版或 App Store 页面。
- **Claude**：Claude 不生成图片，所以图片和视频提示词的面板里 Claude 置灰。
- **需要照片的提示词**：面板里提示"打开后用 + 号添加照片"，详情页标注"需要 1 张你的照片"。
- **首次"复制后打开"**：弹出交接引导（设计稿 04），告诉用户点输入框 → 粘贴 → 加照片；可以勾选"不再提示"。
- **记住选择**：按内容类型（图片、视频、文本、Skill）记住用户上次选的 App。
- **文案**：
  - 按钮写"Use in Gemini"或"Open in ChatGPT"；
  - 说明写"Opens with the prompt filled in"或"Copies the prompt, then opens"；
  - 不写"生成""自动发送"之类的承诺。
- **长度**：带入链接的文本超过配置的上限时，改用复制后打开。

## 4. 远程配置

- 由 Cloudflare Workers 提供 `config.json`，随快照版本清单一起拉取。客户端内置一份默认配置，拉取失败时使用。
- 示例（长度上限为保守值，需要真机测试后调整）：

```json
{
  "version": 1,
  "handoff": {
    "chatgpt": {
      "ios": { "strategy": "prefill_link", "template": "https://chatgpt.com/?prompt={prompt}", "maxLength": 6000 },
      "android": { "strategy": "prefill_link", "template": "https://chatgpt.com/?prompt={prompt}", "maxLength": 6000 }
    },
    "grok": {
      "ios": { "strategy": "prefill_link", "template": "https://grok.com/?q={prompt}", "maxLength": 6000 },
      "android": { "strategy": "prefill_link", "template": "https://grok.com/?q={prompt}", "maxLength": 6000 }
    },
    "gemini": {
      "ios": { "strategy": "copy_then_open", "openUrl": "https://gemini.google.com/app" },
      "android": { "strategy": "share_intent", "package": "com.google.android.apps.bard" }
    },
    "claude": {
      "ios": { "strategy": "copy_then_open", "openUrl": "https://claude.ai/new", "allowedKinds": ["text_prompt", "skill"] },
      "android": { "strategy": "share_intent", "package": "com.anthropic.claude", "allowedKinds": ["text_prompt", "skill"] }
    }
  },
  "appOrderByRegion": {
    "default": ["chatgpt", "gemini", "grok", "claude"],
    "IN": ["gemini", "chatgpt", "grok", "claude"],
    "ID": ["gemini", "chatgpt", "grok", "claude"],
    "JP": ["gemini", "chatgpt", "grok", "claude"]
  }
}
```

- "最适合的 App"由条目自身决定：例如 Nano Banana 系列提示词推荐 Gemini，GPT Image 系列推荐 ChatGPT，Grok Imagine 系列推荐 Grok。其余 App 按地区排序显示。

## 5. 埋点

| 事件 | 属性 |
|---|---|
| `handoff_sheet_opened` | 条目 ID、内容类型 |
| `handoff_app_selected` | App、策略、内容类型、是否为推荐 App |
| `handoff_result` | opened / fallback / failed |
| `handoff_tip_shown` | App |
| `prompt_copied` | 来源（按钮、面板、长按菜单） |

## 6. 真机测试清单

在最新的 iOS 和 Android 13 以上、各 App 最新版本上逐项测试。每项记录四件事：能否唤起原生 App、是否预填、是否自动发送、中文 / emoji / 换行 / 长文本是否正常。上线前测一遍，之后每次厂商更新后回归。

**ChatGPT**

1. iOS：从备忘录或信息里（不是 Safari 地址栏）点 `https://chatgpt.com/?prompt=<文本>` 和 `?q=<文本>`，对比两者的差异。
2. iOS：`com.openai.chat://chatgpt.com/?prompt=<文本>`。
3. Android：App Link 和系统分享（定向 `com.openai.chatgpt`）。只有在测试账号上、用无害文本，才测自动发送参数，因为它会真的发出消息。
4. 分享面板：分享文字或图片给 ChatGPT，是新建对话预填还是直接发送；图片和文字能否一起带入。

**Claude**

5. iOS：`https://claude.ai/new` 是否只唤起、不预填；`claude://claude.ai/new?q=<文本>` 在手机上是否预填。
6. Android：系统分享定向 `com.anthropic.claude`，文字落在当前对话还是新建对话。

**Gemini**

7. iOS：确认 `https://gemini.google.com/app?q=` 不唤起 App；分享图片、文档、链接进 Gemini 是否预填；纯文本能否分享。
8. Android：系统分享定向 `com.google.android.apps.bard` 是否稳定预填。

**Grok**

9. iOS：`https://grok.com/?q=<文本>` 是否进 App 预填、是否自动发送。
10. Android：`https://grok.com/?q=<文本>` 定向 `ai.x.grok`；分享面板里是否有 Grok，接收文字和图片的行为。

**通用**

11. iOS：`open(_:options:)` 的返回结果能否可靠触发降级；没装 App 时通用链接是否落到浏览器。
12. Android：`ActivityNotFoundException` 的兜底；`<queries>` 声明能否让"检测已安装 App"命中四个包名。
13. 剪贴板：iOS 目标 App 读剪贴板时是否弹出"已从 Prompix 粘贴"；Android 13 以上是否出现系统复制确认（出现的话，我们不要再叠加提示）。
14. 图片加提示词：iOS 用 `UIActivityViewController` 同时分享图片和文字、Android 用 image/* 加 `EXTRA_TEXT`，逐家看是否都能收到。
