# 0.9.0（38）：展开的卡片

本轮将用户确认的 FIELD / IBM Quantum 参考转化为原生 SwiftUI 视觉语言。保留 Cosmos 式轻盈浏览、真实作品和原生 Liquid Glass 操作；不改数据架构、导航覆盖层、内容排序或采集系统。

## 依据与取舍

- [FIELD Quantum Compass](https://field.io/work/ibm-quantum-compass)：白底、深色文字、局部光谱、放射／聚合的连续形态与有目的的动效。前一轮已查看其项目图和案例录像；案例录像不等于亲自操作原展台。
- [FIELD IBM Quantum](https://field.io/work/ibm-quantum) 与 [Brand Visuals](https://field.io/work/ibm-quantum-brand-visuals)：从统一的几何规则衍生视觉家族。Prompix 使用自行绘制的展开卡片，不借用 IBM 的量子比特图形、品牌资产或科学含义。
- [IBM Color](https://www.ibm.com/design/language/color/) 与 [Animation](https://www.ibm.com/design/language/animation/overview/)：中性色承担阅读，局部颜色建立身份，表达性动画与日常操作分别控制。
- Apple [Motion](https://developer.apple.com/design/human-interface-guidelines/motion)、[Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)、[Materials](https://developer.apple.com/design/human-interface-guidelines/materials)：保留系统操作、已知内容与准确反馈，尊重减少动态效果和减少透明度。

本轮不是把页面全部染成渐变。引导页承担主要的品牌表达，进入内容后只留下小型字标、蓝色操作色和浅色文字封面。第一轮截图中给每张文字卡加了小型图形，复查后移除，避免形成重复水印、与正文争抢注意力。

## 原生实现

- `Theme.swift`：冷白／深墨背景，浅色模式深蓝操作色，深色模式浅蓝操作色；文字卡保留薄荷、淡紫与浅玫瑰的低饱和区分。正文和真实媒体不叠加渐变。
- `SpectralIdentity.swift`：可缩放的原创矢量卡片家族。引导页七页展开，首页和设置缩减为三页标记；不请求图片、不增加依赖、不使用持续渲染计时器。
- `OnboardingView.swift`：进入时仅展开一次，用户可立即翻页或跳过，不等待动画。收藏页仍展示真实内容，第三页保留真实 Prompt 试用与关闭返回，不伪造生成结果。最大辅助字号省略装饰图形。
- 分类下划线在选项之间短距离移动；真实筛选请求不等待动画。减少动态效果时即时切换。
- 创作者与详情缺失内容使用同一局部骨架表面。出现时一次轻微光线掠过后静止，不是循环闪烁或百分比进度；数据到达立即填充，失败沿用原位重试。减少动态效果、减少透明度和非活动状态不显示光线。
- `ReadingGlass` 保持从页面外观解析出的固定 tint，避免交互返回时 UIKit 临时 traits 引起旧版的按钮颜色跳变。
- 首页顶栏仍独立覆盖稳定安全区，沿用 0.8.3 的方向检测与刷新；详情覆盖根 Tab，保留渐进详情、阅读位置和原生返回。图片尺寸与媒体生命周期没有改动。

## 验证与交付

开发证据保存在外置 SSD 的 `Prompix-Codex/Evidence/spectral-native-20261015/`。版本为 0.9.0（38）。本轮未安装用户的物理手机，不把模拟器测试等同于真机性能或苹果编辑推荐。

- `acceptance.xcresult`：原生套件 235 项通过、3 项环境限定测试跳过；10 条 UI 流程通过，覆盖首页收起／反向恢复／筛选复位／刷新、作者占位与失败重试、图片／视频／网页渐进详情、取消与完成手势返回、引导完成／重放／试用，以及英语和德语布局。
- `dark.xcresult`：深色引导与手势返回两条流程通过。截图复查发现第一版引导偶发停留在合拢姿态，随后将几何声明为可插值值，并将入场触发放到已挂载的图形内部；100ms 仅用于装饰图形挂载，不推迟任何按钮或内容。
- `accessibility.xcresult`：深色、最大辅助字号、系统 Reduce Motion 开启时，两条流程通过；包含英语／德语引导、中文阅读／复制／编辑，以及阅读动作的实际点击区域与元素描述审计。测试退出后恢复浅色、标准字号和原有 Reduce Motion 设置。未将此记录当作完整 VoiceOver 遍历。
- `contrast.json`：26 组纯色文字／背景配对的 sRGB 对比度均 ≥4.65:1；玻璃背景随媒体变化，不用这些数值冒充玻璃的逐像素审计。
- 九语字符串检查通过。本轮未新增界面文案或翻译依赖。
- Release 构建成功；`release-welcome.mp4` 实际逐帧检查显示卡片由合拢连续展开、最后停住。第一轮仅流程测试通过时未关闭验收，增加录屏检查后才确认动画。

`final-native.xcresult` 在最终代码上完成三条复验：引导完成／重放、真实 Prompt 试用后返回，以及读取线上 API 的搜索 → 详情 → 创作者作品 → 同模型结果 → 返回保留搜索词。全部通过，无跳过。线上流程使用独立验收目录，不改用户手机的数据。

验收构建为 `Prompix-Codex/Releases/0.9.0-38/Prompix.app`（iOS Simulator Release，不是可装真机的 IPA），短录屏为同目录 `onboarding.mp4`。在 Xcode 27.1 RC 的 Device Hub 选择 iPhone Air（iOS 27.0，UDID `781ED135-F549-496B-8CBA-FE537E801884`）可操作；设置中的“重新查看引导”可重放。Xcode 27.1 SDK 编译，未在本轮重测 iOS 17 或 Duo。
