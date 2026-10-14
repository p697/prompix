# 0.6.6：从发现到真正使用

本轮从0.6.5的连续内容画布继续打磨，把范围收敛到首次引导与使用面板。版本为0.6.6（30），没有改写首页、搜索、作者或Library的数据流；这些入口由数据库升级分支继续负责。不会用内部评分或主观赞美宣称已经达到苹果编辑推荐标准。

## 研究与判断

- **Cosmos**：重新检查已在用户手机上采集的引导、详情和保存面板画面。值得保留的是内容优先、少量大标题、单一下一步；它的保存面板并非需要逐像素复制。Prompix核心还包括读懂和使用文字，不能只做图片墙。原始证据位于开发SSD的 `Evidence/cosmos-iphone-20261014/`。
- **Mela / Silvio Rizzi**：在[App Store官方页面](https://apps.apple.com/us/app/mela-recipe-manager/id1548466041)实际查看iPhone截图与Editors’ Choice标识。其菜谱、步骤和工具呈现有清楚的层级，内容本身占据主要空间。Prompix采用同样的任务顺序思考，使用面板先选工具，再查看/调整要带走的内容。
- **Denim / Feel Good Tech**：查看[官方商店截图及预览](https://apps.apple.com/us/app/denim-playlist-cover-maker/id1532250420)，学习让作品贯穿选择与制作流程。它是[2025 Apple Design Awards决赛入围应用](https://developer.apple.com/design/awards/2025/)，不将入围写成获奖。Prompix用同一条真实Prompt串起发现、收藏与试用，不采用与内容无关的装饰动画。
- **iA Writer / Information Architects**：查看[移动端商店截图](https://apps.apple.com/us/app/ia-writer/id775737172)，文字和当前任务优先，工具不和正文争夺视觉注意力。本轮保留详情已有Markdown阅读，使用面板中的完整内容只在需要时展开。
- **Apple HIG**：[Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)建议简短、可跳过、互动式学习；[Motion](https://developer.apple.com/design/human-interface-guidelines/motion)作为动效约束。保留跳过/重播、减少动态效果、大字号和原生sheet；不增加必须等待的开场动画、账号墙或网络前置条件。

以上有实际画面观察，也有从观察得出的设计判断；不是对第三方所有功能的完整审计。商店截图不代表已在那些应用里逐项操作。

## 实现

### 引导可以实际试用

内置 `ordinary-museum` 文本Prompt贯穿三页：发现中的一张文字卡、收藏示例、真实正文节选。第三页的可选试用直接进入正式使用面板；打开时不创建草稿、不启动外部工具。关闭回到第三页，只有“开始探索”或“跳过”才完成引导。辅助功能字号下仍可访问试用，不随装饰插图一起隐藏。

### 使用面板采用一张连续页面

去掉多层Form白色卡片，沿用纸张底色与绿色选中态。工具选择前置，工具采用有文字和勾选标识的选择按钮；正文节选、展开全文、编辑、填变量、复制和分享在其后。底部按钮明确目标工具，且保持现有复制全文/官方预填链接/由用户发送的语义。Skill保留安装命令和源文件路径，不伪装成手机端已经执行。

### 阅读版本与个人修改明确分开

详情仍展示当前语言的阅读内容；如果已有不同的个人修改，使用面板默认继续已有草稿，同时显示版本菜单。切换只改变本次复制、分享或打开的内容，不改写草稿。即使选择阅读版本后进入编辑器、完全不输入再关闭，也不会覆盖保存过的修改；实际编辑才写入原有语言隔离存储。

保存失败仍保留当前缓冲，禁止交互关闭和版本切换，提供重试、复制退出与明确放弃。没有添加新的数据库或草稿文件格式。

## 验证

使用 Xcode 27.1 RC / iOS 27.1 SDK 构建，在 **Prompix iPhone 18 Pro / iOS 27.0**（`C0DB1FE2-71F3-4EF6-AEFF-8FECEA472A92`）实际运行。首次测试曾使用本轮新建的 Air 副本；因内置盘不足，已回收该副本，备份现有18 Pro应用数据后继续验收。没有重置其他任务的设备，也未安装物理手机。

证据根目录：`/Volumes/Lucy-SSD/Prompix-Codex/Evidence/experience-polish-20261015/`。截图、结果包和第三方内容仅保存在开发SSD，没有提交到仓库。

- 原生交接模型11项通过（`handoff-fixed.xcresult`中的`PromptHandoffTests`，不把该包里的早期UI定位失败算作通过）。
- 引导5项通过（`source-and-welcome.xcresult`）：跳过、完成、重播、英德正常字号、试用关闭与未完成状态重启；编辑→切换阅读版本→仅查看编辑器→重新打开后个人修改仍保留。
- 深色/最大辅助字号的引导2项通过（`dark-largest.xcresult`），其中另一个旧交接测试定位失败单独记录，不宣称整个包通过。
- 本地化脚本检查全部九语资源完整；新增8条文案均有九语值。并非专业母语审校。
- GitHub PR104的内容与原生模型CI通过：201项原生测试中199项通过、2项按条件跳过、0失败。完整结果链接由PR保留。最终收尾结果见下方验收状态。

实际正常字号截图在`verified-light/`，含`cosmos-01-welcome.png`、`welcome-trial-preview.png`、`welcome-trial-tools.png`和`experience-reading-version.png`。这些是模拟器截图，不是设计稿。

### 复现方法

在上述专用模拟器中打开Prompix，可从设置“重新查看引导”进入三页引导；第三页点击“试试这个 Prompt”，关闭仍留在第三页。编辑内容后返回使用面板，在版本菜单切换“阅读版本/我的修改”，确认改动未被覆盖。

自动验收使用`xcodebuild -project ios/Prompix.xcodeproj -scheme Prompix -destination 'platform=iOS Simulator,id=C0DB1FE2-71F3-4EF6-AEFF-8FECEA472A92' -derivedDataPath /Volumes/Lucy-SSD/Prompix-Codex/DerivedData-Experience -parallel-testing-enabled NO -collect-test-diagnostics never test CODE_SIGNING_ALLOWED=NO`，用`-only-testing:PrompixUITests/OnboardingTests`选择引导测试。交接验收使用当前生产目录副本，需按测试中的要求设置`TEST_RUNNER_PROMPIX_ACCEPTANCE_CONTAINER`与对应开关，不能对物理手机或未备份的用户数据直接运行。

### 验收状态

- `handoff-three-locales.xcresult`：1个矩阵测试通过，覆盖简中/德语/日语 × 网页Prompt/Skill共6条路径。深色、最大辅助字号，实际选择Claude Code、展开完整内容、执行触控区域和元素描述的可访问性审计，并确认草稿/收藏/创作者收藏文件不变。
- 旧UI测试先后暴露了Form改ScrollView后的定位、德语长页滚动次数、搜索Tab语言选择问题；均修正测试后复跑。早期失败结果保留，没有作为通过证据。
- `save-recovery.xcresult`：3项通过，模拟写入失败后分别验证复制退出、明确放弃、回到编辑器保留变量并重试保存。额外通过`simctl pbpaste`对比完整预期文本，确认复制退出没有截断内容。
- 已将模拟器恢复为浅色、正常字号、简中；原有`drafts.json`、`favorites.json`、`creators.json`与测试前备份逐字节一致，648条目录保留。校验在`personal-state-restored.json`，没有遗留测试草稿标记。
- 验收App仍为0.6.6（30）；从引导第三页可开始真实试用。外部工具实际发送、真机性能与完整VoiceOver遍历不在本轮新增验收范围。

## 边界

- 外部工具的账号、网络、模型支持与发送动作仍由对应工具处理。
- 九语界面检查不等于专业母语审校，也不表示所有社区条目均有九语正文。
- 本轮只对明确范围实施改进，不将两个页面的通过视作整个App的最终上架验收。真实手机手感与用户主观审美仍由后续验收决定。
