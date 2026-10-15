# 0.8.2：等待时可浏览，读完后可继续发现

本轮调研开始于 0.8.0（34），实现整合 0.8.1（35）的分页目录、首页最新排序、原生阅读页和绿色设计系统为基础，模拟器验收版本为 **0.8.2（36）**。范围是创作者等页面的加载体验，以及详情末尾的关联探索。没有改变内容来源、个人数据格式或底部导航。

## 调研与取舍

2026-10-15 02:17:08–03:20:44 UTC，约64分钟，用于竞品阅读、实际网页操作、商店截图、既有原生录像复核和当前产品对照。不是64分钟新的 Cosmos 真机操作：本次 WDA 因手机自动操作授权失效未能启动；没有要求用户中断工作重新授权。此前授权录制的 Cosmos 真机素材保留在开发机外置盘。公开页面中的登录限制、网站验证没有绕过。

| 参考及证据 | 观察 | Prompix 的具体取舍 |
| --- | --- | --- |
| [Cosmos Explore](https://www.cosmos.so/explore)、公开单件详情的加载前后画面、[官方 Discovery 说明](https://help.cosmos.so/en/articles/11717949-discovery) | 图片可先显示，关联收藏集信息稍后填入；作品还能通向相关内容与收藏集。 | 先显示已知身份和作品；加载限制在未知区域。详情提供继续探索的明确路径。 |
| [Lexica](https://lexica.art/)：实际打开单件详情并点击 Explore this style | 来源图片保留为搜索上下文，复制、编辑和继续发现是不同动作；结果不总是语义精确。 | 明示按用途、模型或作者查找，不把普通标签过滤称为 AI 相似推荐。 |
| [Are.na](https://www.are.na/) 的 Connect 产品演示 | 内容通过所属集合串联出新的上下文；演示本身也出现居中加载。 | 借鉴关联路径，不照搬加载画面。 |
| [mymind](https://apps.apple.com/us/app/mymind-extend-your-mind/id1520332347)、[Savee](https://apps.apple.com/us/app/savee-inspiration-for-you/id1375238218) 商店图片与官方介绍 | 保存反馈克制，图像与个人组织优先，元数据不过度挤占作品。 | 保留简洁瀑布流，将新控件放在阅读结束处；不加逐卡图标和首页推荐模块。 |
| [Mela](https://apps.apple.com/us/app/mela-recipe-manager/id1548466041)、[Crouton](https://developer.apple.com/news/?id=9x75y43e) | 阅读与执行围绕当前任务组织；Mela 商店图中的烹饪模式弱化其他步骤。 | Prompt 正文仍是一级内容。后续“使用”功能围绕用户任务，而非添加装饰面板。 |
| [Tide Guide](https://apps.apple.com/us/app/tide-guide-charts-tables/id1406371071) 商店图、[Apple 2026 Design Awards](https://www.apple.com/ie/newsroom/2026/06/apple-reveals-winners-of-the-2026-apple-design-awards/) | 重要信息有清楚的视觉主次；控制服务于内容。 | 保留已有原生玻璃操作层，避免把新探索入口也做成浮动玻璃堆叠。 |

苹果的 [Loading](https://developer.apple.com/design/human-interface-guidelines/loading)、[Motion](https://developer.apple.com/design/human-interface-guidelines/motion) 和 [Searching](https://developer.apple.com/design/human-interface-guidelines/searching) 指南是实现依据：尽早呈现可用内容、加载时允许其他操作、避免频繁交互中的无意义动效，并清楚表达查询范围。这些原则不等于禁用所有进度指示器；明确的下载、保存及分页操作仍可使用原生进度反馈。

PromptBase 的公开 UI 遇到网站安全验证，未继续。商店图片与发行说明只作为静态设计或作者陈述，不作为性能、动画或真机操作的实测证据。第三方素材没有加入仓库。

## 已实现

### 分区加载与缓存连续性

- 创作者的姓名、头像、简介、外链、收藏与筛选入口不等待作品请求。
- 已在首页或搜索中加载的同作者/模型作品可立即预览；最多6条，按身份去重，校验语言、类型与下架状态。这些预览不是完整结果页，不生成数量或翻页游标。
- 已缓存的第一页在后台复验期间继续显示；首次没有内容时显示与作品/作者列表相符的静态占位。没有循环闪烁、假进度或虚构内容。
- 请求失败后保留可浏览内容并原位重试；只有确认没有结果后才显示空态。切换条件立即隐藏旧条件的结果，避免搜索防抖期间显示错作者或错类型。
- 头像首帧读取内存缓存，异步结果按 URL 归属，减少进入创作者页时重新显示首字母的闪动。
- 首页与创作者入口使用同一套局部占位；分页底部仍使用稳定的原生加载动作，不自动拉取整个目录。
- 占位不接受触摸，辅助功能只暴露一个加载说明；静态实现不依赖动画，也不因 Reduce Motion 改变信息含义。

### 从一条内容继续探索

详情正文和来源之后提供“继续探索”：

- **同用途**：仅当条目匹配已有用途定义时出现，名称和查询复用现有多语言专题。
- **同模型**：按条目真实模型字段查询，允许跨内容类型。
- **同作者**：按稳定作者身份查询，不按显示名模糊匹配。

切换路径只更新该区域。四条预览之外可打开完整分页列表；列表明确保留当前范围，排除出发条目本身。返回详情保留选择，关闭详情仍回到原搜索和原底层导航。未增加推荐服务、向量索引或新的后台任务。

## 后续功能建议（本版未实现）

1. **按项目组织的私人收藏集**：例如“我的品牌官网”，将图片参考、网页 Prompt 和相关 Skill 放在一起，并保留自己的变量与草稿。优先验证整理成本是否低于反复搜索，而不是先做社交关注系统。
2. **最近使用与继续修改**：让用户回到自己真正复制、编辑或交接过的内容。只存本地可清除记录，明确区分“已打开工具”和“已执行成功”。
3. **Spotlight / Shortcuts 复用收藏**：从系统搜索找到已收藏的 Prompt，再按已有工具交接规则使用。先做个人内容和明确动作，不自动向外部模型发送。

视觉相似搜索和自然语言智能推荐暂不优先：应先测相关性、稳定性与成本。现在的模型/用途路径有明确来源和可复现结果。

## 验收与交付

2026-10-15，在 iPhone Air 模拟器（`781ED135-F549-496B-8CBA-FE537E801884`，iOS 27.0）完成，使用 Xcode 27.1 RC。原始材料根目录为开发机外置盘 `/Volumes/Lucy-SSD/Prompix-Codex/Evidence/discovery-polish-20261015/`。

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 原生测试 | 执行238项，235通过、3项环境限定测试跳过、0失败 | `tests/integrated-2.xcresult` |
| 集成 UI | 5项通过：创作者目录查询竞态、已有作品/失败重试/筛选空态/缓存、探索分页与返回、首页最新排序与下拉刷新、线上创作者与探索 | 同上；`tests/integrated-2.log` |
| 最大辅助字号与深色 | 单列探索入口、完整结果页、返回选择保持，1项通过；截图已人工检查 | `tests/accessibility.xcresult`；`polish-accessibility-*.png` |
| Release 构建与线上运行 | 0.8.2（36）构建成功；相同 UI runner 指向 Release App，真实搜索→详情→创作者→模型列表→返回搜索，1项通过 | `tests/release-082.log`、`tests/release-live.xcresult`、`release-live-demo.mp4` |
| 九语界面 | 269个通用键、17个引导键、6个使用面板键，九语完整性检查通过 | `python3 scripts/check-localizations.py` |

关键截图：`polish-01-known-work-before-response.png` 是受控延迟下已知作品先呈现；`polish-03-filter-local-placeholder.png` 是切换条件时仅作品区域占位；`polish-02-inline-profile-failure.png` 是请求失败仍保留已知内容；`polish-live-02-creator.png`、`polish-live-03-continue-exploring.png`、`polish-live-04-model-results.png` 来自 Release 包的真实线上内容。测试中的 Database Author / Model 0 是隔离的合成夹具，不是发布内容。失败尝试及其日志保留，最终依据是上表的成功结果。

Release 包保存于 `/Volumes/Lucy-SSD/Prompix-Codex/Releases/0.8.2-36/Prompix-simulator.app`，已在上述模拟器安装启动，Device Hub 已选中 iPhone Air；深色与最大字号验证结束后恢复为浅色、系统 Large。未安装或改动用户物理手机。

### 复现

在仓库执行以下命令（将结果路径设为尚不存在的新目录）：

```sh
export DEVELOPER_DIR=/Volumes/Lucy-SSD/Prompix-Codex/Toolchains/Xcode-27.1-RC.app/Contents/Developer
export TMPDIR=/Volumes/Lucy-SSD/Prompix-Codex/Temp-discovery-polish
xcodebuild -project ios/Prompix.xcodeproj -scheme Prompix \
  -destination id=781ED135-F549-496B-8CBA-FE537E801884 \
  -derivedDataPath /Volumes/Lucy-SSD/Prompix-Codex/DerivedData-DiscoveryPolish \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  -only-testing:PrompixTests \
  -only-testing:PrompixUITests/DatabaseFeedUITests/testCreatorDirectoryUsesLocalPlaceholdersAndClearsPreviousQuery \
  -only-testing:PrompixUITests/DatabaseFeedUITests/testCreatorPreviewSurvivesFailureAndFilteringNeverShowsOldResults \
  -only-testing:PrompixUITests/DatabaseFeedUITests/testExplorationChangesScopePagesAndKeepsItsSelectionWhenReturning \
  -only-testing:PrompixUITests/DatabaseFeedUITests/testHomeUsesLatestOrderWithoutLaunchBannerAndPullRefreshes \
  test CODE_SIGNING_ALLOWED=NO
```

真实内容旅程另选 `testLiveCreatorAndContextualExploration`，加 `TEST_RUNNER_PROMPIX_DATABASE_LIVE_UI=1`。最大辅助字号测试选 `testAccessibleExplorationKeepsPathsAndResultsReachable`，加 `TEST_RUNNER_PROMPIX_EXPLORATION_ACCESSIBILITY=1` 并先设置模拟器字体为 `accessibility-extra-extra-extra-large`；结束后恢复原设置。Release 复验使用证据目录的 `tests/release-acceptance.xctestrun`，其 `UITargetAppPath` 明确指向 Release 构建。

手工验收：从首页进入创作者，观察身份先出现；从搜索中打开“盐水礼服”，点作者查看作品，返回并读到正文末尾，切换“同模型 / 同作者”，点“查看全部”，再返回详情和原搜索。离线/慢请求的确定性复现使用上述 UI 夹具，不需要修改生产 API。

### 边界

本轮没有重新做物理手机性能测量，也没有进行 VoiceOver 听读的完整人工验收；最大字号和可操作性测试不能替代这两项。线上结果随目录更新而变化。关联是明确的目录条件，并非视觉相似或个性化推荐；没有新增付费服务。是否值得编辑推荐仍需长期产品质量与实际使用反馈评估，本轮不作保证。
