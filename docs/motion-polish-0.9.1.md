# 0.9.1（39）：提前准备，安静阅读

本轮针对 0.9.0 真机反馈，保留现有导航、目录 API、瀑布流和原生玻璃 Tab。调整的是加载时机、局部动态反馈、收藏结构与视觉一致性，不扩展采集或折叠屏范围。

## 参考与设计选择

重新观看 FIELD 官方 [Quantum Compass](https://field.io/work/ibm-quantum-compass) 中的 Qubit Visual Language 动画，以及 [IBM Quantum](https://field.io/work/ibm-quantum) 案例。借鉴其聚合、轨道、方向性光线和疏密节奏；不复制品牌资产或把量子计算概念当作产品功能。结合 Apple [Loading](https://developer.apple.com/design/human-interface-guidelines/loading)、[Motion](https://developer.apple.com/design/human-interface-guidelines/motion) 的原则：已知内容立即可读，反馈就近出现，真实请求结束立即停止，不用动画制造等待。

- 页面底色调整为暖白，文字与操作为深石墨绿；深色使用墨绿灰和浅灰绿。蓝／紫／玫瑰保留在小型品牌和动态形态中，正文与图片不染色。
- 首页顶部渐变尾部从 48pt 缩短至 24pt，安全区和滚动方向判断不变。
- 同一 `RootPageHeader` 负责发现和收藏的设置按钮：相同位置、44pt 点击范围、图标、颜色和玻璃样式。
- 收藏采用紧凑标题、原生搜索框、内容／创作者数量与下划线切换、右侧类型菜单；真实收藏继续呈现为画廊。辅助字号时类型菜单换行，搜索框随字号增高，不压缩文字。
- App Icon 同步为原创三页展开标记，提供浅色、深色和系统着色资源，可由 `scripts/make-icon.swift` 重建。

## 连续加载与性能边界

详情预览与完整详情复用 `ReadingActionBar`。封面和标题进入时，顶部分享／收藏及底部编辑／复制／使用已存在；完整正文到达才启用需要正文的操作，避免复制或收藏不完整数据。后补正文保留滚动位置和底栏收起状态。失败保留预览和原位重试。

图片预取根据网格可视区域及已有卡片高度估算，向前准备约两屏缩略图。每个网格最多 20 个候选、全局最多两个预取请求；快速滑动会替换过时队列，已在进行的共享请求最多两个继续完成。只提前缓存压缩数据（上限 16MB），不批量保留完整解码位图；实际显示与预取共享下载，ImageIO 解码移到后台。离开页面撤销候选；低电量模式不启动新预取。它不是全库下载，也不预下载视频文件；未添加低数据模式专用策略。

内容和创作者分页在剩余距离约一屏时启动。请求绑定当前查询、游标和第一页代次；首屏刷新后可再次使用同一游标，旧几何信息不会直接触发新游标。沿用 store 的串行、去重、快照、失败重试和限流保护，底部手动加载入口仍保留。

新的局部 activity 以三枚渐变光球和稀疏轨道点表现聚拢／环绕／散开，应用于内容、作者、详情正文和续页。Canvas 最高 30fps，仅在真实加载且可见、前台时更新；减少动态效果或低电量时静态，减少透明度时使用实色。骨架保留一次掠光，不为每个占位重复持续动画。系统下拉刷新与 AVKit 控件继续采用原生表现，不伪造百分比。

## 验证

工具链：Xcode 27.1 RC；iPhone Air、iOS 27.0 模拟器 `781ED135-F549-496B-8CBA-FE537E801884`。本轮没有安装用户手机，不将模拟器视为真机性能测试或编辑推荐结论。

证据目录：开发 SSD 的 `Prompix-Codex/Evidence/motion-polish-20261015/`。

- `validation.xcresult`：原生 240 项执行，237 通过、3 项环境限定跳过；5 条 UI 流程通过，包括顶栏收起／展开／筛选复位、图片预取、视频／网页渐进详情、失败重试／关闭、收藏搜索与设置位置一致。
- 图片预取实际记录：屏内卡片索引 0–5，已请求缩略图延伸到 17，没有直接取完 30 条页面；专用传输测试验证两个并发预算、切换视窗撤销旧队列、显示共享请求、预取不产生解码位图。
- `final-ui.xcresult`：提前分页与最大辅助字号收藏流程通过；含点击区域与元素描述审计。该次线上测试未设显式开关而跳过，不算线上验收。
- `interaction.xcresult`：图片详情等待／补齐／缓存重开和提前分页通过；首次收藏测试暴露父级 accessibility identifier 覆盖子按钮标识，已修正，后续测试通过。失败诊断收集超时后取消诊断子进程，之后测试关闭无关的自动 sysdiagnose。
- `state-continuity.xcresult`：逐帧复查发现完整详情重新初始化滚动检测器会把已收起的底栏展开，已传递初始状态；三个滚动状态测试和顶栏／渐进图片两条 UI 复验通过。新增断言同时检查加载前后的动作栏宽度和标题位置。
- `dark-live.xcresult`：开启系统深色和 Reduce Motion，图片等待／补齐／缓存重开、最大辅助字号收藏与点击区域审计、真实 API 搜索 → 详情 → 作者 → 同模型探索 → 返回均通过。验收结束恢复原浅色与 Reduce Motion 关闭状态。
- Release 构建通过，原生模拟器录屏逐帧确认打开过程中操作区随详情一起进入，光球不是静态贴图；故意保留等待闸门还触发了超时与原位重试。录屏为显式测试数据，正式运行使用线上内容。
- `contrast.json`：26 组纯色正文／辅助文字／操作的背景配对，最低 4.52:1；不代替随真实图片变化的玻璃逐像素审计。
- 九语字符串完整性检查通过。没有新文案或第三方依赖。

复现主要自动流程：使用项目 `Prompix` scheme 在上述模拟器运行 `PrompixTests`、`DatabaseFeedUITests/testMediaPrewarmsBeyondVisibleCardsWithoutFetchingEntirePage`、`testNextPageStartsBeforeFooterAndStopsAfterLeavingEdge`、`testSavedLayoutSharesSettingsPositionAndPreservesSearch`、`testSavedLayoutAtAccessibilityTextKeepsControlsReachable` 和三个 `testProgressive…` 流程。UI 测试使用独立 UUID 目录，网络延迟由测试闸门控制，不依赖随机公网慢网；真实线上验收另以 `TEST_RUNNER_PROMPIX_DATABASE_LIVE_UI=1` 显式开启。

验收产物位于 `Prompix-Codex/Releases/0.9.1-39/`：`Prompix.app` 为 iOS Simulator Release，`home.png` / `saved.png` 为实际页面，`loading.mp4` 为测试闸门下的局部动效录屏。版本 0.9.1（39）已在 iPhone Air 模拟器安装并运行。未在本轮重测 iOS 17、Duo 或完整 VoiceOver 遍历；未声称经过真机耗电量测量。
