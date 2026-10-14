# 0.5.1（22）iPhone 验收反馈修正

2026-10-14，范围依据用户四张真机截图：创作者仅三个、首页滚动阴影和留白、图片下滑关闭、收藏页顶部空白及三个 Tab 图标。复用现有原生导航、设计系统、分页缩放和数据层，未扩大为折叠屏或采集改造。

## 已实现

- **创作者**：原常规首页独立写死 `prefix(3)`，并非目录只有三个。改用头像加名字的横向懒加载列表，展示当前全部实际作者，保留查看全部。辅助字号／VoiceOver 使用已有展开入口与完整目录。
- **首页顺序**：固定分类 → 创作者 → 按用途探索 → 内容数量／筛选 → 单条连续瀑布流。删除前八项与其余项之间的切分，短列不会再为中间专题等待长列；内容排序保持。
- **顶部**：隐藏与固定不透明分类重复的系统顶部滚动边缘效果；导航栏跟随当前明暗模式，避免深色图片滑到下面时让浅色顶栏的文字变白。
- **图片**：保留详情放大入口；全屏用小关闭按钮，支持下拉原生缩放返回、轻拖取消、双击／双指缩放及横向分页。放大时单指拖动只平移，不误关闭。减少动态效果及 iOS 17 使用不缩放回原位的关闭回退。
- **收藏**：紧凑内联标题、紧邻其下的原生搜索与设置入口，移除原大标题空区。
- **Tab 图标**：等光学尺寸的线性指南针、网格、心形，保留原生选择、绿色和系统命中区域。

## 实际验证

设备为专用 iPhone Air 模拟器，iOS 27.0 runtime，Xcode 27.1 RC；真实缓存目录 531 条。证据在仓库外 `Prompix-Codex/Evidence/iphone-feedback-20261014/`，不提交第三方图片或个人资料。

| 结果包 | 实测范围 | 结果 |
| --- | --- | --- |
| `prompix-feedback-first.xcresult` | 首页创作者横滑、专题顺序、四轮连续滚动两列空隙检查、收藏紧凑搜索及设置返回；图片放大平移与下滑还原 | 2 项通过 |
| `prompix-feedback-gestures.xcresult` | 增补 35 点轻拖取消、200% 放大平移不关闭、100% 下滑返回原位置、重新打开与关闭；真实四图加载、前后操作、横滑及缩放 | 2 项通过 |
| `prompix-feedback-motion.xcresult` | 系统 Reduce Motion 确实开启，深色下双击放大／还原、下滑退出 | 1 项通过，无条件跳过 |
| `prompix-feedback-large.xcresult` | 最大辅助字号＋深色：创作者入口、收藏标题／搜索／设置、返回；收藏命中区域和元素描述审计 | 1 项通过 |

九语字符串检查通过，主表 246 个可译键与引导表 15 个可译键完整。本轮没有新增文案键。已逐张检查首轮页面截图和图片转场帧，图标最终采用轮廓版本，避免系统将全部图标填实。

### 可复现

使用已有真实目录缓存的专用普通 iPhone 模拟器，运行以下选择项；`GlobalDiscoveryUITests` 的目录来自外部内容服务，不能把第三方内容写入仓库。测试会使用该测试模拟器原有收藏，不指向用户手机。

```sh
xcodebuild -project ios/Prompix.xcodeproj -scheme Prompix \
  -destination 'id=<dedicated-iPhone-simulator>' \
  -collect-test-diagnostics never \
  -only-testing:PrompixUITests/GlobalDiscoveryUITests/testHomeSectionsContinuousFeedAndSavedHeader \
  -only-testing:PrompixUITests/DiscoveryTests/testImagePreviewDragDismissAndZoomProtection \
  -only-testing:PrompixUITests/DiscoveryTests/testLiveImageGallery \
  test CODE_SIGNING_ALLOWED=NO
```

开启模拟器 Reduce Motion 后单跑 `testReducedMotionImageZoomAndReturn`；设最大辅助字号及深色后单跑 `testSavedHeaderAndCreatorEntryAtLargeText`，结束后恢复设置。实际使用时可依次横滑作者、向上连续浏览、打开图片轻拖／下拉、双击放大后平移、切换收藏并打开设置。

## 验证边界

本轮验证这些明确反馈的交互和布局；没有声称完成所有系统版本、所有九语页面、全量辅助功能、长期真机性能或折叠屏复验。iOS 17 的手势回退保留但未独立实跑。模拟器通过不代替用户的审美与真机验收，不承诺获得编辑推荐。

## 本地签名候选

源码 `27f476a` 已完成 Release 归档和开发 IPA 导出，独立签名／资源／版本审计 39 项通过。IPA 为 7,894,917 字节，SHA-256 `f2914c7277cf23f169146b48784cd2a93cd1eb72fb960c0b0637fb586629b880`。产物在本机外置盘 `Prompix-Codex/Releases/0.5.1-22/`，包含归档、开发包、审计报告与日志。未上传 App Store。

模拟器已恢复普通字号、浅色与正常动态效果，保留新版验收现场。安装前检查未检测到 USB iPhone；先前验收用的 iPhone Air 也无法建立无线连接，因此本轮尚未覆盖安装用户手机，用户已收到连接提示。不能把签名成功写成真机安装完成。
