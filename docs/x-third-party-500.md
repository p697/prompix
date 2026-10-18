# 全第三方采集与500条历史验收

2026-10-18用户确认：不再调用官方X API；翻译用既有Codex订阅的`gpt-6-luna`，先完整处理500条，展示实际质量、成本和耗时，用户确认后再扩到10,000。总采集月预算仍为$10–20，额外预算或充值须另行确认。

## 本轮实现

- `PROMPIX_X_DISCOVERY_PROVIDER=third-party`选择完整第三方获取。`PROMPIX_X_OFFICIAL_ENABLED=0`在所有官方HTTP入口记账前拒绝请求，即使旧命令或备用分支仍被调用也不会产生官方费用。
- TwitterAPI.io搜索计划继续跨创作者、主题和时间窗口发现。正文按ID取得完整快照，真实获取方随源记录保存；原始HTTP响应在解析之前落到仓库外。第三方未知ID不冒充明确删除。
- 补充视频检索及回复链也走第三方，分页游标单独存放，旧请求与金额账本保留。回复页耗尽后补取未返回的根帖；根帖、父链、作者、完整原文、媒体和时间关系全部通过才进入待审核队列。
- 第三方复查可同时核验完整依赖链，单帖结果不能代替整链验证。变动产生新来源版本，仍为待审核草稿；来源缺失暂缓可用性，不永久删除。每个服务商沿用原有保留请求及原始响应路径。
- 模型默认值更新为`gpt-6-luna`，实际运行环境还须同步模型与`PROMPIX_CODEX`。不修改已有翻译的模型溯源；不转付费OpenAI API。

## 实测与未完成关口

- 新版桌面App内置Codex CLI 0.163.0-alpha.10.2成功完成两段结构化简中翻译，约8.2秒，参数和固定标题保留；模型API增量费用为0。这是连通性样本，不代表500条全部翻译已完成或订阅吞吐已验证。
- 本机Homebrew CLI 0.153.3返回模型不支持；应显式配置实际通过测试的CLI，不能仅依赖PATH。
- RapidAPI首轮8/50/100/200 ID对照仍是此前实测结果。此次间隔复测发生传输失败，失败请求保持占额，不能冒充通过或自动清零重跑。后续复测通过前使用TwitterAPI.io维护，不切RapidAPI生产。
- 普通每日发布与历史批处理使用独立有界调度；500条应计为完成全部质量、媒体、尺度、去重和翻译处理的样本，不能用抓到的原帖或待审核草稿凑数。
- 500条验收必须报告：搜索返回、唯一来源、可用完整Prompt、编辑拒绝/暂缓、媒体验证、尺度分布、翻译完整率、最终样本数、已发布数、实际费用及耗时。前期试验成本单列，不摊成历史单条成本。

- 离线测试：713项通过、2项跳过；新增部分批次预算耗尽与来源变更重读回归另行验证。真实历史响应回演：TwitterAPI.io的45个返回对象得到34份完整草稿，实际来源标识正确；RapidAPI的191份样本中190份完整、6份回复链全部完整，1份已知地区限制保持暂缓。这不是新一轮线上召回率测量。

## 切换与回滚

按独立worktree、PR、CI及受保护安装器部署。切换前保留旧runtime、环境配置和内容状态摘要；共享账本与未决尝试不得回滚。先离线回演保存的真实接口响应，再有界生产验证。只有验证通过后才恢复采集排程。

回滚代码时仍保留`PROMPIX_X_OFFICIAL_ENABLED=0`；不得恢复旧版自动官方回退。若旧runtime不识别此开关，先暂停排程，不能启动它产生官方费用。用户未提交的主checkout设计草稿保持原样。

## 独立500条验收队列

`node --import tsx scripts/run-history-cohort.ts /external/cohort --execute` 按不可变配置和批次逐步处理，`--one-batch`用于第一批真实接口验收。无`--execute`只读取状态。所有运行目录必须在Git外，操作人预先填写`configuration.json`：

```json
{
  "version": 1,
  "target": 500,
  "maximumSources": 1500,
  "maximumSearches": 750,
  "baseline": "/external/verified-baseline.json",
  "sharedRoot": "/external/production-content",
  "searchPlans": ["/external/july-plan", "/external/august-plan"],
  "seedTranslations": "/external/validated-translations"
}
```

配置初次运行后锁定；基准允许经过验证的v1或v2原文目录。`extraLeads`可选，指向已获取、尚未发布的历史线索文件。现有搜索计划和响应直接复用，不重新付费测试。模型和X凭据从现有外部环境配置加载，要求第三方模式、官方关闭、无活动官方凭据、Codex提供方以及`gpt-6-luna`。共享X账本的月上限不得高于$20。

- 每批最多50个来源，整个验收最多1,500个来源尝试、750次搜索；已分配但拒绝或未决的ID也排除重复获取。先轮转不同创作者，每批每位最多3条。当前这条历史通道处理完整视觉Prompt；日常链路继续处理回复和Skill，不声称历史脚本已覆盖它们。
- 每批最多64次正文审核、64次视觉审核、200次翻译调用。它们是用户授权的单次500条历史任务的独立预算，不清零或挪用日常账本，不提高每日100条公开发布上限。批次审核账本沿用创建日期，跨午夜不会重置；中断的付费获取和模型审核先检查证据，不能新建批次重跑同一ID。
- 正文审核复用现有完整性、质量及安全标准；全部图片、视频封面与六个代表帧经过已有视觉流程，保持画面尺度标签。媒体复用日常镜像函数和持久映射，失败后已完成对象不重复上传。视频仍是代表帧审核，不声称逐帧检查。
- 九语翻译复用有溯源的已验证缓存，仅新增翻译指定`gpt-6-luna`。完整样本还须来源新鲜、具有明确画面标签、媒体地址不可变、九语字段校验通过，且与基准及此前批次去重。旧缓存不会伪装为新模型产出。
- `catalog.staged.json`、逐批`report.json`和整体`progress.json`给出完整样本、暂缓/拒绝、耗时和令牌量；`published`固定0，因为此命令不激活数据库或公开发布。达到500时停在`awaiting-user-acceptance`，不能自动进入10,000。交付时另做翻译和视觉抽样，分别报告历史沉没测试成本、此任务实际调用费用、存储费用与订阅使用量。
- 源记录24小时后须重新核验；陈旧完整文件不会被计作当前可发布样本。若输入、审核或金额上限阻塞，状态写为blocked并保留所有原始证据。修复后从原批次继续，不能删除账本重新开始。

本轮本机全套722项通过、2项跳过，另补空批次持久化回归（针对全部拒绝的批次），类型检查通过。真实500条尚在处理，不能以代码测试代替数据质量验收。

首批实跑还发现通用ChatGPT模型名覆盖视觉生成意图的分类缺陷。新增规则须同时有明确图片/视频创作指令与对应媒体，普通看图分析仍为文本；补充ChatGPT images模型线索。68项相关测试通过；对当前375份真实X来源离线比较，仅3份未发布草稿由文本修正为图片，已发布条目无分类变化或丢失，不产生新付费读取。正文/视觉审核仍须独立通过，分类修复不自动授予批准。

首批真实链路已取得50份第三方完整来源；正文审核、去重后38份，媒体准备38份均成功，视觉审核后35份进入九语翻译，尚未计作完整验收成品。单独抽查两份长Prompt发现`mid-century`被错解为中世纪（旧元数据标题及新简繁译文）；已登记精确译文拒绝记录，加入术语指导，修复必须通过原批次重新验证。自动字段校验不等于语义质量通过。

历史翻译最多三轮增量修复，失败反馈明确列出丢失或重复的保护标记，响应在验证前保留于仓库外。反复未通过内容校验的条目逐条暂缓，既不计入500，也不阻塞同批九语完整的合格条目；来源ID仍保留在原分配表，不能重新建批重复计数。模型服务故障或请求额度耗尽继续阻断队列，不能通过逐条暂缓绕过运行边界。

响应证据定位出一个误拒原因：`early 20s`的年龄复数被保护成秒数单位。年龄／年代语境改为只保护数字，让复数词尾正确翻译；真实`20s`时长和`24fps`等参数仍整体保留，并有独立回归验证。

人工抽查另发现视觉文字变量的赋值被翻译：只保护`[CITY]`标记无法保留它最终渲染的字面值。对后文明确用于字体、标题或标语排版的变量，同步保护其赋值；普通主体描述仍可翻译。受影响样本须重新验证，不能把旧译文算作通过这一修复。

已完成的批次文件仍须在每次汇总时应用最新人工质量暂缓与下架记录，不能靠缓存绕过后续抽检结论。首次抽查还发现一份视频依赖未提供的旧分镜，需补齐上下文后才可验收；正文完整抓取不等于输入材料齐全。

后续原文对照发现多行字幕、明确指定语言的对白和未加引号的大写结尾文案可能被翻译，改变生成画面的文字要求。新增保护覆盖这些明确字面输出，场景说明仍须翻译；用独立合成样例验证边界，不把第三方正文放入仓库。既有完成条目须经过新规则回查并增量补译，不能只对新数据生效。另以Codex订阅进行简中与轮换第二语言的语义复核，模型疑点由负责人核对后决定，不把自动疑点数当成真实错误数或九语全面语义验收。

完成计数同时应用当前精确语义拒绝记录。队列会自动回到受新规则影响的原批次，先保留旧完成文件，再复用原来源、审核、媒体及翻译账本修复；不会另建来源批次、重置调用额度或因本批已完成的兄弟条目去重而丢失它们。

本次字面输出与回查修复：本机全套730项通过、2项环境限定跳过，类型检查通过；另验证已有完成文件在回查遇到旧未决获取时仍阻断，不清零来源账本。真实37条进行了简中及轮换第二语言的独立语义比较，疑点由负责人逐条核对；该范围不能写成500条已验收。

额外真实样本仍出现mid-century误解，简繁中文字段校验增加确定性拦截：源文无medieval／Middle Ages时，不接受“中世纪／中世紀”。明确标注解说员或旁白的逐字台词也保留原文。模型复核曾错误声称角色动作对调，负责人对照完整原文后撤销该误报。

后续对照发现，“画外音立即赞赏”这样的提示没有“说”字，原有对白识别会漏过。画外音、旁白、voice-over和off-screen voice后的逐字引语也纳入保护；普通情绪描述及镜头说明仍翻译。已有受影响条目通过原账本增量补译，不重复获取来源，不算作新增成品。

扩库路径审计发现，日常译文恢复错误地用最多1,000条的旧客户端下载规则读取本地完整库。改用现有数据库全库发布验证，保留100,000条上限、原文逐字节内容以及重复／已删除ID校验；旧客户端下载上限保持1,000条。用1,201条带译文的合成库验证末尾条目也能复用，无需重新调用模型。这是本地恢复边界验证，不代表10,000条真实补库已完成。

500条实跑表明媒体准备和九语翻译是主要耗时。历史队列采用最多三路媒体处理及三路翻译，沿用原有模型请求总上限。媒体会话共享同一URL的在途结果，串行保存映射与宽高比，结果按来源顺序返回；普通图片失败逐项保留，文件持久化失败仍阻断整个批次。测试覆盖并发上限、重复URL只上传一次、所有缓存条目保留、失败后续传及文件写入故障。逐阶段时间另行保留，提速幅度须以真实后续批次为准。

历史实跑另发现正常模板输入被误判为缺失来源：用户填写日期、人物、画面文字或上传自己的参考图，本身不构成不完整。编辑指令现区分普通用户输入与缺失的特定原文／前序分镜，要求使用建议说明需要准备的输入。保留来源预览、正文完整性和所有后续审核。两次Codex订阅调用对照三条真实误暂缓案例及三条自编负例：三个完整模板获准进入后续审核，缺失分镜、私有说明和宣传预告仍暂缓；该验证不直接修改它们既有审核结果或发布任何条目。38项相关自动测试及类型检查通过。

JSON提示词中的渲染引擎名称（如多个引擎组合）不是需要汉化的自然语言。渲染引擎字段纳入既有不透明参数保护，要求译文逐字保留；回归覆盖旁边的场景说明仍需翻译，以及改动引擎名称必须拒绝。

## Display constraints during translation

The 500-item trial exposed a gap between segment validation and complete-record validation: a correctly translated French cover eyebrow could exceed the existing 40-character UI limit, leaving a record incomplete while the segment queue reported zero pending work. Short-label segments now carry a hard masked-output length bound, adjusted for the actual length of protected syntax after restoration. Shared segments keep the strictest applicable bound. Oversized cached or newly returned labels remain pending and only those segments are retried, using the original cumulative request allowance. Title, preview-label and cover limits remain unchanged; full prompt and usage prose are never abbreviated to meet a label budget.

Visual translation also protects mixed-case product copy after an explicit branding-text cue, plus fixed series names and numbered title alternatives in typography-poster templates. Scene directions remain translatable. Previously accepted translations are revalidated against these exact source literals; changed masks affect only the relevant fields. The capture, editorial, visual and publication gates remain independent.

### Structured age context

The historical acceptance audit found that an isolated JSON `age` value such as `Early 20s` could be translated as a calendar decade after its key was omitted from model input. Age/age-range leaves now carry explicit context and a separate cache identity; array values retain their parent field context. Fresh, cached and inherited localizations reject unambiguous decade wording in Chinese, Japanese and Korean. Existing prompt semantics and quality gates remain in force, and affected pilot records must be retranslated and reviewed before acceptance. This fix is not a claim of full semantic verification in all nine languages.
