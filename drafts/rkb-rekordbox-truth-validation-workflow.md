# rkb Rekordbox 真值验证工作流

## 1. 目的

`rkb` 歌单不是为了让 FRKB 永久依赖 Rekordbox，而是用 Rekordbox 作为“分析真值”来校准和评估 FRKB 自己的节拍分析算法。

核心目标：

- 使用同一个音频文件。
- FRKB 继续使用自己的 FFmpeg/raw 波形作为视觉和算法基准。
- Rekordbox 只提供分析真值：`bpm`、`firstBeatMs`、`barBeatOffset`、`PQTZ`。
- 把 Rekordbox 真值放到 FRKB 的时间轴上后，比较 FRKB 自己分析输出和 Rekordbox 真值的差异。
- 用这个差异去优化 FRKB 的 BPM、首拍、downbeat/bar 相位分析程序。

禁止目标：

- 不用 Rekordbox `PWV5` 波形替换 FRKB 大波形。
- 不用歌名特判。
- 不维护逐曲 offset 表。
- 不为了视觉贴合去改 `firstBeatMs`。
- 不把离线能量峰、可见起点、最大振幅点当成 Rekordbox 网格真值。

新对话如果从本文开始接手算法优化，可以直接使用这段任务说明：

```text
按 drafts/rkb-rekordbox-truth-validation-workflow.md，把 FRKB 自己的 BPM / firstBeat / barBeatOffset 分析结果归一化到同一 timeline，先做 benchmark，对齐 Rekordbox truth，再优化 FRKB 自己的分析算法。

不要改 rkb truth 链路。
不要用 Rekordbox 波形。
不要做歌名特判或逐曲补偿。
不要为了视觉贴合修改 Rekordbox 的 firstBeatMs。

`rkb` 和 `sample` 是同一批真值样本的两份 FRKB 目录，Rekordbox 只提供 bpm / firstBeatMs / barBeatOffset / PQTZ。
`new` 只作为新样本临时入口，真值提取和样本迁移完成后必须清空。
FRKB 波形必须继续使用自己的 FFmpeg/raw 波形。
普通歌单未来也应输出同样语义的数据，但来源必须是 FRKB analyzer。
先建立 benchmark 和误差报告，再修改算法。
当前统一样本池是 68 首，当前算法版本是 8，验收阈值是严格 2ms，无灰区。
负 firstBeatMs 在 analyzer audio 轴上是合法相位语义，不能提前 clamp 到 0。
修改代码后必须运行 npx vue-tsc --noEmit。
```

## 2. 数据层应该怎么看

一首歌在这个验证体系里有三层数据。

### 2.1 音频文件

音频文件是唯一共同输入。

对 MP3 来说，文件不是“从 0ms 开始的一串裸 PCM”。它包含：

- MPEG frame。
- encoder delay / padding。
- `ffprobe stream.start_time`。
- 第一包 `Skip Samples`。
- encoder tag，例如 `LAME3.100`、`Lavc59.37`。

这些字段会影响“FFmpeg 解码输出 sample 0”应该映射到哪一个 Rekordbox 时间点。

### 2.2 Rekordbox 真值

Rekordbox 真值来自 Rekordbox 分析后的 beat grid：

- `bpm`：Rekordbox 的网格 BPM。
- `firstBeatMs`：Rekordbox 时间轴上的第一条 beat grid 时间戳。
- `firstBeatLabel`：Rekordbox 第一条 beat grid 的拍号，通常 `1..4`。
- `barBeatOffset`：FRKB 内部使用的小节相位字段，由 `firstBeatLabel` 转换得到。
- `PQTZ`：Rekordbox 导出的逐拍时间记录，可用于多点验证。

重点：`firstBeatMs` 不是“文件开头后第一个声音一定在 0ms”。它是 Rekordbox 自己时间轴上的网格时间戳。

### 2.3 FRKB 分析结果

FRKB 自己的分析程序最终也必须输出同一语义的数据：

- `bpm`
- `firstBeatMs`
- `barBeatOffset`

如果 FRKB 分析器内部是在“解码 PCM sample 0 = 0ms”的音频轴上做判断，那么进入 benchmark 前必须先转换：

```text
frkbFirstBeatTimelineMs = frkbFirstBeatAudioMs + timeBasisOffsetMs
```

如果 FRKB 分析器已经直接输出 app timeline 语义，则不能再加一次 offset。

### 2.4 负 `firstBeatMs` 不是脏数据

FRKB analyzer 的中间结果如果处在 audio 轴上，`firstBeatMs < 0` 是合法语义。

它表示：按当前 BPM 和相位外推，等价网格的某一条拍线落在 FFmpeg decoded sample 0 之前。这个值进入 benchmark 前应先按坐标语义转换：

```text
timelineFirstBeatMs = audioFirstBeatMs + timeBasisOffsetMs
```

禁止把 analyzer 中间结果里的负 `firstBeatMs` 直接当成错误、脏数据或需要清零的 UI 修正。尤其禁止恢复这类逻辑：

```text
firstBeatMs = max(0, firstBeatMs)
if firstBeatMs < 0: discard result
```

只有明确保存 Rekordbox truth 或 app timeline song grid 时，才可以按对应数据结构的语义决定是否接受负值。算法候选、缓存、benchmark 归一化阶段不能因为负数提前丢信息。

## 3. 统一样本池当前约定

当前实验链路约定：

- FRKB 真值样本目录 basename：`rkb`
- FRKB benchmark 样本目录 basename：`sample`
- FRKB 临时入口目录 basename：`new`
- Rekordbox 播放列表：只作为临时采集容器使用；历史 `abc` / `abc2` 已完成真值提取并删除。
- Rekordbox 统一快照文件：`resources/rkbRekordboxGridSnapshot.json`
- rkb 运行时代码：`src/main/services/keyAnalysis/rkbRekordboxGrid.ts`
- 本文是当前唯一保留的 rkb/Rekordbox 真值工作流文档；旧交接草案和离线探针输出已清理，避免继续误导。

当前匹配规则：

- `rkb` 运行时命中统一快照后启用 Rekordbox truth 覆盖。
- `sample` 用同一批音频跑 FRKB analyzer benchmark，不写入 Rekordbox truth 覆盖结果。
- `new` 不参与 benchmark，只用于暂存待采集真值的新样本。
- 用音频文件 basename 匹配快照里的 `fileName`。
- 快照命中后覆盖 FRKB song 上的：
  - `bpm`
  - `firstBeatMs`
  - `barBeatOffset`
  - `timeBasisOffsetMs`

`src/main/services/scanSongs.ts` 也会在扫描 `rkb` 时重新应用当前快照，避免旧 `song_cache` 把旧 offset 带回 UI。

当前验证基线：

- 统一 truth dataset 当前为 `68` 首，全部记录在 `resources/rkbRekordboxGridSnapshot.json`。
- 快照来源包含历史 `abc` 33 首、历史 `abc2` 7 首、新增 `test` 28 首；进入快照后全部一视同仁，不能再按播放列表分成不同等级样本。
- 历史 40 首当前通过：`40/40 pass`，`currentTimeline.gridMaxAbsMs.max = 1.886ms`。
- 新增 28 首当前通过：`28/28 pass`，`currentTimeline.gridMaxAbsMs.max = 1.964ms`。
- 当前没有灰区概念；硬性验收阈值是 `2ms`。任何 `firstBeatPhaseAbsErrorMs`、`gridMaxAbsMs`、`bpmOnlyDrift128BeatsMs` 超过 `2ms` 都算失败。
- 当前算法版本：`CURRENT_BEAT_GRID_ALGORITHM_VERSION = 8`。
- 当前代表 benchmark 输出：
  - `grid-analysis-lab/rkb-rekordbox-benchmark/old40-parallel-after-overrun-guard.json`
  - `grid-analysis-lab/rkb-rekordbox-benchmark/test-new-parallel-after-overrun-guard.json`
- 历史输出只保留作追溯，不作为当前结论替代：
  - `grid-analysis-lab/rkb-rekordbox-benchmark/abc-sample-after-abc2-final.json`
  - `grid-analysis-lab/rkb-rekordbox-benchmark/abc2-sample-final.json`
- `Developer`、`len faki - zig zag`、`Enrico`、`Gamma`、`Leviws` 这类关键分歧样本都必须继续作为回归样本。
- 新增 `test` 28 首里最差样本仍低于 `2ms`，不能因为当前全部通过就把它们当成可选样本。
- 最近一次代码侧验证已通过 `npx vue-tsc --noEmit`。
- 没有保留运行时调试日志。

## 4. Rekordbox 数据怎么拿

### 4.1 在 Rekordbox 里准备真值

推荐流程：

1. 把新样本先放进 FRKB 的 `new` 目录。
2. 把同一批音频导入 Rekordbox。
3. 为这批样本创建一个临时 Rekordbox 播放列表。
4. 让 Rekordbox 完成分析。
5. 必要时在 Rekordbox 里人工修正 beat grid。
6. 确认 Rekordbox 里看到的网格是你认定的真值。
7. 从临时播放列表提取 truth，并合并进 `resources/rkbRekordboxGridSnapshot.json`。
8. 把这批音频各复制一份到 FRKB 的 `rkb` 和 `sample` 目录。
9. 清空 `new`。
10. 删除临时 Rekordbox 播放列表。
11. 跑统一 68 首加新增样本的完整回归。

注意：

- 如果人工修过网格，必须确认 Rekordbox 已保存。
- 读取桌面库时，最好关闭 Rekordbox，避免数据库锁或未落盘。
- 每次替换音频文件后，都必须重新确认文件大小、mtime、basename 是否匹配。

### 4.2 从 Rekordbox 桌面库读取

桌面库读取依赖：

- Rekordbox `master.db`
- Rekordbox analyze 文件，例如 `.DAT`
- `pyrekordbox`
- `resources/rekordboxDesktopLibrary/bridge.py`

当前 bridge 的 beat grid 读取逻辑在：

- `resources/rekordboxDesktopLibrary/bridge.py`
- `_resolve_track_grid_payload(...)`

它从 analyze `.DAT` 里读取 `beat_grid` tag：

```text
beats = beat_grid.beats
bpms = beat_grid.bpms
times = beat_grid.times
```

然后生成：

```text
gridBpm = bpms[0]
gridFirstBeatMs = times[0] * 1000
gridFirstBeatLabel = beats[0]
gridBarBeatOffset = (5 - gridFirstBeatLabel) % 4
```

这些字段进入快照后对应：

```text
bpm = gridBpm
firstBeatMs = gridFirstBeatMs
firstBeatLabel = gridFirstBeatLabel
barBeatOffset = gridBarBeatOffset
```

### 4.3 从 Rekordbox USB / 设备库读取

USB 导出可用于交叉验证。

历史第一批 `abc` 33 首曾用 USB 导出做过交叉验证。该段是历史验证结论，不代表当前样本池仍只来自 `abc`。

当时已验证过的重点：

- `G:/PIONEER/rekordbox/export.pdb` 中 `abc` 歌单共 `33` 首。
- 这 `33` 首全部能在 `USBANLZ` 找到对应 `ANLZ0000.DAT`。
- 这 `33` 首全部存在 `PQTZ`。
- `PQTZ` 存的是逐拍记录，不是只有第一拍。
- `PQTZ` 每条记录为 8 字节：`u16 beat`、`u16 bpm_x100`、`u32 time_ms`。
- 这批样本没有多 BPM 段：`tracksWithVariableBpm = 0`。
- 这批 `abc` 样本里，`PQTZ[0].timeMs` 与快照 `firstBeatMs` 一致。
- `PQTZ[0].bpm` 与快照 `bpm` 一致。
- `PQTZ[0].beat` 与快照 `firstBeatLabel` 一致。
- 以 `PQTZ[0]` 和 `60000 / bpm` 外推整首歌时，没有任何一首 `maxBeatTimeDriftMs >= 10`。
- 最差样本也只有 `6.521ms / 1121 beats`，属于整数毫秒量化级别，不是结构性 drift。

因此 `PQTZ` 可作为多点真值校验来源：

```text
expectedBeatMs[i] = PQTZ[i].timeMs
```

当歌曲是固定 BPM 时，也可以用：

```text
expectedBeatMs[i] = firstBeatMs + i * 60000 / bpm
```

但如果未来遇到变 BPM 或多锚点歌曲，应优先使用完整 `PQTZ`，不要只用首拍外推。

当前结论：`PQTZ` 证明 Rekordbox 网格真值本身基本可信；历史第一批 33 首的错位根因不应继续归因到“没有读取完整 PQTZ 多锚点”。

## 5. Rekordbox 时间轴怎么对应到 FRKB

### 5.1 核心问题

Rekordbox 的 `firstBeatMs` 是 Rekordbox 时间轴。

FRKB 大波形来自 FFmpeg raw pipe，FFmpeg 输出的是一串没有原始 PTS 的 PCM sample。

所以必须明确：

```text
FFmpeg decoded sample 0 -> Rekordbox timeline ?
```

这个映射就是 `timeBasisOffsetMs`。

### 5.2 当前 rkb timeBasisOffsetMs 规则

当前规则：

```text
timeBasisOffsetMs = ffprobe stream.start_time * 1000

如果满足：
  encoder tag 以大写 LAME 开头
  第一包存在 Skip Samples.skip_samples
  sample_rate 有效

则追加：
  timeBasisOffsetMs += skip_samples / sample_rate * 1000
```

也就是：

```text
timelineSec = audioSec + timeBasisOffsetMs / 1000
audioSec = timelineSec - timeBasisOffsetMs / 1000
```

代表样本：

| file | encoder | start_time | skip_samples | timeBasisOffsetMs |
| --- | --- | ---: | ---: | ---: |
| `Developer - Have It All (Original Mix).mp3` | `LAME3.100` | `25.057ms` | `1105` | `50.114ms` |
| `len faki - zig zag (original mix) (1).mp3` | `LAME3.100` | `25.057ms` | `1105` | `50.114ms` |
| `enrico sangiuliano - the techno code (...) (1).mp3` | `Lavc59.37` | `25.057ms` | `1105` | `25.057ms` |
| `len faki - gamma (glaskin remix) (1).mp3` | `Lame3.100` | `0ms` | 无 | `0ms` |
| `leviws - foul play (1).mp3` | `Lame3.100` | `0ms` | 无 | `0ms` |

这个规则已经让当前统一样本池中的历史第一批 33 首视觉对齐，并继续作为后续 68 首统一回归的一部分。

### 5.3 为什么不是改歌曲

这里没有移动音频，也没有改 `firstBeatMs`。

实际修正的是坐标转换：

```text
FFmpeg raw PCM sample index -> Rekordbox timeline
```

也就是说，同一份音频文件在两个系统里的“0 点语义”不同。`timeBasisOffsetMs` 把两个 0 点放到同一坐标系里。

## 6. FRKB 里怎么使用这些数据

### 6.1 song 数据

进入 FRKB 后，rkb 快照命中的歌曲应携带：

```json
{
  "bpm": 141,
  "firstBeatMs": 61,
  "barBeatOffset": 0,
  "timeBasisOffsetMs": 50.114
}
```

含义：

- `bpm / firstBeatMs / barBeatOffset` 是 Rekordbox 真值。
- `timeBasisOffsetMs` 是音频解码轴到 Rekordbox timeline 的映射。
- `firstBeatMs` 不因为 offset 改动。

### 6.2 波形绘制

FRKB raw waveform 的本地音频时间要转换到 timeline：

```text
rawTimelineStartSec = rawData.startSec + timeBasisOffsetMs / 1000
```

grid 直接按 Rekordbox 时间戳画：

```text
beatTimeSec[i] = firstBeatMs / 1000 + i * 60 / bpm
```

这样 FRKB 自己的波形和 Rekordbox 真值网格才在同一个时间坐标里。

### 6.3 seek / streaming

发给 FFmpeg 的 `-ss` 必须是 audio sec：

```text
audioSec = timelineSec - timeBasisOffsetMs / 1000
```

UI 里的 coverage、dirty range、grid range、cue marker 都应该使用 timeline sec。

这两个轴混用，就会出现“只差一点”的稳定偏移。

### 6.4 当前必须保持一致的工程触点

`timeBasisOffsetMs` 不是只给某一个渲染函数用。它必须贯穿所有 raw waveform、grid、播放和缓存路径：

- `src/main/services/keyAnalysis/rkbRekordboxGrid.ts`：快照命中时计算 `timeBasisOffsetMs`。
- `src/main/services/scanSongs.ts`：扫描 `rkb` 时重新应用快照，避免旧 `song_cache` 污染。
- `src/renderer/src/components/mixtapeBeatAlignWaveform.ts`：raw 波形绘制映射到 timeline。
- `src/renderer/src/components/horizontalBrowseRawWaveformTileManager.ts`：tile 请求和 cache key 必须包含 offset 语义。
- `src/renderer/src/workers/horizontalBrowseDetailWaveform.worker.ts`：worker 渲染 tile 时使用 offset。
- `src/renderer/src/components/useHorizontalBrowseRawWaveformCanvas.ts`：coverage/intersection 使用 timeline 轴。
- `src/renderer/src/components/useHorizontalBrowseRawWaveformStream.ts`：FFmpeg stream 用 audio 轴，loaded/dirty range 转回 timeline 轴。
- `src/renderer/src/components/HorizontalBrowseRawWaveformDetail.vue`：detail raw stream/canvas 统一使用 `previewTimeBasisOffsetMs`。
- `src/renderer/src/components/MixtapeBeatAlignDialog.vue`：调网格弹窗也必须接收 offset。
- `src/renderer/src/components/MixtapeDialogsLayer.vue`：从 `beatAlignTrack` 传递 offset。
- `src/renderer/src/composables/mixtape/mixtapeTrackSnapshot.ts`：mixtape track 快照保留 offset。
- `src/renderer/src/composables/mixtape/mixtapeSnapshotSongMapper.ts`：mixtape song 映射保留 offset。
- `rust_package/src/horizontal_browse_transport_engine_state.rs`：native transport 内部做 `timeline_sec <-> audio_sec` 转换。

漏掉任意一条链路，都可能出现“某个视图还是晚一点”的假象。

## 7. FRKB 分析结果怎样才等价于 Rekordbox

### 7.1 单首歌的等价定义

FRKB 分析输出要先归一化到 Rekordbox timeline：

```text
frkbBpm
frkbFirstBeatTimelineMs
frkbBarBeatOffset
```

与 Rekordbox 真值比较：

```text
bpmError = frkbBpm - rekordboxBpm
firstBeatErrorMs = phaseDistance(frkbFirstBeatTimelineMs, rekordboxFirstBeatMs, beatIntervalMs)
firstBeatShiftBeats = nearestIntegerBeatShift(frkbFirstBeatTimelineMs, rekordboxFirstBeatMs, beatIntervalMs)
normalizedFrkbBarBeatOffset = normalize(frkbBarBeatOffset + firstBeatShiftBeats)
barBeatOffsetMatch = normalizedFrkbBarBeatOffset == normalize(rekordboxBarBeatOffset)
```

`phaseDistance` 不能只做普通减法。因为首拍可能差一个或多个完整 beat，但网格相位仍可能等价。

推荐：

```text
beatIntervalMs = 60000 / rekordboxBpm
rawDelta = frkbFirstBeatTimelineMs - rekordboxFirstBeatMs
phaseError = rawDelta modulo beatIntervalMs, 折叠到 [-beatIntervalMs/2, +beatIntervalMs/2]
```

关键细节：`phaseDistance` 折叠相位时可能把 `firstBeat` 按整数拍前后移动。比较 `barBeatOffset` 时必须把这个 `firstBeatShiftBeats` 同步应用到 FRKB 的 offset，再做 `mod 4` 或精确比较；否则等价网格会被误判成 downbeat mismatch。

### 7.2 多拍网格等价

仅看第一拍不够。应比较一组 beat：

固定 BPM 时：

```text
rbBeatMs[i] = rekordboxFirstBeatMs + i * 60000 / rekordboxBpm
frkbBeatMs[i] = frkbFirstBeatTimelineMs + i * 60000 / frkbBpm
gridErrorMs[i] = frkbBeatMs[i] - rbBeatMs[i]
```

如果有 `PQTZ`：

```text
rbBeatMs[i] = PQTZ[i].timeMs
```

指标建议：

- `bpmAbsError`
- `firstBeatPhaseAbsErrorMs`
- `gridMeanAbsMs`
- `gridP95AbsMs`
- `gridMaxAbsMs`
- `drift128Ms`
- `barBeatOffsetMatched`

当前验收没有灰区，全部按硬性阈值处理：

- `firstBeatPhaseAbsErrorMs <= 2ms`。
- `gridMaxAbsMs <= 2ms`。
- `bpmOnlyDrift128BeatsMs <= 2ms`。
- `barBeatOffset` 必须在等价首拍归一化后匹配；不匹配就是 downbeat 错。

任何一项超过阈值都算失败，不能靠人工解释放行。

### 7.3 BPM 等价

BPM 不能只看显示小数。

更可靠的是看网格漂移：

```text
drift128Ms = frkbBeatMs[127] - rbBeatMs[127]
```

如果 `bpmError` 很小但 `drift128Ms` 大，说明 BPM 仍不等价。

如果 BPM 是半速/倍速关系，需要单独归类：

- `70` vs `140`
- `140` vs `280`

这类不应直接算作通过，除非产品层明确允许 half/double BPM 等价。

### 7.4 当前算法原则

当前算法版本是 `8`，但版本号本身不是质量保证；质量只由统一 68 首 truth dataset 的硬阈值结果证明。

必须遵守：

- 不按歌名、artist、文件名、路径、播放列表来源做任何特判。
- 不维护逐曲 offset 表。
- 不用 Rekordbox 波形、`PWV5 visibleOnset`、离线能量峰表去替代 FRKB 自己的 raw 波形和 analyzer。
- 不为了贴合某一首歌而移动 Rekordbox truth 的 `firstBeatMs`。
- 不把 BeatThis 输出当最终真值；BeatThis 只能作为候选来源，最终结果必须经过 FRKB 自己的网格求解、相位归一化和 benchmark 验证。
- 可以大改底层，甚至替换 BeatThis，但新系统必须在同一 68 首样本上不降级，并且规则能解释为普适音频信号逻辑。

当前已验证有效的通用修正：

- `head-attack-prezero`：允许保留 sample 0 之前的 head attack 相位候选，解决首拍应落在解码起点之前时被错误清零的问题。
- `grid-solver-head-attack-window-consensus`：用多窗口一致性确认 head attack anchor，避免只信某一个局部峰值。
- `full-track-logit-positive-overrun-guard`：当 full-track logits 给出低质量的大正向相位跳变时阻断 overrun，并在需要时保留 overrun 之前的 downbeat 证据。

这些规则不是样本特判。它们必须继续以信号质量、相位一致性、窗口共识、downbeat margin 等通用指标为依据。

## 8. 以后优化算法的验证工作流

### 8.1 建 truth dataset

每次从 Rekordbox 准备一批样本，都合并进同一个 truth dataset：`resources/rkbRekordboxGridSnapshot.json`。

每首歌至少记录：

```json
{
  "fileName": "Developer - Have It All (Original Mix).mp3",
  "filePath": "D:/FRKB_database-B/library/FilterLibrary/rkb/Developer - Have It All (Original Mix).mp3",
  "size": 13123456,
  "mtimeMs": 1234567890,
  "rekordbox": {
    "bpm": 141,
    "firstBeatMs": 61,
    "firstBeatLabel": 1,
    "barBeatOffset": 0,
    "pqtz": []
  },
  "timeBasis": {
    "offsetMs": 50.114,
    "streamStartTimeMs": 25.057,
    "sampleRate": 44100,
    "encoder": "LAME3.100",
    "skipSamples": 1105
  }
}
```

建议后续不要只靠 `fileName`，逐步增加：

- `filePath`
- `size`
- `mtimeMs`
- audio hash 或 fingerprint

这样可以避免同名不同文件污染 benchmark。

### 8.2 跑 FRKB analyzer

对同一批音频运行 FRKB 自己分析器，输出：

```json
{
  "fileName": "...",
  "frkb": {
    "bpm": 141.0001,
    "firstBeatMs": 60.5,
    "barBeatOffset": 0,
    "coordinate": "timeline"
  }
}
```

如果 analyzer 输出的是 audio 轴：

```json
{
  "coordinate": "audio",
  "firstBeatMs": 10.386
}
```

benchmark 必须转换：

```text
timelineFirstBeatMs = audioFirstBeatMs + timeBasisOffsetMs
```

### 8.3 生成 benchmark 报告

每次算法改动后生成报告：

```text
trackCount
passCount
failCount
bpmAbsErrorMedian
firstBeatPhaseAbsErrorMedianMs
gridMeanAbsMs
gridP95AbsMs
gridMaxAbsMs
bpmOnlyDrift128BeatsMs
downbeatMismatchCount
worstTracks
```

失败分类至少包括：

- BPM 错。
- firstBeat 相位错。
- downbeat/barBeatOffset 错。
- 变 BPM / 多锚点没处理。
- 时间轴映射缺失。
- 音频文件和 Rekordbox truth 不匹配。

### 8.4 人工复核闭环

当 benchmark 出现失败：

1. 在 FRKB 里显示 Rekordbox truth grid。
2. 显示 FRKB analyzer grid。
3. 两套 grid 都画在 FRKB raw waveform 上。
4. 看差异是 BPM、首拍、downbeat，还是时间轴。
5. 如果 Rekordbox 真值本身有误，回 Rekordbox 修 grid，再重新生成 truth dataset。

不要在 FRKB 里手工写补偿把失败样本抹平。

### 8.5 验证性能和缓存边界

验证可以并发跑，但不能降低验证质量。

允许：

- 用 `scripts/run_parallel_rkb_rekordbox_benchmark.py` 并发分析样本。
- 缓存 BeatThis raw window predictions。
- 缓存 full-track logits。
- 复用确定性、与算法决策无关的中间原始模型输出。

禁止：

- 缓存最终 `bpm` / `firstBeatMs` / `barBeatOffset` 后把它当成新算法结果。
- 缓存 benchmark pass/fail 结论。
- 因为提速跳过样本、缩短 truth 对比、放宽 `2ms` 阈值、关闭 downbeat 校验。
- 只跑新增样本就宣布算法通过；最终验收必须覆盖统一 68 首。

判断缓存是否安全的标准：

```text
改 FRKB 网格求解算法后，缓存内容本身是否仍应完全相同？
```

如果答案是“是”，例如 BeatThis 对同一音频输出的 raw windows 和 full logits，可以缓存。如果答案是“不一定”，例如 anchor 选择、phase rescue、downbeat 归一化、最终误差分类，就不能作为跨算法版本复用的验收结论。

## 9. 推荐的工程落地顺序

### 阶段 1：固定统一 truth dataset

- 保留当前 68 首作为统一回归样本。
- 每首记录 Rekordbox grid 和 `timeBasisOffsetMs` 计算明细。
- 把当前“68 首按 2ms 硬阈值通过”作为基线。

### 阶段 2：自动提取 Rekordbox truth

- 从 Rekordbox 桌面库临时播放列表读取 `.DAT beat_grid`。
- 合并生成统一 `truth` JSON。
- 对 USB/PQTZ 做抽样交叉验证。

### 阶段 3：自动 benchmark FRKB analyzer

- 跑 FRKB 分析器。
- 输出 normalized timeline result。
- 与 truth dataset 对比。
- 生成可读报告。

### 阶段 4：算法优化

优先优化顺序：

1. BPM 稳定性。
2. firstBeat 相位。
3. downbeat/barBeatOffset。
4. 多锚点/PQTZ 级别网格。

每次改算法必须跑同一批 truth dataset，不能只看一两首歌。

## 10. 常见坑

### 10.1 “Rekordbox 里看起来是 0ms”不等于 `firstBeatMs = 0`

Rekordbox 里网格线压在拍头上，只说明：

```text
Rekordbox beat grid time == Rekordbox 认为的拍头时间
```

不说明这个时间是音频文件绝对 0ms。

### 10.2 `stream.start_time` 不是完整答案

LAME MP3 可能还需要第一包 `Skip Samples`。

当前已验证规则：

```text
LAME3.100 + start_time 25.057ms + skip_samples 1105
=> timeBasisOffsetMs 50.114ms
```

但 `Lavc59.37` 同样有 `start_time` 和 `skip_samples` 时，不追加第二层。

### 10.3 `PWV5` 只能辅助排查

`PWV5` 能帮助临时观察 Rekordbox 自己的细节波形语义，但不能作为 FRKB 默认波形源，也不应把离线可见起点 JSON 放进 `resources`。

原因：

- 目标是比较 FRKB analyzer 与 Rekordbox analyzer。
- 如果波形也换成 Rekordbox 的，验证基准就被污染。
- 临时探针输出只能留在本地或文档结论里，不能成为运行时补偿表。

### 10.4 缓存会误导复测

旧 `song_cache` 里可能保存旧的 `timeBasisOffsetMs`。

当前已经在扫描链路对 `rkb` 做了统一快照覆盖，但以后如果更新 truth dataset，也要确认：

- song cache 已刷新。
- raw waveform cache 没混进旧坐标语义。
- UI song 对象拿到的是最新字段。

### 10.5 barBeatOffset 不参与 beat 位置

`barBeatOffset` 影响大拍/小节线样式，不应该拿它修首拍位置。

beat 位置由：

```text
firstBeatMs + i * 60000 / bpm
```

决定。

### 10.6 不要把内容级起音当通用 offset

离线能量峰、首个可见非零点、first-cross 都只能帮助排查，不能当成 Rekordbox 真网格。

原因：

- 鼓头视觉位置不一定等于最大能量点。
- 不同频段、窗口、聚合方式会改变峰值位置。
- `PWV5 visibleOnset` 是 Rekordbox 细节波形显示语义，不等于 FRKB 的时间基准。
- 这类方法容易变成逐曲 offset 或歌名特判。

### 10.7 不要恢复已经证伪的说法

以下说法不要再恢复：

- “当前应该回到 `timeBasisOffsetMs = 0`。”
- “`ffprobe stream.start_time` 已被完全证伪。”
- “只要搬 `PQTZ[0]` 就够。”
- “`PQTZ` 多锚点是当前样本池大漂移主因。”
- “对齐 `PWV5 visibleOnset` 就是下一步修法。”
- “改 `firstBeatMs` 可以解决视觉偏移。”

更准确的表述是：`stream.start_time` 和大写 `LAME` + 第一包 `Skip Samples` 都是音频格式/解码轴映射信号；它们必须全链路传播，但不能扩展成逐曲补偿表。

## 11. 当前代表样本

后续任何规则、重构或算法优化，至少要解释这些样本：

| file | bpm | firstBeatMs | timeBasisOffsetMs | 作用 |
| --- | ---: | ---: | ---: | --- |
| `Developer - Have It All (Original Mix).mp3` | `141` | `61` | `50.114ms` | 大写 `LAME3.100` + `start_time` + `skip_samples` 的关键样本 |
| `len faki - zig zag (original mix) (1).mp3` | `137` | `52` | `50.114ms` | 与 `Developer` 同类，曾经只用 `25.057ms` 时偏后 |
| `enrico sangiuliano - the techno code (...) (1).mp3` | `140` | `274` | `25.057ms` | `Lavc59.37`，有 `skip_samples` 但不追加第二层 |
| `len faki - gamma (glaskin remix) (1).mp3` | `145` | `26` | `0ms` | 无 offset 也应对齐，防止全局硬加 |
| `leviws - foul play (1).mp3` | `138` | `28` | `0ms` | 无 offset 对照样本 |
| `lewis fautzi - diversity of known substances (...) (1).mp3` | `138` | `225` | 按元数据计算 | 防止“修 Developer 但反向搞坏其他歌”的对照样本 |

## 12. 当前结论

当前统一 68 首样本池验证通过后，可以把这条链路作为后续 FRKB 分析算法优化的基准：

```text
Rekordbox 分析/人工校准
-> 提取 beat grid truth
-> 计算音频 timeBasisOffsetMs
-> FRKB raw waveform + Rekordbox truth grid 同轴显示
-> FRKB analyzer 输出同轴归一化
-> benchmark 比较
-> 优化 FRKB 自己的分析算法
```

这个流程的本质是“同一音频波形上的分析结果对比”，不是“让 FRKB 伪装成 Rekordbox”。
