# 0.6.0（23）：独立搜索与沉浸阅读

2026-10-14。根据用户对重复专题 Tab、滚动顶栏和详情正文层次的反馈，仅调整现有原生呈现和搜索匹配；复用目录、语言包、收藏、草稿、图片查看器和外部工具交接。折叠屏专项继续暂缓。

## 依据与取舍

通过用户已授权的 WebDriverAgent，重新实际操作手机上的 Cosmos：发现页向下浏览时隐藏整组顶栏，反向滑动恢复；详情深入浏览后操作条缩为小入口。截图序列保存于外置盘，不提交第三方媒体。此次手机系统不支持所尝试的屏幕录制命令，因此本轮 Cosmos 依据是连续截图，不把失败录制写成录像证据。

Apple [2026 搜索设计讲座](https://developer.apple.com/videos/play/wwdc2026/292/)区分通用搜索 Tab 和强调搜索的独立按钮。Prompix 采用右侧独立入口，搜索整个已发布目录；收藏保留局部搜索。iOS 27 使用系统 [TabRole.prominent](https://developer.apple.com/documentation/swiftui/tabrole/prominent)，iOS 18–26 使用 search role，iOS 17 使用普通原生 Tab。各页面分别拥有搜索框，避免收藏的局部搜索与全局搜索共享系统搜索控件状态。

详情采用 [Apple Liquid Glass 实践](https://developer.apple.com/videos/play/wwdc2025/323/)中的 GlassEffectContainer 和玻璃身份过渡，保留稳定的内容布局与可点按钮。参考 [Apple Tips](https://support.apple.com/guide/iphone/tips-iph3afc3b3fc/26/ios/26)的层级，以及 [Craft 的官方商店截图](https://apps.apple.com/us/app/craft-notes-documents-ai/id1487937127)的正文排版；后者为截图研究，不宣称完成其全部功能的实机体验。

## 最终行为

- 导航为发现、收藏和右侧搜索。专题不再独占 Tab，发现页用途栏的“查看全部”仍进入完整列表。
- 发现页向下连续浏览时顶栏整体收起，反向滑动恢复。内容偏移不因顶栏动画重排；状态栏有干净底色，没有分类器阴影。
- 搜索支持完整 Prompt／Skill 正文、已有译文、模型标签和创作者；多词联合匹配、标题／作者优先、类型筛选、最近搜索和目录更新。联网获取已发布版本后本机搜索，离线继续用缓存。**不是实时全网爬取或联网生成答案**。
- 详情导航栏透明；完整正文直接排在页面上，取消正文卡片与截断展开。标题、简介、作者、语言与正文保留，示例／文件／许可／来源收在“说明与来源”。
- Markdown 支持标题、段落、列表、引用、代码和安全网页链接。复制和编辑始终使用完整原文。表格、非网页定义式字段及超过 250 KB 的内容保持可读原始文本，避免解析丢字；远程 Markdown 图片不自动加载，任务列表标记保持文本。Skill 的 YAML 文件头单独收在“元数据”，避免被 Markdown 误渲染为巨大标题。
- 初始操作条为编辑、复制和展开的使用按钮；向下阅读后缩为三个小按钮，反向阅读恢复。缩起时仍能一触复制或编辑，不需要先打开菜单。减少动态效果关闭形变动画；VoiceOver 保持展开。最大辅助字号下正文继续放大，紧凑操作条字号设上限以防图标互相覆盖。iOS 17 保留静态操作，iOS 26 前使用材质及有对比度的主按钮底色。

## 验证与复现

专用普通 iPhone Air 模拟器：`781ED135-F549-496B-8CBA-FE537E801884`，iOS 27.0 runtime（24A434），Xcode 27.1 RC。结果包、截图及录屏在外置盘 `Prompix-Codex/Evidence/immersive-reading-20261014/`。

```sh
xcodebuild test -project ios/Prompix.xcodeproj -scheme Prompix \
  -destination 'id=<dedicated-iPhone-simulator>' \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  -only-testing:PrompixTests \
  -only-testing:PrompixUITests/ImmersiveReadingTests \
  CODE_SIGNING_ALLOWED=NO
```

真实目录验收使用 `GlobalDiscoveryUITests/testImmersiveLiveSkillAndCreatorSearch`。先备份专用模拟器个人文件，传 `TEST_RUNNER_PROMPIX_IMMERSIVE_ACCEPTANCE=1` 和 `TEST_RUNNER_PROMPIX_ACCEPTANCE_CONTAINER=<该模拟器当前 App 容器>`。读取现有已发布 Skill，验证创作者搜索、返回查询、Markdown 阅读、完整编辑正文及来源文件入口；宿主读取剪贴板与该条实际译文按字节对比。不要把生产内容加入测试仓库。

### 已取得的实际结果

- `final-functional.xcresult`：196 项原生模型检查，194 通过、2 项按既有条件跳过；其中新搜索 6 项、滚动方向 2 项。之后新增文件头处理，以 `final-markdown.xcresult` 重新验证全部 14 项 Markdown 测试及真实 Skill 流程，全部通过。
- `acceptance.xcresult`：发现顶栏收放／专题入口、图片详情操作收放／复制／编辑、文本阅读／使用面板通过。来源标识的问题在这轮暴露并修复，不能把该整个结果包标为成功。
- `source-controls.xcresult`：修复后两项通过，覆盖搜索→收藏→返回搜索保留输入、最近搜索、来源披露，以及真实创作者→Skill→完整编辑→文件入口。最终 Skill 再验见 `final-markdown.xcresult`。
- `iteration-4.xcresult`：原有图片下拉关闭、缩放保护及重新打开通过。
- `final-accessibility.xcresult`：系统深色、最大辅助字号及 Reduce Motion 实际开启；操作命中范围与元素描述审计、向下收起、复制和编辑均通过。对比截图确认按钮图标不再重叠；正文保持最大字号。
- 九语资源检查通过：主表 253 个可译键，引导表 15 个；这不代表九语逐页视觉验收。
- 实际联网刷新从原 531 条缓存更新为 648 条。真实 Skill 的当前简中正文 3,824 UTF-8 字节与宿主读取的复制结果一致；不声称本轮逐条审读全部新增内容。

初期失败包保留，包含顶部状态栏遮挡、搜索激活状态、来源子控件标识及文件头排版修复前的证据。它们不能作为通过凭据，也不以反复运行同一通过测试代替新问题验证。

## 范围边界

这是本轮导航与阅读改版，不宣称覆盖所有九语页面、所有历史系统或完成 App Store 最终交付。旧的性能和折叠屏证据不能继承到新界面。所有视觉判断仍以用户实际验收为准，不保证获得编辑推荐。真机保留已经安装的 0.5.1（22），本轮不反复覆盖手机。
