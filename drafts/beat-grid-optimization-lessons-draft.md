# Beat Grid 优化与踩坑固化草案

## 目的

这份草案不是宣传文档，而是后续继续优化 FRKB 固定 BPM 网格时的工作约束。

目标只有 3 个：

- 固化当前已经验证有效的算法结构，避免以后回退到低水平状态。
- 记录已经踩过且确认无效的方向，避免重复调参、重复自我欺骗。
- 给下一阶段的 BPM 数值研究提供清晰起点，避免把 BPM 问题和首拍相位问题混在一起。

## 当前基线

当前代码主入口：

- `scripts/beat_this_bridge.py`
- `scripts/beat_this_grid_solver.py`
- `src/main/workers/beatThisAnalyzer.ts`
- `scripts/benchmark_beat_grid_against_manual_truth.py`
- `scripts/tune_beat_grid_against_manual_truth.py`

当前本地真值集：

- `sample` 人工真值：34 首
- `truth-sample.json` 的所有样本都来自 `manual-song-cache:library\filterlibrary\sample`

当前 benchmark 基线：

- `refinedMeanGridAbsMs = 2.321`
- `legacyMeanGridAbsMs = 6.953`
- `refinedMeanAbsBpmError = 0.003455`
- `refinedWorstAbsBpmError = 0.038417`
- `refinedMeanAbsDrift128BeatsMs = 1.507`
- `refinedWorstAbsDrift128BeatsMs = 18.579`
- `gridMeanAbsMs > 12ms = 0 首`
- `gridMeanAbsMs > 8ms = 2 首`
- `worsenedTrackCount = 0`

结论：

- 当前默认算法在 34 首样本上，网格整体优于 legacy。
- 当前默认算法没有出现“为了修某些歌，反而把其他样本明显拉坏”的回归。
- 当前已清掉 `>12ms` 的不可接受项，剩余 `>8ms` 样本主要是 BPM 灰区。

## 当前算法结构

### 1. Beat This 只负责候选生成

当前策略不是直接信任 Beat This 第一拍，而是：

- Beat This 输出 `beats / downbeats`
- 每个窗口先算 `rawBpm / rawBeatInterval / rawFirstBeatMs`
- 后续由 anchor 修正、global grid solver、守门逻辑共同决定最终 `firstBeatMs`

这意味着：

- Beat This 是候选生成器
- 不是最终裁判

### 2. 先多窗口准备，再选 anchor window

当前实现会先把多个窗口准备好，再统一比较：

- `_prepare_analysis_windows(...)`
- `_finalize_prepared_window(...)`
- `_select_anchor_window_result(...)`
- `_analyze_prepared_windows_to_track_result(...)`

关键意义：

- 不再只信第一个窗口
- 也不再在 TS 层过早截断分析
- 允许后续接入更强的全局 BPM / 全局 grid 共识逻辑

### 3. 首拍修正是保守策略，不是激进乱推

当前默认链路：

1. `estimate_anchor_correction`
2. `estimate_grid_phase_correction`
3. `positive ambiguity guard`
4. 在默认配置下，`lowband fallback` 实际被关闭
5. 在默认配置下，`head bootstrap` 实际被关闭
6. `solve_global_track_grid` 只在置信度足够时覆盖 anchor window

当前默认参数的关键信号：

- `lowbandFallbackMinMatchRatio = 1.01`
- `headBootstrapMinRawFirstBeatMs = 99999.0`
- `negativeConfidenceMin = 0.91`
- `gridSolverMinRawFirstBeatMs = 160.0`

这组参数的本质不是“更强”，而是“更克制”。

### 4. benchmark 现在已经把网格误差和 BPM 漂移拆开

当前 benchmark 不是只看 `gridMeanAbsMs`，还单独统计：

- `absBpmError`
- `beatIntervalErrorMs`
- `drift32BeatsMs`
- `drift64BeatsMs`
- `drift128BeatsMs`

这一步很重要，因为：

- 首拍相位偏了，不等于 BPM 错了
- BPM 数值略偏，也不等于第一拍就一定错

### 5. dev / rc 下增加了 BPM 风险代理列

当前在 `dev` 和 `rc` 下，歌曲列表会显示：

- `预估128拍漂移`

这个值不是人工真值，而是多窗口 BPM 一致性的风险代理。

它能回答的问题是：

- 这首新歌的 BPM 有没有明显长程漂移风险

它不能回答的问题是：

- 这首歌的 BPM 是否绝对正确

## 已验证有效的优化

### 1. 拆出 `beat_this_grid_solver.py` 是正确的

之前所有逻辑都堆在 `beat_this_bridge.py` 里，不利于继续优化。

现在拆分后：

- `beat_this_bridge.py` 负责桥接、窗口准备、流程编排
- `beat_this_grid_solver.py` 负责 envelope / anchor / solver 逻辑

这个拆分应该保持，不要再回退成单大文件堆逻辑。

### 2. 多窗口优于单窗口早停

已经验证：

- 单窗口局部最优很容易误导第一拍
- 多窗口先准备、再选 anchor / 再做全局判断，整体更稳

后续 BPM 数值优化也必须沿着多窗口方向继续走，不能再退回“单窗口直接拍板”。

### 3. `positive guard` 是必要的

已经验证：

- 原始 raw 第一拍已经比较晚时，再继续往后推，极容易越修越歪
- `Sync Out` 这种歌说明 guard 的存在是必要的

结论：

- 正向修正必须有歧义守门
- 不能因为某几首歌看起来还想再往后贴，就把 guard 放松

### 4. 关闭激进回拉后，整体更稳

已经验证：

- `lowband fallback` 和 `head bootstrap` 在旧样本集上看起来能救个别歌
- 但在样本扩展后，会把本来接近真值的歌拉坏

最终结果是：

- 关闭这两个激进步骤后，34 首样本 `worsenedTrackCount = 0`
- 平均误差反而更低

这说明：

- “看起来更聪明”的补救逻辑，不等于更稳
- 默认策略必须优先选稳定，不优先选花哨

### 5. 将 `raw` 开发分支移除是正确的

之前有一条隐藏逻辑：

- `raw` 歌单强制 legacy anchor

问题是：

- 这会在开发期制造隐式分支
- 容易让人误以为算法在某些歌单上天然表现不同

现在这条逻辑已经移除，只保留 benchmark/tune 中显式的 legacy 对比，这个方向是对的。

### 6. BPM 整数 rescue 必须有 envelope 和窗口质量双重守门

已经验证：

- 简单采用多窗口 `rawBpm` 加权中位数会拉坏样本。
- `Crescendo` 这类歌的多个窗口会一致估快，但人工真值是整数 BPM。
- 只看 Beat This 多窗口一致性，不能证明 BPM 绝对正确。

当前保留的策略是：

- 只处理 `rawBpm` 略微偏离最近整数，且已经超过普通 snap 阈值的情况。
- 同 tempo 类里至少要有 2 个贴近该整数的窗口。
- 贴近整数的窗口质量必须明显高于当前 anchor。
- 全曲 attack envelope 上，整数 BPM 得分必须明显高于 raw BPM。
- 触发后只改 `bpm / beatIntervalSec`，不改 `firstBeatMs` 相位。

当前触发样本：

- `eric sneo - out of step (2024 remake) (1).mp3`
- `leigh boy - rito (platypuss remix).mp3`

这不是歌名特判，而是由窗口质量和全曲 envelope 分数触发。

### 7. 首拍 phase rescue 只能窄触发

已经验证：

- `Sprawling Metropolis` 的 20ms 误差来自近零首拍没有归零。
- `Sync Out` 的 16ms 误差来自 positive guard 挡住正向误判后，仍没有利用其他窗口更早的相位簇。
- `Party All The Time` 的 12.5ms 误差来自 global solver 只做了保守小修正，没有结合低频 attack 归零。

当前保留的策略：

- `snap-zero-lowband`：只在当前相位接近 0，且低频 attack 一致指向 0 时归零。
- `early-cluster`：只在 `positive-guard` 场景下，且至少 2 个质量接近的窗口形成稳定更早相位簇时，才向更早相位移动。

全量结果：

- `refinedMeanGridAbsMs` 从 `3.692ms` 降到 `2.321ms`
- `gridMeanAbsMs > 12ms` 从 3 首降到 0 首
- `worsenedTrackCount = 0`

注意：

- 这不是按歌名特判。
- 触发依据是低频 attack 一致性、相位接近 0、positive guard、跨窗口相位簇。
- 这类规则只能解决首拍 phase，不解决 BPM 长程漂移。

## 已确认踩过的坑

### 坑 1：一点一点拧参数，没有尽头

早期做法的问题：

- 看一首歌偏后一点，就改一组正向修正阈值
- 再看另一首歌偏前一点，就改一组负向修正阈值
- 缺少明确的停止条件

结果：

- 参数越来越多
- 解释力越来越弱
- 对新增样本的泛化越来越差

结论：

- 后续不能再走“单歌驱动的毫秒级微调”路线
- 每次调参必须以整组真值 benchmark 为准

### 坑 2：拿 `new` 当真值

`new` 的职责只能是：

- 新增待观察集
- 当前算法先跑
- 人耳确认后再迁入 `sample`

已经踩过的坑是：

- 容易把 `new` 里“看起来没问题”的结果顺手当真值
- 然后用算法输出反过来证明算法正确

后续规则：

- `sample` 才是真值集
- `new` 在人工确认前，不参与调参闭环

### 坑 3：把 `firstBeatMs` 误当绝对时间，而不是编辑器相位语义

典型案例：

- `Airlock Alert`

踩坑过程：

- 人工值里出现了 `14997ms`
- 直觉上以为这是“首拍在 15 秒附近”
- benchmark 一度把它当绝对时间算，直接把误差炸到 14997ms

后来确认：

- 编辑器里 `firstBeatMs` 允许是 32 拍周期内的包裹相位
- 所以 benchmark 必须按节拍周期做 circular phase 比较

后续规则：

- 任何涉及 `firstBeatMs` 的评估，都先确认是绝对时间语义还是包裹相位语义

### 坑 4：为了修极少数歌，把本来已经准的歌拉坏

典型案例：

- `Take My Love (Original Mix)`
- `Tanciki`
- `Diversity Of Known Substances`

曾经的问题：

- legacy 已经很接近真值
- refined 后处理反而继续强推，导致变差

这个坑必须记住：

- “能修动”不代表“应该修动”
- 如果 legacy 已经很近，refined 应该优先学会闭嘴

### 坑 5：把 BPM 问题和首拍问题混在一起

之前很容易犯的错：

- 看到网格后面越来越歪，就怀疑 `firstBeatMs`
- 看到第一拍差一点点，就顺手去怀疑 `BPM`

后果是：

- 调整方向不清楚
- 修了起点，没修漂移
- 或者修了漂移，反而把首拍搞坏

后续规则：

- `firstBeatMs` 看相位误差
- `BPM` 看长程漂移
- `barBeatOffset` 单独看

### 坑 6：过早整数吸附 BPM

整数 BPM 吸附有价值，但踩坑点在于：

- 太早吸附，容易掩盖真实小数 BPM
- 看起来 BPM 很整齐，长程漂移却更大

后续规则：

- 整数吸附只能作为最后一步
- 必须以“吸附后是否让长程漂移更差”为判断标准

### 坑 7：以为新增调试列会自动有值

已经踩过的坑：

- UI 列加好了
- 旧歌却全部显示 `--`

原因不是 UI 坏了，而是：

- 旧 `song_cache` 根本没有新字段
- 现有分析队列又把“已有 BPM/首拍/小节偏移”的歌当成已完成

后续规则：

- 新增分析字段时，必须同时考虑旧缓存回填策略

### 坑 8：多窗口 BPM 一致不等于 BPM 正确

已经踩过的错误方案：

- 以最终 anchor 的 `rawBpm` 为中心
- 过滤同 tempo 类窗口
- 用加权中位数作为最终 BPM

全量 benchmark 结果：

- `refinedMeanGridAbsMs` 从 3.89ms 恶化到 6.188ms
- `refinedMeanAbsBpmError` 从 0.005823 恶化到 0.017565
- `refinedWorstAbsBpmError` 从 0.071627 恶化到 0.153123

典型反例：

- `Crescendo` 多窗口一致估到 136.153，但人工真值是 136

结论：

- Beat This 的窗口间一致性只能说明模型内部稳定
- 不能拿它当最终 BPM solver
- BPM 修正必须引入音频 envelope 的全局打分，不能只看 beat 时间戳统计

### 坑 9：BPM 修正不要顺手重算 `firstBeatMs`

已经踩过的错误：

- BPM rescue 后，用窗口绝对首拍重新对新 BPM 取模
- `Rito` 的 `firstBeatMs` 从 28.209ms 被改成 20ms
- BPM 漂移变小，但首拍相位误差变大

结论：

- 当前 `firstBeatMs` 是编辑器使用的网格相位
- BPM-only 修正默认只改 BPM，不改相位
- 除非有单独的相位 solver 证明更好，否则不要把 BPM 修正和相位修正绑在一起

### 坑 10：人工真值不能接入运行时分析结果

已经确认错误做法：

- 开发环境对 `sample` 歌单直接返回 `truth-sample.json` 里的人工真值
- 软件界面看起来“分析很准”，但其实不是算法输出
- `beatThisWindowCount / 预估128拍漂移` 这类真实分析调试指标也会因此丢失

后续硬规则：

- 人工真值只允许存在于文档、benchmark、离线评估脚本
- FRKB 软件运行时界面必须始终显示真实分析结果
- 不允许再用任何 dev-only 规则把人工真值注入 UI 分析链路

### 坑 11：固定毫秒全局平移是伪规律

已经验证失败：

- 假设 Beat This 拍点整体滞后 4-12ms
- 然后对所有非零 `firstBeatMs` 做统一提前

全量结果：

- `4ms` 全局平移会让均值从 `3.692ms` 恶化到 `4.9ms`
- `8ms` 全局平移会恶化到 `6.381ms`

结论：

- 少数歌的 8ms 误差不代表存在统一全局偏置
- 这种修法会直接拉坏本来已经对齐的歌

### 坑 12：多窗口相位中值会把量化误差放大

已经验证失败：

- 对所有兼容窗口做 phase weighted median
- 想用多窗口共识替代 anchor window phase

全量结果：

- `refinedMeanGridAbsMs` 从 `3.692ms` 恶化到 `8.143ms`

原因：

- 很多窗口本身就量化在 `20/40/60/80ms`
- 相位中值只是把错误量化做了共识，并没有更接近拍头

### 坑 13：非整数 BPM envelope 局部搜索很容易误伤

已经验证失败：

- 对高漂移歌曲做小范围非整数 BPM 搜索
- 用全曲 envelope 分数挑局部最优 BPM

全量结果：

- 会误伤 `Legowelt`、`Phoenix`、`Scrufizzer`
- 均值从 `2.321ms` 拉坏到 `4.046ms`

结论：

- 当前 envelope tempo score 更适合整数救援，不适合默认非整数微调
- 非整数 BPM 继续优化，必须另找更强的 tempo objective

## 后续优化的硬约束

### 1. 不允许按歌名特判

禁止：

- 文件名白名单
- 歌名黑名单
- “这首歌就特殊一点”的分支

允许：

- 基于信号特征触发的通用逻辑
- 基于多窗口一致性触发的通用逻辑

### 2. benchmark 优先于体感

体感可以发现问题，但不能作为参数终裁。

后续任何默认参数变更，都至少要回答：

- 34 首 `sample` 上均值是否更好
- `worsenedTrackCount` 是否增加
- `worstGridAbsMs` 是否恶化

### 3. 默认策略优先稳，不优先激进

默认策略的目标不是：

- 把某几首难歌修到最好看

默认策略的目标是：

- 尽量降低均值
- 不引入明显回归
- 给人工复核保留可解释空间

### 4. BPM 和网格要拆开推进

后续工作必须拆成两条线：

- 网格起点 / 相位
- BPM 数值 / 长程漂移

不能再混成一个“总觉得不准”的大问题。

## BPM 数值问题的下一阶段入口

当前判断：

- `sample` 里的 BPM 真值可信
- 当前 BPM 输出整体靠谱，并已有第一版保守整数 rescue
- 当前 `预估128拍漂移` 只是风险代理，不是真正的 BPM solver

下一阶段最值得做的 2 件事：

### 1. 非整数 BPM 的全局拟合

目标：

- 处理 `Legowelt`、`Phoenix Movement` 这类真实小数 BPM
- 不被整数 envelope 峰值误导
- 只在能证明全局更优时覆盖 raw BPM

建议路线：

1. 保留当前整数 rescue 作为窄触发补丁
2. 对非整数候选做 envelope tempo curve，而不是只取最大峰
3. 引入跨窗口 rawBpm 趋势、窗口质量、envelope 峰宽共同判断
4. benchmark 必须同时看 BPM drift 和 grid phase，防止只修漂移、拉坏相位

### 2. 高漂移歌曲自动二次分析

目标：

- 不再把高风险 BPM 直接交付

建议路线：

- `预估128拍漂移 < 10ms`：直接接受
- `10ms - 30ms`：标记为注意
- `> 30ms`：自动触发第二轮分析
- `> 80ms`：高优先级人工复核

第二轮分析建议：

- 更长扫描范围
- 更多窗口
- 更强窗口筛选
- 明确处理半拍 / 倍拍歧义

## 当前不该做的事

- 不要继续给默认策略增加更多低频 fallback / bootstrap 特判式逻辑
- 不要继续按某一首歌的主观听感去改全局默认参数
- 不要把 BPM 数值问题伪装成 `firstBeatMs` 问题继续调 anchor
- 不要在没有整组 benchmark 的情况下宣布“现在已经彻底解决”

## 结论

当前网格线算法已经从“单窗口第一拍 + 零碎补丁”进化到：

- Beat This 候选生成
- 多窗口准备
- 保守 anchor 修正
- 正向歧义守门
- 受限 global grid solver
- circular phase benchmark
- BPM 长程漂移风险代理

这已经是一个能继续往上长的工程骨架。

后面继续优化时，最重要的不是再多发明几个毫秒参数，而是守住这 4 条：

- 不按歌名特判
- 不混淆 BPM 与相位
- 不让新补丁拉坏旧样本
- 不脱离 benchmark 靠感觉推进
