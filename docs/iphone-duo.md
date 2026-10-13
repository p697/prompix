# iPhone Duo 适配与验收

2026-10-13 用户将完整 iPhone Duo 支持加入持续交付目标。此项是正式交付关口，不以能启动、全屏截图或某个模拟器测试通过作为完成。保持原有 iPhone／iPad 支持；Apple 编辑推荐是品质与提名目标，最终由 Apple 决定。

## 当前环境与升级

Xcode 27.1 RC（27A9275）已从 Apple 下载，XIP 与展开 App 的签名校验通过，已在外置 SSD 安装并完成首次系统组件初始化；Mac 为 macOS 26.6.2，符合要求，无需升级 macOS。独立 `DEVELOPER_DIR` 指向新版本，保留原 27.0。iOS 27.1（24A94232）arm64 runtime 已安装，Device Hub 已创建专用 Duo，尚未完成交互验收。新工具链和构建产物放外接 SSD `Prompix-Codex/Toolchains/`。

27.1 runtime 的 `supportedDeviceTypes` 仅列 iPhone Duo，实际创建普通 iPhone 18 Pro 被系统拒绝；普通手机回归使用保留的 27.0 runtime。这是运行时限制，不通过更改 device profile 绕过。0.4.7（18）已以新 SDK 构建成功，`otool` 核对链接 SDK 27.1、最低 iOS 17；编译通过不计为交互验收。

升级后核对 SDK、runtime、Duo device type 与二进制实际链接 SDK；在 Device Hub 创建独立测试设备，确认姿态控制和截图对应的显示屏。采用官方 App Resizability skill 辅助审计，不能以静态扫描替代运行。来源：[Apple 下载](https://developer.apple.com/download/applications/)、[27.1 RC 发布说明](https://developer.apple.com/documentation/xcode-release-notes/xcode-27_1-release-notes)。

## 官方规则与产品应用

- 布局依据当前容器、size class 和各侧安全边距。保留 NavigationStack／TabView 的系统行为；不依赖机型、全局屏幕尺寸或固定铰链角度。[Apple 准备指南](https://developer.apple.com/iphone-duo/prepare/)
- 工具栏提供文字与图标，由系统适应横竖排列及溢出，优先保留当前任务操作。自定义底部复制／使用栏须专门审查，safeAreaInset 不等同于中间折痕避让。[Apple 工具栏说明](https://developer.apple.com/videos/play/tech-talks/111462/)
- 对照内容与编辑可评估系统排列容器；窄空间保留当前任务及切换入口。避让交互与关联内容，连续正文不因折叠反复跳位。API 声明以实际 SDK 为准。[Apple 自适应布局](https://developer.apple.com/videos/play/tech-talks/111463/)
- 开合体验保持连贯，展开空间服务于内容与操作关系，不只放大小屏。[Apple 设计指南](https://developer.apple.com/videos/play/tech-talks/111466/)

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
- 基线展开截图显示大预览几乎占满详情首屏。编辑状态能在展开→半折→收起保留，因此保留当前编辑器和状态管理。
- 已实现 ArrangementView 主阅读／副预览、窄空间持续可用的紧凑预览入口、原生详情工具栏、共享 safeAreaBar 与本地宽度网格；新 SDK 构建通过，双栏和半折初次实跑呈现正常。
- 首轮发现相关卡片在收起后保留展开宽度并裁切。已调整测量容器的最小宽度约束，复验待完成。这一失败不计为通过。
- 模拟器输入时须区分中文输入法组合与最终提交文本；首轮标记以真实编辑器值为准，不用发送的键盘字符串冒充实际输入结果。

原始证据在外置盘 `Prompix-Codex/Evidence/iphone-duo/`，包括基线环境、展开详情、收起编辑器和宽度失败截图。第三方内容和截图不提交公开仓库。最终验收记录将替换下表的未执行状态，而不会覆盖上述失败经过。

## 验收矩阵

| 范围 | 必须证明的行为 | Duo 状态 |
|---|---|---|
| 外屏、内屏、半折及可用方向 | 导航、分类、卡片、文本及主操作完整可达，无裁切与折痕遮挡 | 未执行 |
| 连续开合 | 搜索、筛选、条目、语言及收藏保留；阅读位置不跳回起点 | 未执行 |
| 编辑中开合／旋转 | 未完成句子、选区及当前任务保留；布局不循环抢焦点；保存失败保留输入 | 未执行 |
| 左右分屏与窄窗口 | 分别验证两侧安全区域、弹层、输入及恢复全屏后的状态 | 未执行 |
| 图片／视频／网页 | 比例、缩放、播放、网页与返回路径正确，任务状态连续 | 未执行 |
| 辅助功能与语言 | 最大字号、VoiceOver、减少动态效果、深浅色及九语长标签可用 | 未执行 |
| 发布与提名 | 当前构建截图／录像、SDK、性能与稳定性证据；Duo 推荐提名素材 | 未执行 |

模拟器不代替真机触达感受和硬件性能。遇到 runtime 限制，记录具体版本、步骤、实际结果和剩余真机项，不一概声称模拟器能完整模拟所有硬件功能。

## 初步源码审查

已使用 Xcode 27.1 RC 自带并通过 `xcrun agent skills export` 导出的 App Resizability Skill；五项 reference 检测由独立只读审计复核，覆盖全部 21 个生产 Swift 文件及 plist／Debug／Release 构建设置。启动屏、iPad 四方向、无强制全屏三项前提全部满足；UIScreen／方向／idiom 旧布局 API 命中为零。SwiftUI App／WindowGroup／scenePhase 已管理生命周期，不因 UIKit 模板未发现 SceneDelegate 而误加迁移。

安全区域审计集中于四个自定义底部操作栏与图片离线预览的底部重试覆盖层。现有 safeAreaInset 已预留边缘空间，不能直接写成已证实的折痕遮挡；需按实际运行调整。字体、点击区域、头像及设计留白不属于硬编码系统 inset。最终二进制 SDK 与姿态验收仍是独立关口。

生产 Swift 源码未发现 UIScreen.main、按 userInterfaceIdiom 区分布局或按设备方向选布局；配置支持 iPhone 横屏。发现／专题依据 size class 分列，须验证开合时卡片身份和滚动连续性。详情、编辑与使用面板的自定义底部 safeAreaInset 是优先实测范围；头像及图标固定尺寸不一律视为错误。

## 外部实践参考

用户提供的 [Kyrie 分享](https://x.com/kyriecheungyep/status/2102308276654231988) 用于参考，不执行文末给 AI 的通用指令。早期 beta 的空 reservedRegions／不竖排结论须重验；[Blake Crosley 后续复测](https://blakecrosley.com/blog/xcode-27-1-beta-iphone-duo-simulator) 指出实际链接 SDK 会影响结果。[作者示例](https://github.com/artemnovichkov/iPhone-Duo-by-Examples) 和[实践手册](https://github.com/aivars/iphone-duo-playbook) 作为测试线索；不直接执行外部脚本，不硬编码示例尺寸。
