# Rekordbox-Native `rkb` 交接文档

最后更新：`2026-04-24`

## 1. 当前目标

当前任务是在 `rkb` 歌单上验证一条独立的 `Rekordbox-native` 路线。

验收基准只有一个：

- `Rekordbox` 编辑器里当前确认正确的 `bpm`
- `Rekordbox` 编辑器里当前确认正确的第一根网格线

### 1.1 初衷

这个实验的初衷不是把 FRKB 做成 Rekordbox 的波形复刻器，也不是让界面“看起来像 Rekordbox”。

真正目标是建立一个干净的对比基准：

- 波形视觉必须来自 FRKB 对同一份音频文件的解码结果
- Rekordbox 只提供分析真值：`bpm`、`firstBeatMs`、`barBeatOffset`、`PQTZ`
- FRKB 和 Rekordbox 的分析结果必须放在同一个音频起点、同一个时间轴上比较
- 这样才能看清 FRKB 自己的 `BPM / beatgrid` 分析到底差在哪里
- 后续优化对象是 FRKB 自己的网格线和 BPM 分析程序，不是用 Rekordbox 波形或逐曲补偿把视觉糊过去

因此，任何会替换默认波形视觉源、按歌曲修正、或把 Rekordbox 显示层波形当运行时真值的做法，都违背这个实验初衷。

硬约束：

- 不按歌名特判
- 不维护逐曲目偏移表
- 不用 `PWV5` 可见起点做运行时补偿
- 不把 Rekordbox `PWV5` 细节波形接入运行时默认渲染
- 不因为几首样本看起来好了就宣布普适

当前实验场：

- `FRKB`：`D:/FRKB_database-B/library/FilterLibrary/rkb`
- `Rekordbox`：歌单 `abc`
- 当前样本数：`33` 首

## 2. 当前结论

现在的判断是：

- `Rekordbox` 网格真值已经能进入 FRKB
- `PQTZ` 已证明这批歌不是多锚点大漂移问题
- 剩余问题集中在“Rekordbox 时间轴”和“FRKB/FFmpeg 解码输出轴”怎么映射
- 最近一次修复不是改 `firstBeatMs`，而是补齐 `timeBasisOffsetMs` 在各个渲染链路里的使用

当前还不能宣布终局：

- `Developer - Have It All (Original Mix).mp3`
- `len faki - zig zag (original mix) (1).mp3`

这两首是当前最关键的复测样本。用户反馈它们的首根网格线仍比拍头晚一点；最新补丁后依然没有改善。

`2026-04-24` 最新用户反馈：`Developer` 仍然偏后，`len faki - zig zag` 也同类偏后；`Gamma`、`Leviws`、`Enrico` 当前看起来已对齐。

## 3. 当前工程状态

### 3.1 `rkb` 网格注入

文件：

- `src/main/services/keyAnalysis/rkbRekordboxGrid.ts`

当前行为：

- 仅在 `listRoot` basename 为 `rkb` 时启用
- 从 `resources/rkbRekordboxAbcGridSnapshot.json` 注入：
  - `bpm`
  - `firstBeatMs`
  - `barBeatOffset`
- 不修改 `firstBeatMs`
- 命中快照后用 bundled `ffprobe` 读取：
  - `stream.start_time`
  - `stream.sample_rate`
  - `stream.tags.encoder`
  - 第一包 `Skip Samples.skip_samples`
- 基础规则：把 `stream.start_time * 1000` 写入 `timeBasisOffsetMs`
- `2026-04-25` 新增规则：当第一包存在 `skip_samples` 且 encoder tag 以大写 `LAME` 开头时，再把 `skip_samples / sample_rate` 加入 `timeBasisOffsetMs`

重要语义：

- `firstBeatMs` 仍然表示 Rekordbox 网格时间戳
- `timeBasisOffsetMs` 表示 FFmpeg 解码输出轴相对 Rekordbox 时间轴的偏移
- 这不是逐曲补偿表，而是由当前音频文件格式元数据推出来的时间基准字段
- 不使用歌名、不使用 `PWV5 visibleOnset`、不修改 `firstBeatMs`

### 3.2 已补齐的前端/播放链路

这轮新增或修过的关键链路：

- `src/main/services/keyAnalysis/rkbRekordboxGrid.ts`
  - rkb 快照命中时计算最新 `timeBasisOffsetMs`
- `src/main/services/scanSongs.ts`
  - 扫描 `rkb` list root 时直接用当前 Rekordbox 快照覆盖 `bpm / firstBeatMs / barBeatOffset / timeBasisOffsetMs`
  - 避免旧 `song_cache` 里保存的 `25.057ms` 在重启后继续污染 UI
- `src/renderer/src/components/mixtapeBeatAlignWaveform.ts`
  - raw 波形绘制时按 `rawData.startSec + timeBasisOffsetMs` 映射到 timeline
- `src/renderer/src/components/horizontalBrowseRawWaveformTileManager.ts`
  - tile 请求和 cache key 带上 `timeBasisOffsetMs`
- `src/renderer/src/workers/horizontalBrowseDetailWaveform.worker.ts`
  - worker 渲染 tile 时传入 `timeBasisOffsetMs`
- `src/renderer/src/components/useHorizontalBrowseRawWaveformCanvas.ts`
  - coverage/intersection 判定使用 timeline 轴，避免 raw 音频轴直接和 grid 轴比较
- `src/renderer/src/components/useHorizontalBrowseRawWaveformStream.ts`
  - stream `startSec` 仍发给 FFmpeg 音频轴
  - dirty range / loaded range 转回 timeline 轴再参与重绘判断
- `src/renderer/src/components/HorizontalBrowseRawWaveformDetail.vue`
  - raw stream/canvas 统一拿 `previewTimeBasisOffsetMs`
- `src/renderer/src/components/MixtapeBeatAlignDialog.vue`
  - 调网格弹窗也接收并使用 `timeBasisOffsetMs`
- `src/renderer/src/components/MixtapeDialogsLayer.vue`
  - 从 `beatAlignTrack` 传 `timeBasisOffsetMs` 到调网格弹窗
- `src/renderer/src/composables/mixtape/mixtapeTrackSnapshot.ts`
  - mixtape track 快照保留 `timeBasisOffsetMs`
- `src/renderer/src/composables/mixtape/mixtapeSnapshotSongMapper.ts`
  - mixtape song 映射保留 `timeBasisOffsetMs`
- `rust_package/src/horizontal_browse_transport_engine_state.rs`
  - transport 内部用 `timeline_sec_to_audio_sec = timeline - offset`
  - 用 `audio_sec_to_timeline_sec = audio + offset`

### 3.3 当前验证状态

最近一次已通过：

- `npx vue-tsc --noEmit`

注意：

- npm 输出了旧配置 warning，不影响类型检查结果。
- 用户已经复测：只靠 `stream.start_time` 时，`Developer` / `len faki - zig zag` 仍存在“首根网格线比拍头晚一点”；不能再把单独 `start_time` 链路写成已解决。
- `2026-04-25` 已改为 `start_time + LAME gapless skip_samples` 的元数据规则，尚待用户复测。

## 4. 已确认事实

### 4.1 快照命中没问题

已确认：

- `rkb` 命中本地快照
- `song_cache` 里的 `bpm / firstBeatMs / barBeatOffset` 与快照一致
- 运行时能跳过 worker，用快照网格

结论：

- 现在不是“没吃到 Rekordbox 值”

### 4.2 文件一致性没问题

已核过：

- Rekordbox 原始导入源
- `FRKB rkb`
- 其他对照副本

音频 SHA256 一致。

结论：

- 现在不是“文件副本不同”

### 4.3 PQTZ 不是大漂移根因

USB `export.pdb + USBANLZ` 直接探测结论：

- `abc` 33 首全部有 `PQTZ`
- `PQTZ` 是逐拍记录，不是只有第一拍
- 这批歌没有多 BPM 段
- `PQTZ` 基本严格落在 `firstBeat + n * beatSec`
- `snapshot.firstBeatMs == PQTZ[0].timeMs`
- `snapshot.bpm == PQTZ[0].bpm`

代表值：

- `Developer`
  - `firstBeat = 61ms`
  - `bpm = 141`
  - `maxBeatTimeDriftMs = 0.596`
- `Gamma`
  - `firstBeat = 26ms`
  - `bpm = 145`
  - `maxBeatTimeDriftMs = 0.655`

结论：

- 不要再把主要精力押在“PQTZ 多 entry 没读导致大漂移”上。

### 4.4 FFmpeg `start_time` / `Skip Samples` / encoder 事实

已确认样本：

- `Developer`
  - `stream.start_time = 0.025057`
  - `skip_samples = 1105`
  - `encoder = LAME3.100`
- `len faki - zig zag`
  - `stream.start_time = 0.025057`
  - `skip_samples = 1105`
  - `encoder = LAME3.100`
- `Enrico`
  - `stream.start_time = 0.025057`
  - `skip_samples = 1105`
  - `encoder = Lavc59.37`
- `Gamma`
  - `stream.start_time = 0`
  - 第一包无 `Skip Samples`
- `Leviws`
  - 用户反馈在当前规则下已经对齐

注意：

- `1105 / 44100 = 25.057ms`
- `Developer` / `Zig Zag` 与 `Enrico` 的关键差别不是 `start_time`，而是 encoder tag：
  - `Developer` / `Zig Zag`：`LAME3.100`
  - `Enrico`：`Lavc59.37`
- 这解释了为什么同样 `start_time=25.057ms`，不能一刀切再加一层偏移
- 当前代码只对大写 `LAME` + 第一包 `Skip Samples` 的组合追加 gapless skip 偏移

## 5. 这轮踩坑

### 5.1 文档曾经和代码不一致

旧文档写过：

- `timeBasisOffsetMs = 0`
- 已移除 `ffprobe start_time`

这已经过时。当前实际代码会读取 `ffprobe stream.start_time`，并在大写 `LAME` + 第一包 `Skip Samples` 的组合下追加 gapless skip 偏移，写入 `timeBasisOffsetMs`。

### 5.2 只修一个渲染路径没用

曾经只修了 Horizontal Browse live/tile 的一部分，用户复测说没用。

原因是：

- 同一个字段需要贯穿：
  - song/grid cache
  - horizontal browse live stream
  - tile worker
  - coverage / dirty range
  - native transport
  - mixtape track snapshot
  - 调网格弹窗

漏掉任意一个，用户就会在某个视图里看到“还是晚一点”。

### 5.2.1 只改探针函数也没用，旧缓存会继续污染

`2026-04-25` 补坑：

- rkb 歌曲如果已经进过 `song_cache`，缓存里可能还存着旧的 `timeBasisOffsetMs = 25.057`
- 只改 `rkbRekordboxGrid.ts` 不够，因为扫描列表会优先把缓存值带回 UI
- 当前 `scanSongs.ts` 在扫描 `rkb` list root 时会重新应用 Rekordbox 快照和最新 time-basis 规则
- post-scan key analysis 也会强制刷新 rkb 网格，保证持久化层后续跟上

### 5.3 raw `startSec` 和 timeline 不能混用

`rawData.startSec` / FFmpeg `-ss` 是音频解码轴。

grid、cue、playhead、overlay 是 Rekordbox/FRKB timeline 轴。

有 `timeBasisOffsetMs` 时：

- 发给 FFmpeg 的 seek/start 需要用 audio sec
- UI 判断 loaded/dirty/coverage 需要转回 timeline sec

直接拿 raw 音频轴和 grid timeline 比，会产生小而稳定的错位。

### 5.4 `PWV5` 可见起点不是运行时补偿

`resources/rkbRekordboxAbcWaveformVisibleOnsets.json` 只能作为排查资料。

禁止把它用于：

- 歌名特判
- 逐曲 offset 表
- “看起来更贴”的运行时补偿
- 替换 Horizontal Browse 大波形的默认视觉源

用户已经明确指出这属于过拟合风险。

进一步澄清：

- 当前产品目标是“同一份 FRKB/FFmpeg 音频波形 + Rekordbox 分析真值”
- 这样才能比较 FRKB 自己的分析结果和 Rekordbox 分析结果的差异
- 如果默认改用 Rekordbox `PWV5` 波形，就会把视觉基准也换掉，污染后续算法对比
- `PWV5` 只允许作为离线排查资料，不能进入运行时默认渲染路径

### 5.5 不要把离线能量峰当 Rekordbox 真网格

离线脚本测的是 FRKB/FFmpeg PCM 上的局部能量峰。

它能帮助发现时间轴差异，但不能替代 Rekordbox 的编辑器判断。

原因：

- 鼓头视觉位置不一定等于最大能量点
- 不同频段、窗口、聚合方式会改变峰值位置
- Rekordbox 波形显示语义未完全复刻

### 5.6 当前新增探针：坏歌是一族，不是全局偏移

`2026-04-24` 继续排查时，用当前 deck live 路径更接近的方式做了一个只读探针：

- 解码器：bundled `FFmpeg`
- 声道/采样率：`2ch / 44100Hz`
- raw 聚合：按 Horizontal Browse 当前 `PREVIEW_RAW_TARGET_RATE = 4800`
- 判定：在 Rekordbox `PWV5 visibleOnset` 附近找当前 raw 波形 first-cross，仅用于分类，不作为运行时修正

关键观察：

- `Developer`：当前 raw first-cross 加上 `timeBasisOffsetMs=25.057` 后，仍比 Rekordbox 可见起点早约 `23.8ms`
- `len faki - zig zag`：同样早约 `21.0ms`
- `Gamma`：约 `+0.8ms`
- `Leviws`：约 `+5.3ms`
- `Enrico`：约 `+5.7ms`

33 首批量探针显示，偏差约 `-20ms` 的不是单独两首，而是一族：

- `stream.start_time` 通常约 `25ms`
- 文件开头几毫秒内就有强音频
- Rekordbox `PWV5` 的第一个可见点却通常落在 `46ms` 左右

这说明：

- 不能加一个全局 `+20ms`，因为 `Gamma`、`Leviws`、`Enrico` 这类已对齐样本会被搞坏
- 不能按歌名修，`Developer` / `Zig Zag` 只是这个族群里的代表
- 也不能直接把 `PWV5 visibleOnset` 写进运行时，那会违背“同一音频波形基准”的初衷
- 下一步应继续查 MP3 头部/首帧/skip-samples 与 FRKB raw 绘制对“文件开头强音频”的处理差异

`2026-04-25` 补充发现：

- `rkb` deck live raw 当前会强制走 FFmpeg stream，避免旧缓存干扰
- 静态 raw 缓存/共享解码路径可走 Rust/Symphonia
- 在 `Developer` / `Zig Zag` / `Enrico` 这类 `start_time≈25ms` 文件上，Symphonia 的开头 first-cross 通常比 FFmpeg pipe 晚约 `25ms`
- 继续看 ffprobe 元数据后，`Developer` / `Zig Zag` 与 `Enrico` 的差别落在 encoder tag：
  - `Developer` / `Zig Zag`：`LAME3.100`
  - `Enrico`：`Lavc59.37`
- 当前代码不再使用“所有 `start_time≈25ms` 再加一层”的粗暴规则，而是只在“大写 `LAME` + 第一包 `Skip Samples`”组合下追加 `skip_samples / sample_rate`
- 这个规则仍是“格式/解码轴映射”，不是逐曲修正，也不是把 Rekordbox 波形数据拿来画

## 6. 当前代表样本

后续任何规则或修复至少要解释这些样本：

### 6.1 `Developer - Have It All (Original Mix).mp3`

- `bpm = 141`
- `firstBeatMs = 61`
- `timeBasisOffsetMs = 50.114`（`start_time 25.057 + LAME skip_samples 25.057`）
- 当前最关键复测样本之一
- 用户反馈：只用 `25.057ms` 时首根网格线仍比拍头晚一点

### 6.2 `len faki - zig zag (original mix) (1).mp3`

- `bpm = 137`
- `firstBeatMs = 52`
- `timeBasisOffsetMs = 50.114`（`start_time 25.057 + LAME skip_samples 25.057`）
- 和 `Developer` 同类现象
- 用户新增反馈：只用 `25.057ms` 时 Rekordbox 中网格在拍头处，FRKB 中晚一点

### 6.3 `len faki - gamma (glaskin remix) (1).mp3`

- `bpm = 145`
- `firstBeatMs = 26`
- `timeBasisOffsetMs = 0`
- 用户反馈已对齐
- 不能只拿它证明规则成功

### 6.4 `leviws - foul play (1).mp3`

- `bpm = 138`
- `firstBeatMs = 28`
- `timeBasisOffsetMs = 0`
- 用户反馈已对齐

### 6.5 `enrico sangiuliano - the techno code (...) (1).mp3`

- `bpm = 140`
- `firstBeatMs = 274`
- `firstBeatLabel = 3`
- `barBeatOffset = 2`
- `timeBasisOffsetMs = 25.057`（`Lavc59.37`，不追加 LAME skip）
- 用户反馈当前已对齐
- 因为它有 `barBeatOffset`，是防止只修一拍相位的反例

### 6.6 `lewis fautzi - diversity of known substances (...) (1).mp3`

- `bpm = 138`
- `firstBeatMs = 225`
- 旧实验中常用于证伪“对 Developer 有利但会反向搞坏其他歌”的规则

## 7. 下一步

用户需要重启应用后复测 `2026-04-25` 的 LAME gapless skip 规则：

- `Developer`
- `len faki - zig zag`
- `Enrico`（确认没有被新规则误伤）

复测/排查时要明确是哪条视图链路：

- Horizontal Browse 详情波形
- 调网格弹窗
- 播放/节拍器听感

当前已知：只靠 `stream.start_time` 时，`Developer` / `len faki - zig zag` 仍偏后。下一步不要再换 Rekordbox 波形，而要验证 LAME gapless 元数据规则是否解释这类歌曲：

1. 先确认该视图实际拿到的 `timeBasisOffsetMs`（Developer / Zig Zag 应为 `50.114ms`，Enrico 应为 `25.057ms`）
2. 再确认 raw waveform 当前走的是 live stream、tile cache 还是 fallback
3. 不要先改 `firstBeatMs`
4. 不要先引入 `PWV5` / 起音补偿 / 歌名特判
5. 用临时 `log.txt` 链路记录字段传递，交付前删除调试日志

## 8. 已删掉的误导性说法

以下说法不要再恢复：

- “当前已经回到 `timeBasisOffsetMs = 0` 的诚实版本”
- “已明确移除 `ffprobe start_time`”
- “`start_time` 方案已经完全失败，所以不要再用”
- “只要对齐 PWV5 可见起点就能解决”
- “PQTZ 多锚点可能解释当前大漂移”

更准确的表述是：

- `ffprobe start_time` 是当前时间基准映射的一部分
- 大写 `LAME` + 第一包 `Skip Samples` 时，gapless skip 也是当前时间基准映射的一部分
- 它必须在所有使用 raw waveform / playback / grid 的路径里一致传播
- 它还没有被证明是全局终局规则
- `PQTZ` 证明网格值本身基本没错，问题主要在值的解释和时间轴映射
