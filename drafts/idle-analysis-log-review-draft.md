# 闲时分析挂机后日志核验草案

## 用途

这份文档用于在下次挂机结束后，基于新的 `log.txt` 开一个新对话，快速验证：

- 闲时分析是否继续正常调度
- `key / bpm / waveform` 的完成率是否明显提升
- 是否还存在大批量 `decode-start` 或 `waveform-start` 超时
- 波形失败时，`key / bpm` 是否已经先落盘
- 深度闲置时后台是否已经放开更激进的并发
- 未打开过的歌单根目录是否也能被闲时分析发现
- 是否存在“打开歌单后才新增候选”，导致看起来像“挂机没补完”但其实是候选池变大了
- 自动混音相关闲时任务是否已经优先于 `key-analysis` 执行

## 本次夜挂机样例结论（2026-03-11 18:00 到 2026-03-12 08:56）

这次样例日志可以先当成“通过样本”，后面新一轮挂机主要拿它当对照：

- 闲时分析真实持续在跑，不是假调度
  - `开始一轮闲时扫描` 共 `616` 次
- 后台分析主链路这次很干净
  - `分析阶段完成并已落盘` 共 `1841` 次
  - `后台任务完成摘要` 共 `1841` 次
  - `任务执行超时，终止 worker / 失败文件诊断 / Worker 崩溃` 全部为 `0`
- 这次已完成任务里，`key / bpm / waveform` 都已落盘
  - 已抽样并统计，本轮 `1841` 条完成摘要里三项都是 `true`
- `decodeBackend` 这次全部为 `symphonia`
  - 说明主解码链路这次跑通了
  - 但也说明 `ffmpeg / ffmpeg-fallback` 这次**没有被覆盖验证**
- `deep-idle` 时已经看到 `aggressiveConcurrency: true`
- 当三类后台任务同时排队时，实际执行顺序符合预期：
  - `mixtape-stem-resume`
  - `mixtape-waveform-hires`
  - `key-analysis`

这次仍然**没有**被日志证明的点：

- `ffmpeg / ffmpeg-fallback` 是否正常
- `fileSystemOnlyRootCount > 0` 的场景是否能稳定发现未打开歌单
- “现在是否已经全库补完”
  - 日志只能证明“本轮被选中的任务跑得干净”
  - 不能单靠日志断言“库里已经没有剩余待分析歌曲”

这次样例还要额外记住一件事：

- `2026-03-12 08:57` 之后出现过两次 `gss-loader open-start`
- 但这两次 `song-search index rebuilt, docs=...` 仍然都是 `3571`
- 说明这次早上打开歌单**没有**导致候选集继续变大
- 所以这次不能套用“候选池被重新扩大”的结论

## 挂机前操作

请先确认以下事项：

- 已重启应用，确保加载了最新主进程代码和最新 `rust_package`
- 已点击一次“清理脏数据”
- 挂机期间尽量不要操作电脑
- 挂机开始后不要切换库区、不要切换歌单、不要手动点开新的 song list
- 如果本轮要验证“未打开歌单也能被发现”，挂机前更不要手动打开 `FilterLibrary` 里原本没打开过的歌单
- 保留本次挂机结束后的最新 `log.txt`

## 挂机结束后需要提供的信息

开新对话时，尽量一次性提供这些信息：

- 最新 `log.txt`
- 挂机开始时间
- 挂机结束时间
- 挂机前是否点击了“清理脏数据”
- 挂机前是否重启了应用
- 挂机期间是否切换过库区或歌单
- 现在仍未分析完成的大概歌曲数量
- 如果方便，补一句哪些字段没出来：
  - 只有 waveform 没出来
  - 还是 key、bpm、waveform 都没出来
- 如果方便，补一句挂机期间是否看到列表数量明显变多
  - 例如某个歌单从几百首突然变成上千首
  - 或者搜索索引 `docs` 从较小值跳到更大值

## 建议直接复制的新对话提示词

```text
帮我核验这次闲时分析挂机结果。我已经在挂机前重启应用，并执行过“清理脏数据”。

请你重点检查：
1. 闲时分析是否持续在跑
2. 是否还有大批量 decode-start / waveform-start 超时
3. 波形失败时 key / bpm 是否已经先落盘
4. decodeBackend 分布如何，是否大量走 symphonia / ffmpeg / ffmpeg-fallback
5. aggressiveConcurrency 是否在 deep-idle 时开启
6. `song-search index rebuilt, docs=...` 是否在挂机期间明显增长，是否说明又有新歌被懒加载进 song_cache
7. `歌单根目录集合发生变化 / fileSystemOnlyRootCount` 是否正常，未打开歌单是否也会被发现
8. `background-orchestrator` 是否先执行 `mixtape-stem-resume / mixtape-waveform-hires`，再轮到 `key-analysis`
9. 这次相比上次，完成率是否明显改善
10. 如果还有剩余未完成，请按“可接受 / 需要继续修 / 明确 bug / 候选集扩大导致表象未完成”分类

如果可能，请给我：
- 关键日志片段
- 失败歌曲名单
- 失败按阶段分类统计
- 按歌单根目录分类的剩余未完成数量
- 自动混音任务与 `key-analysis` 的执行先后顺序
- 下一步最值得做的修复建议
```

## 重点日志锚点

下次核验时，请优先搜索这些关键字：

### 1. 调度是否正常

- `开始一轮闲时扫描`
- `触发扫描定时器`
- `入队后台分析任务`
- `aggressiveConcurrency`
- `idleProfile`
- `background-orchestrator`

理想情况：

- 一直能看到周期性扫描
- 深度闲置时能看到 `aggressiveConcurrency: true`
- 如果出现 `触发扫描定时器`，最好紧跟着能看到 `开始一轮闲时扫描`
- 如果反复只有 `触发扫描定时器`，但没有真正开始扫描，通常说明当时还不算真正闲置，或者前台操作把 idle gate 打断了
- 如果多个闲时任务同时存在，应该能看到 `background-orchestrator` 明确打印谁先执行

### 2. 分析阶段是否先落盘

- `分析阶段完成并已落盘`

理想情况：

- 大量歌曲出现这条日志
- 即使后面波形失败，也应该能看到：
  - `keyPersisted: true`
  - `bpmPersisted: true`

### 3. 最终任务是否完成

- `后台任务完成摘要`

重点关注字段：

- `decodeBackend`
- `keyPersisted`
- `bpmPersisted`
- `waveformPersisted`

理想情况：

- 大量任务能完整完成
- 即使 `waveformPersisted: false`，也尽量保证 `keyPersisted / bpmPersisted` 为 `true`

### 4. 是否仍有超时

- `任务执行超时，终止 worker`
- `失败文件诊断`
- `Worker 崩溃`

重点关注字段：

- `stage`
- `decodeBackend`
- `partialKeyPersisted`
- `partialBpmPersisted`
- `decodeMs`
- `analyzeMs`
- `waveformMs`

理想情况：

- 超时总量明显少于上次
- 即使还有 `waveform-start` 超时，也不要再把 `key / bpm` 一起拖死

### 5. 本轮候选主要缺什么

- `候选来源：缓存数据库`
- `候选来源：文件系统回退扫描`

重点关注字段：

- `missingKeyCount`
- `missingBpmCount`
- `missingWaveformCount`
- `uniqueListRootCount`
- `sampleListRoots`

理想情况：

- 如果剩余任务大多只是补 waveform，应该更多看到：
  - `missingWaveformCount`
- 如果 `missingKeyCount / missingBpmCount` 仍然很高，说明主分析链路还没彻底跑顺
- `sampleListRoots` 可以快速判断剩余候选集中在哪些歌单根目录

### 6. 候选集是否在挂机期间被重新扩大

- `song-search] index rebuilt`
- `gss-loader] open-start`
- `songListUUID-changed`
- `library-changed`

重点关注字段：

- `docs`
- `songListUUID`
- `libraryAreaSelected`

理想情况：

- 挂机期间不要出现频繁切歌单
- `docs` 不要因为手动打开歌单而明显暴涨
- 如果 `docs` 从较小值突然跳到更大值，要单独标记为“候选集扩大”，不能直接当成“挂机没补完”

### 7. 未打开歌单是否也被发现

- `歌单根目录集合发生变化`
- `libraryNodeRootCount`
- `fileSystemRootCount`
- `fileSystemOnlyRootCount`
- `sampleRoots`
- `sampleFsOnlyRoots`
- `候选来源：文件系统回退扫描`

理想情况：

- 即使没手动点开某些歌单，也能看到根目录被发现
- 如果 `fileSystemOnlyRootCount > 0`，说明文件系统兜底发现到了 `library_nodes` 之外的歌单根目录
- `sampleFsOnlyRoots` 最好能直接看出是哪些未打开歌单被兜底发现
- 之后这些根目录里的歌曲应该继续出现在 `入队后台分析任务` 和 `后台任务完成摘要` 里

### 8. 自动混音闲时任务是否排在最前

- `收到后台任务请求`
- `开始执行后台任务`
- `后台任务执行结束`
- `category`
- `pendingCategories`

重点关注字段：

- `category`
- `trigger`
- `waitMs`
- `pendingCategories`

理想情况：

- 当 `mixtape-stem-resume / mixtape-waveform-hires / key-analysis` 同时都在排队时
- 应该优先看到：
  - `mixtape-stem-resume`
  - `mixtape-waveform-hires`
  - 最后才是 `key-analysis`
- 如果看到 `background-orchestrator` 打出 `后台任务等待闲置许可`，说明任务已排队，但还没拿到闲置执行权

## 新日志里重点想看到的改善

如果本轮修复生效，日志通常会体现为：

1. `分析阶段完成并已落盘` 的数量明显增加
2. `后台任务完成摘要` 的数量明显增加
3. `任务执行超时，终止 worker` 的数量下降
4. 超时日志里出现：
   - `partialKeyPersisted: true`
   - `partialBpmPersisted: true`
5. 深度闲置时出现：
   - `aggressiveConcurrency: true`
6. 即使不手动打开歌单，也能看到根目录发现日志：
   - `歌单根目录集合发生变化`
   - `fileSystemOnlyRootCount`
7. 挂机期间不要再出现因为切歌单导致的：
   - `docs` 明显跳涨
   - 剩余未完成数量被“新候选”重新抬高
8. 当自动混音任务存在时，`background-orchestrator` 应该先跑：
   - `mixtape-stem-resume`
   - `mixtape-waveform-hires`
   - 再轮到 `key-analysis`

## 需要重点判断的四种结果

### 结果 A：基本正常

表现：

- 大部分歌都补齐了
- 少量失败集中在极端文件
- 波形失败时 `key / bpm` 已落盘

结论：

- 当前方案有效
- 后续只需要继续处理极少数疑难文件

### 结果 B：部分改善，但还不够

表现：

- `key / bpm` 明显补齐了
- 但 waveform 还剩不少
- `decode-start` 或 `waveform-start` 超时仍然偏多

结论：

- 当前方案只解决了“别连坐”
- 还需要继续做“全量流式 + 解码 fallback + 波形彻底解耦”

### 结果 C：改善不明显

表现：

- 超时量和之前差不多
- 仍有大量歌曲三项都空
- `分析阶段完成并已落盘` 很少

结论：

- 说明根因仍主要在解码链路
- 需要优先改 `decodeAudioFile` 的执行模型或 fallback 策略

### 结果 D：不是分析失败，而是候选集被重新扩大

表现：

- 本轮已完成的歌曲不少
- 但挂机期间出现大量 `songListUUID-changed / open-start`
- `song-search index rebuilt, docs=...` 明显跳涨
- 剩余未完成主要集中在刚刚被打开的歌单

结论：

- 不能简单判定为“挂机没跑”
- 要先区分“旧候选是否补完”与“挂机期间是否又引入了新候选”
- 如果本轮是为了验证后台全量发现能力，下一轮要尽量避免手动切歌单干扰

## 额外建议

如果下次日志仍然很多，建议在新对话里顺手要求：

- 统计 `decodeBackend` 分布
- 按 `stage` 分类失败数
- 提取所有 `partialKeyPersisted / partialBpmPersisted = false` 的文件
- 单独列出 `ffprobe` 诊断异常的文件
- 单独列出 `docs` 明显跳涨前后的时间点
- 按 `list_root` 统计剩余未完成数量，确认是不是集中在某几个歌单
- 单独列出所有 `触发扫描定时器` 但没有进入 `开始一轮闲时扫描` 的时间段
- 单独列出 `background-orchestrator` 的实际执行顺序
- 单独列出所有 `后台任务等待闲置许可` 的时间段和当时的 `pendingCategories`

## 本轮修复关注点备忘

本轮已做的关键调整，供下次核验时对照：

- 后台默认回到全量分析，不再默认 `fastAnalysis`
- `analyze-done` 后先落盘 `key / bpm`
- 解码后端写入日志：`symphonia / ffmpeg / ffmpeg-fallback`
- 超时日志增加：
  - `partialKeyPersisted`
  - `partialBpmPersisted`
  - `decodeBackend`
- deep-idle 时允许更激进的后台并发
- 歌单根目录发现改为：
  - `library_nodes` + 文件系统双保险
- FS 回退扫描不再因为内存里只有 `key / bpm` 就跳过缺 waveform 的歌曲
- 闲时总调度优先级改为：
  - `mixtape-stem-resume`
  - `mixtape-waveform-hires`
  - `key-analysis`
- `background-orchestrator` 新增日志：
  - `收到后台任务请求`
  - `开始执行后台任务`
  - `后台任务执行结束`
  - `后台任务等待闲置许可`

## 历史误判案例备忘（不是本次夜挂机结果）

下面这段是之前已经确认过的一次容易误判的情况，不要和本次夜挂机混在一起：

- 旧会话里完成了 `773` 首，不代表全库只剩 `773`
- 重启后如果又手动打开 `FilterLibrary` 的歌单，`song_cache` / 搜索索引可能从较小值快速长到更大值
- 这会造成“明明刚挂机补完，怎么还有很多歌没分析”的错觉

当时真实观察到的典型现象：

- 重启后最初：
  - `docs=773`
- 打开更多 `FilterLibrary` 歌单后：
  - `docs=3282`
  - `docs=3571`

所以以后核验时一定要先分清：

- 是旧候选没跑完
- 还是挂机期间又把新候选懒加载进来了
