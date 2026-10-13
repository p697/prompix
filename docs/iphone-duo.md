# iPhone Duo 适配与验收

2026-10-13 用户将完整 iPhone Duo 支持加入持续交付目标。此项是正式交付关口，不以能启动、全屏截图或某个模拟器测试通过作为完成。保持原有 iPhone／iPad 支持；Apple 编辑推荐是品质与提名目标，最终由 Apple 决定。

## 当前环境与升级

Xcode 27.1 RC（27A9275）已从 Apple 下载，XIP 与展开 App 的签名校验通过，已在外置 SSD 安装并完成首次系统组件初始化；Mac 为 macOS 26.6.2，符合要求，无需升级 macOS。独立 `DEVELOPER_DIR` 指向 `Prompix-Codex/Toolchains/Xcode-27.1-RC.app/Contents/Developer`，保留原 27.0。iOS 27.1（24A94232）arm64 runtime 已安装，Device Hub 专用 Duo 为 `F0486196-6C2E-4906-AED5-0B2649042091`，已实际运行 App、操作姿态和分屏；可供用户在专用模拟器验收；输入法组合态限制见下文。工具链、DerivedData 和验收产物分别保存在外置 SSD 的独立目录。

27.1 runtime 的 `supportedDeviceTypes` 仅列 iPhone Duo，实际创建普通 iPhone 18 Pro 被系统拒绝；普通手机回归使用保留的 27.0 runtime。这是运行时限制，不通过更改 device profile 绕过。0.4.7（18）已以新 SDK 构建成功，`otool` 核对链接 SDK 27.1、最低 iOS 17；编译通过不计为交互验收。

`baseline-environment.json` 保留初次安装与二进制身份；`final-build.json` 是提交 `38c0dec7b6f650efd1df11f3cb17caad9c1486e9` 的阶段记录，该提交两项 CI 已通过。后续手工媒体检查对应 `174b751`；当前候选的 App／测试哈希及 SDK 已写入 `final-validation/delivery-build-identity.json`，最终结果及阶段适用范围已在下方矩阵汇总。每个阶段的证据须对应实际构建，不以相同的0.4.7（18）版本号认定二进制相同，也不沿用旧 CI 结果。

Apple RC 发布说明列出的限制包括首次模拟器启动可能耗时数分钟、Duo runtime 不支持 StandBy，以及大多数 App extension 暂不能运行调试；这些不计为 Prompix 主 App 已通过的能力。来源：[Apple 下载](https://developer.apple.com/download/applications/)、[27.1 RC 发布说明](https://developer.apple.com/documentation/xcode-release-notes/xcode-27_1-release-notes)。

## 官方规则与产品应用

- 布局依据当前容器、size class 和各侧安全边距。保留 NavigationStack／TabView 的系统行为；不依赖机型、全局屏幕尺寸或固定铰链角度。[Apple 准备指南](https://developer.apple.com/iphone-duo/prepare/)
- 工具栏提供文字与图标，由系统适应横竖排列及溢出，优先保留当前任务操作。自定义底部复制／使用栏须专门审查，safeAreaInset 不等同于中间折痕避让。[Apple 工具栏说明](https://developer.apple.com/videos/play/tech-talks/111462/)
- 对照内容与编辑可评估系统排列容器；窄空间保留当前任务及切换入口。避让交互与关联内容，连续正文不因折叠反复跳位。API 声明以实际 SDK 为准。[Apple 自适应布局](https://developer.apple.com/videos/play/tech-talks/111463/)
- 开合体验保持连贯，展开空间服务于内容与操作关系，不只放大小屏。[Apple 设计指南](https://developer.apple.com/videos/play/tech-talks/111466/)
- Duo 多任务是固定50/50分屏，分别检查 App 位于左侧和右侧时的安全区域与系统栏；不把拖动分隔线改变比例列为设备能力或验收条件。[Duo Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo)

## 实施顺序

本轮按调研、方案设计、开发、测试、体验优化、最终验收六阶段执行。负责人统一处理核心视图与模拟器；官方依据核对和只读代码审计可并行，不让多个 Agent 同时修改核心模块。调研与审计形成问题清单后才决定必要改造；同一测试通过后不无依据反复执行。

1. 普通手机先完成发现、详情、编辑／使用、收藏复用，保留语言、草稿和失败恢复。
2. 用 Duo SDK 实跑发现流、详情媒体、使用面板、编辑器、作者与收藏；按实际宽度改善展开体验，评估预览和编辑对照。保持编辑器身份，不重复构造互不关联的输入视图。
3. 调整底部操作、系统工具栏、折痕避让、键盘与弹层；新能力保留旧系统回退，不因新增设备提高整个 App 最低系统版本。
4. 录制连续开合与旋转，不能只截静态终点。逐项记录失败、修复及复验。

本轮边界：保留 SwiftUI、原生 TabView／NavigationStack、设计色板、数据协议、草稿事务与采集架构；不引入新路由框架、多窗口产品功能或数据层迁移。展开空间优先服务于既有的预览、阅读和编辑关系。仅在重排确实影响导航或阅读连续性时调整状态归属，不因潜在风险先重写导航。

本轮结束条件：以下适用矩阵全部验收、有明确已知限制、代码合并、专用 Duo 模拟器安装同一构建并可交给用户现场操作。交付包括简短复现路径及关键页面截图，不以文档代替 App。此专项达到结束条件即交付，不持续扩大为无关功能；项目原有上架工作另按原定关口推进。

## 本轮实跑与必要修改

- 已安装并启动 0.4.7（18），基线缓存为线上465条。初次 runtime 启动曾报告 MobileSafari 数据迁移失败，但随后 SpringBoard 和 App 可运行；须保留这一环境记录。
- 基线展开截图显示大预览几乎占满详情首屏。现有编辑正文能在展开→半折→收起保留，因此保留 SwiftUI、编辑器任务和草稿存储，只调整必要布局。
- 已实现 ArrangementView 主阅读／副预览、窄空间持续可用的紧凑预览入口、原生详情工具栏、共享 safeAreaBar 与本地宽度网格。展开及半折已实跑；新增预览布局不替代原有放大、播放或网页入口。
- 首轮相关卡片在收起后保留展开宽度并裁切，失败截图为 `grid-width-failure.png`。调整测量容器的最小宽度约束后，`closed-related.png` 显示收起状态的两列卡片和侧边动作均在可用区域内；保留失败证据，不以模型测试代替姿态复验。
- 后续连续操作发现正文仍在、选区却丢失，曾使用 `TextEditor(text:selection:)` 显式绑定选区；`editor-continuity-first.mov` 与 `editor-continuity-final.mov` 保留该阶段结果。之后拼音键盘的实际 `typeText` 暴露丢字，A/B 实验仅移除 `selection` 参数便恢复完整正文，因此显式绑定方案已撤回，旧录像不作为最终输入实现的验收。
- 当前 `StablePromptEditor` 保持同一编辑任务，使用默认 `TextEditor(text:)`，由系统管理选区和输入法组合文本；没有引入 UIKit 包装器或 iOS18 分支，最低系统仍为17。实际手工选中测试正文中的 `selection` 单词，收起→展开→半折→旋转→展开后，点击软件键盘 `n`、`i` 成功替换选区；再收起、点入编辑并选择候选“你”，正文保持为 `Duo keeps this 你.`，并保留两个换行。证据为 `final-validation/selection-ab-default-editor.log`、`final-validation/selection-ab-attachments/` 与 `final-validation/ime-committed-closed.png`；这是本次真实输入和选区连续性结果，不扩写为所有输入法均已验收。最新退出确认修正将 `FocusState` 移至父编辑器并传入绑定，用户明确点“退出编辑”时先收键盘；最大字号、拼音键盘、真实写入失败、继续编辑后的全文保持已在最终构建通过（`concise-alert-final.xcresult`）。
- 已实跑左侧Prompix／右侧Safari，以及左侧Safari／右侧Prompix两个固定50/50组合，两侧使用面板及从使用面板返回的编辑器均可输入、保存。阶段截图为 `split-left.png`、`split-right.png`、`split-right-editor.png`。实际恢复全屏路径为折叠→Home→重新打开仍在运行的Prompix进程→展开，`quiet-portfolio`条目与草稿保持；这不是已验证的官方退出分屏手势，也不声称完成了原地左右互换。
- 收起横向且软件键盘显示时，原编辑复制底栏挤占正文；`short-editor-before.png` 保留失败。阶段方案把复制移入 `.bottomBar`，`short-editor-after.png` 记录输入区恢复及16字符输入／复制一致。当前 iOS27.1 实现已将编辑器 Copy 改为 `.primaryAction`，Share 收入“编辑选项”菜单；旧系统保留既有底栏。详情页的 Edit／Copy／Use 仍由原生底部工具栏适配。阶段截图不冒充最新实现的全部键盘／字号验收。
- 模拟器输入时须区分中文输入法组合与最终提交文本；首轮标记以真实编辑器值为准，不用发送的键盘字符串冒充实际输入结果。

普通手机回归使用 iPhone18Pro／iOS27.0及隔离的SDK27.1构建：保存失败后携带变量回到原编辑器、重试保存与再次打开的UI测试通过，173项原生模型测试通过，个人文件已恢复。初次新增UI测试曾因启动前捕获了被XCTest更换的容器UUID而失败，修正测试定位时机后通过；不将这个fixture错误记为App数据丢失。证据在 `normal-regression-v2/`，不冒充Duo实测，也不替代后续短屏编辑修改的回归。

原始证据在外置盘 `Prompix-Codex/Evidence/iphone-duo/`，第三方内容和截图不提交公开仓库。最大字号恢复／六路径交接及最终普通手机回归已通过。普通手机最终测试为41.629秒，1通过、0失败、0跳过，三份个人文件原字节恢复；证据为 `normal-regression-final/run-20261013T061342Z-cc0327/`。

创作者行使用实际465条缓存目录验收：真实横向滑动后最后一个创作者完整可见并可点，打开对应主页及外部链接入口，系统返回后保留横向位置；三份个人文件逐字节保留。证据为 `final-validation/creator-native-back.xcresult`。

## 媒体与浏览状态的手工验收

以下结果来自连续操作记录，截图只展示其中的终点，不能单独证明状态连续性。媒体检查对应提交 `174b751`，未声称遍历整个线上媒体库：

- 四图图库切到2／4后折叠仍为2／4，双击放大可用，点“完成”返回同一条目；截图 `final-validation/gallery-second-zoom-closed.png`。
- 视频 `x-post-2109576638136795289` 实际播放，可访问性时间推进至0:09并出现不同帧；展开→半折→旋转→折叠保持播放器。Home回系统再打开Prompix仍在同一播放器，相隔数秒画面静止，明确点击播放后恢复并显示0:17，最后“完成”返回同一标题。阶段截图 `final-validation/video-partial.png`，不以单帧推断播放或后台暂停。
- 网页使用原有 WKWebView 完成实际交互，证据 `web-interaction.png`；原生详情预览截图不替代网页内交互。
- 网页分类显示7条，打开 `quiet-portfolio` 并下载切换到日语，半折／折叠后仍为日语；收藏后展开、旋转，日语和实心收藏图标保持。取消收藏并返回后仍是网页分类7条。另在搜索输入“网站”并选“网页”，6条结果与查询在折叠、旋转、展开后保持。终点截图分别为 `final-validation/language-favorite-state.png` 和 `final-validation/search-filter-state.png`；6是筛选结果数，不是目录总量。

## 辅助功能、语言与性能的阶段证据

以下均在专用 Duo／iOS27.1（24A94232）执行，逐项区分自动断言、真实朗读与视觉检查：

| 项目 | 实际结果 | 证据与边界 |
|---|---|---|
| 九语言界面 | `testNineInterfaceLanguages` 通过，281.445秒 | `final-validation/language-motion-summary.json` 及同目录 `language-motion-voiceover-final.log`；覆盖九语自动断言，不代表截图视觉通过 |
| 减少动态效果 | `testReducedMotionImageZoomAndReturn` 通过，26.252秒 | 同一结果文件；附件实际记录 `UIAccessibility.isReduceMotionEnabled = true` |
| 发现页 VoiceOver | 实际平面遍历通过，91.796秒；从标题向前108／109步到达搜索／设置 | `final-validation/voiceover-launch-summary.json`、`voiceover-flat-attachments/`；原日志139／140是含先前前进及后退的索引，标题在31；此测试使用30条离线种子，不是465／527条目录。证明真实朗读可达，不代表操作效率已达标 |
| Skill 使用面板 VoiceOver | `testSkillHandoffVoiceOverTraversal` 通过，34.787秒 | `final-validation/languages-voiceover-run.log`；不代表已在外部工具执行 Skill |

`initial-summary.json` 的九语与 VoiceOver 失败，以及 `language-motion-summary.json` 中旧 VoiceOver 路径的失败均保留；后者是两项通过、一项失败的混合结果，不能称整组通过。最终平面朗读遍历单独记录于 `voiceover-launch-summary.json`。

九语初次导出的27张截图均抓取了非活动 display0，逐张像素检查为全黑，不能支持视觉结论；已补拍并逐张查看最终构建的九语首页活动屏（`final-validation/delivery-languages/`），均为2853×2007展开画面，未见分类、创作者入口、搜索或筛选控件裁切；长卡片标题有正常省略。此补充只覆盖首页，不冒充九语全部详情的视觉验收。部分非中英内容回退到缓存中文，不能写465条内容均有九语。取消弹层的旧失败来自 `app.coordinate` 向 display0 发事件，而 popover 位于 display3；改用窗口锚点后的取消路径已复验通过。

`final-validation/keyboard-actions-final.xcresult` 中最大字号写失败保护通过，30.286秒。中文、德文、日文的网页／Skill六条交接路径均完成 UI 操作、可访问性审计与内容展开，但测试末尾的收藏原始字节断言失败：241453→241553字节。逐字段核对仅 `gentle-tarot` 德／日译文正文刷新，分别增加57／43字节，均精确匹配当前缓存；收藏 ID、顺序、保存原文和其余字段未变，草稿541字节未变。测试已改为检查个人数据语义不变量；最终 `handoff-geometry-final.xcresult` 六路径整体通过，旧整项失败仍保留。活动屏附件在 `final-validation/keyboard-actions-attachments/`；旧退出确认截图暴露大字号说明／选项被截断。最终改为简短原生 alert，并在明确退出时收起键盘；`concise-alert-final.xcresult` 无人干预通过，三个完整动作均可见，实际点击“继续编辑”后全文保留。

Debug、`--offline`、30条内置内容的五次启动测量为4.861194、4.815393、4.626276、4.839142、5.187331秒，均值4.866秒、相对标准差3.722%；证据为 `final-validation/voiceover-flat-and-launch.log` 与 `voiceover-launch-summary.json`。这些是同一模拟器的进程启动测量，不是Release、真机、冷启动或465条生产库的性能结果，也不与先前普通手机Release测量直接比较。

## 验收矩阵

| 范围 | 必须证明的行为 | Duo 状态 |
|---|---|---|
| 外屏、内屏、半折及可用方向 | 导航、分类、卡片、文本及主操作完整可达，无裁切与折痕遮挡 | 已实跑；展开四列、收起两列，主阅读／副预览及紧凑入口；最终首页和详情截图另存 |
| 连续开合 | 搜索、筛选、条目、语言及收藏保留；阅读位置不跳回起点 | 搜索／筛选、日语与收藏、返回分类、条目／草稿恢复已实跑；不把跨尺寸的绝对像素滚动偏移视为保证 |
| 编辑中开合／旋转 | 未完成句子、选区及当前任务保留；布局不循环抢焦点；保存失败保留输入 | 最终构建选区跨姿态替换、正文及写失败恢复通过；拼音候选跨屏有已复现限制，见下文 |
| 左右分屏与窄窗口 | 分别验证两侧安全区域、弹层、输入及恢复全屏后的状态 | 左右50/50与上述恢复全屏路径已实跑；不声称原地左右互换 |
| 图片／视频／网页 | 比例、缩放、播放、网页与返回路径正确，任务状态连续 | `174b751`已完成上述图库、视频与网页交互；限定于记录的条目和路径 |
| 辅助功能与语言 | 最大字号、VoiceOver、减少动态效果、深浅色及九语长标签可用 | 九语断言、减少动态效果、发现／Skill VoiceOver遍历通过；中／德／日六路径最大字号活动屏及九语首页逐张检查；内容翻译回退范围单独记录 |
| 发布与提名 | 当前构建截图、SDK、性能与稳定性证据及可操作模拟器；商店提名另行准备 | 当前构建可在专用模拟器操作，身份／截图／复现路径留存；商店提交与硬件性能为独立关口 |

模拟器不代替真机触达感受和硬件性能。遇到 runtime 限制，记录具体版本、步骤、实际结果和剩余真机项，不一概声称模拟器能完整模拟所有硬件功能。

## 最终复核发现的限制

最终构建实际保留了选中的 `selection` 单词，经收起、展开、半折和旋转后，软件键盘 `n`、`i` 正确替换为 `Duo keeps this ni.`（包括两个换行共19字符）。但再次折叠时，即使不点击编辑器，拼音候选也结束，转为英文预测，正文仍完整。这个结果不算未提交组合态通过；旧阶段成功选择“你”的记录不能覆盖最终复现。活动屏证据为 `final-validation/delivery-ime-fold-limit.png`。

只把 FocusState 恢复为叶子持有、父级显式发出收键盘请求的受控 A/B 未证明改善，已撤回，最终仍使用通过失败恢复回归的父级绑定。不引入未经验证的输入代理或监听姿态强制重建。官方27.1 RC说明未列出此现象，原因尚未确认，不能称为Apple已知bug。当前建议在切换内外屏前先选词提交；这是一项明确的候选版限制，不是完整输入法连续性已验收。

最大辅助字号下德文命令预览会自动断词，存在视觉连字符歧义；实际复制使用完整源字符串。VoiceOver搜索／设置可达，但平面遍历较长；构建19提供标题辅助操作，手势自动化限制见下文。真机功耗、音频与硬件性能、外部原生App里的实际执行及商店提名仍属后续独立关口。

## 初步源码审查

已优先使用 Xcode 27.1 RC 自带并通过 `xcrun agent skills export` 导出的 App Resizability Skill；五项 reference 检测由独立只读审计复核，覆盖审计时全部21个生产Swift文件及plist／Debug／Release构建设置。启动屏、iPad四方向、无强制全屏三项前提全部满足；UIScreen／方向／idiom旧布局API命中为零。SwiftUI App／WindowGroup／scenePhase已管理生命周期，不因UIKit模板未发现SceneDelegate而误加迁移。技能静态扫描不能替代真实姿态与交互验收。

安全区域审计集中于四个自定义底部操作栏与图片离线预览的底部重试覆盖层。现有 safeAreaInset 已预留边缘空间，不能直接写成已证实的折痕遮挡；需按实际运行调整。字体、点击区域、头像及设计留白不属于硬编码系统 inset。最终二进制 SDK 与姿态验收仍是独立关口。

## 外部实践参考

用户提供的 [Kyrie 分享](https://x.com/kyriecheungyep/status/2102308276654231988) 用于参考，不执行文末给 AI 的通用指令。早期 beta 的空 reservedRegions／不竖排结论须重验；[Blake Crosley 后续复测](https://blakecrosley.com/blog/xcode-27-1-beta-iphone-duo-simulator) 指出实际链接 SDK 会影响结果。[作者示例](https://github.com/artemnovichkov/iPhone-Duo-by-Examples) 和[实践手册](https://github.com/aivars/iphone-duo-playbook) 作为测试线索；不直接执行外部脚本，不硬编码示例尺寸。

## 构建19：发现页辅助操作

0.4.7（19）沿用上述布局、编辑器与数据协议，唯一生产行为变化是在现有Prompix标题增加本地化的搜索／设置自定义辅助操作；原生工具栏仍保留。使用Apple的 [accessibilityAction](https://developer.apple.com/documentation/swiftui/view/accessibilityaction(named:_:))，避免仅为缩短遍历而重排系统容器。构建18的签名包不包含这项变化，没有覆盖或重新标记旧包。

专用Duo的实际527条缓存检查结果：

- `testDiscoveryVoiceOverAnnouncesHeadingActions` 在收起状态通过，27.290秒，1通过、0失败、0跳过。实际朗读标题及“设置”“搜索”操作，保留文本分类和三份个人文件。这个测试名称及断言只覆盖朗读／选动作。
- 展开状态通过Device Hub暴露的标题AX辅助操作依次打开真实搜索和设置弹层，设置页显示0.4.7（19）、527条。搜索使用系统取消操作关闭，设置使用原生完成按钮关闭；两次均返回文本分类182条，草稿、收藏和创作者收藏与验收前逐字节相同。
- 自动注入的VoiceOver键盘激活与双击，在展开／收起的针对性探测中未打开弹层。失败结果保留，原因尚未确认；AX调用成功不等于VoiceOver实际双击手势已经通过。原有搜索／设置按钮仍可用，没有删除回退入口。

证据为外置盘 `Prompix-Codex/Evidence/accessible-navigation-20261013/` 中的 `announcements-19.xcresult`、`verification-19.json`、`search-19-display3.png`、`settings-19-display3.png`。后两张已实际打开查看。早期 `search-ax-action.png`／`settings-ax-action.png` 抓到了非活动屏，画面全黑，不能作为视觉证据。失败探测的结果包及源码另存，不以缩小后的测试冒充原完整手势测试已通过。

复现朗读检查：保留模拟器个人数据备份，使用已下载的生产目录，按 `ios/README.md` 的 `PROMPIX_DUO_DELIVERY` 和显式容器保护配置运行上述单项测试。辅助操作人工复现：在Device Hub启用VoiceOver，定位发现页Prompix标题，在其暴露的“搜索”／“设置”辅助操作中分别执行，检查实际弹层、返回分类和个人数据；注入手势限制须独立记录。普通验收结束后关闭VoiceOver并恢复全部分类。

## 现场验收入口

在外置 SSD 安装的 Xcode27.1RC 中打开 Device Hub，选择 **Prompix iPhone Duo** 并打开 Prompix 0.4.7（19）。当前已通过设置更新到527条，保持中文界面、普通字号和浅色；辅助测试的减少动态效果和VoiceOver已关闭，本次内容更新前后三份个人文件逐字节不变。上文姿态与交互证据保留其465条阶段范围，新增内容更新及单条复制验证见[运行记录](content-operations.md#2026-10-13新增内容审读补译与质量暂缓)。用户手机未安装本版。

建议依次体验发现页宽窄网格、创作者横滑和返回、网页或图片详情的阅读／预览、使用面板、编辑、开合旋转、图库／视频返回，以及Safari左右50/50多任务。外置证据目录的 `ACCEPTANCE.md` 提供具体步骤，`current-evidence-index.json` 汇总最终与历史证据，`final-validation/installed-delivery-verification.json` 记录构建18的身份。构建19独立保存在 `Prompix-Codex/Deliveries/Prompix-0.4.7-19-Duo/`，本轮哈希与个人数据核对见 `accessible-navigation-20261013/verification-19.json`，不将18的测试自动重新标为19全量通过。

本轮提供可操作的Duo验收候选版，明确保留上述组合输入限制；不声称完整项目上架已完成，也不承诺Apple编辑推荐。
