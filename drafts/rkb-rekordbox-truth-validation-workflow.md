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

## 3. rkb / abc 的当前约定

当前实验链路约定：

- FRKB 歌单目录 basename：`rkb`
- Rekordbox 播放列表名：`abc`
- Rekordbox 快照文件：`resources/rkbRekordboxAbcGridSnapshot.json`
- rkb 运行时代码：`src/main/services/keyAnalysis/rkbRekordboxGrid.ts`

当前匹配规则：

- 只有 `listRoot` basename 为 `rkb` 时启用。
- 用音频文件 basename 匹配快照里的 `fileName`。
- 快照命中后覆盖 FRKB song 上的：
  - `bpm`
  - `firstBeatMs`
  - `barBeatOffset`
  - `timeBasisOffsetMs`

`src/main/services/scanSongs.ts` 也会在扫描 `rkb` 时重新应用当前快照，避免旧 `song_cache` 把旧 offset 带回 UI。

## 4. Rekordbox 数据怎么拿

### 4.1 在 Rekordbox 里准备真值

推荐流程：

1. 把要验证的音频导入 Rekordbox。
2. 让 Rekordbox 完成分析。
3. 必要时在 Rekordbox 里人工修正 beat grid。
4. 把这些曲目加入一个固定播放列表，例如 `abc`。
5. 确认 Rekordbox 里看到的网格是你认定的真值。

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

当前已验证过的重点：

- `PQTZ` 存的是逐拍记录，不是只有第一拍。
- 这批 `abc` 样本里，`PQTZ[0].timeMs` 与快照 `firstBeatMs` 一致。
- `PQTZ[0].bpm` 与快照 `bpm` 一致。
- `PQTZ[0].beat` 与快照 `firstBeatLabel` 一致。

因此 `PQTZ` 可作为多点真值校验来源：

```text
expectedBeatMs[i] = PQTZ[i].timeMs
```

当歌曲是固定 BPM 时，也可以用：

```text
expectedBeatMs[i] = firstBeatMs + i * 60000 / bpm
```

但如果未来遇到变 BPM 或多锚点歌曲，应优先使用完整 `PQTZ`，不要只用首拍外推。

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

这个规则已经让当前 33 首 `rkb/abc` 样本视觉对齐。

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
barBeatOffsetMatch = normalize(frkbBarBeatOffset) == normalize(rekordboxBarBeatOffset)
```

`phaseDistance` 不能只做普通减法。因为首拍可能差一个或多个完整 beat，但网格相位仍可能等价。

推荐：

```text
beatIntervalMs = 60000 / rekordboxBpm
rawDelta = frkbFirstBeatTimelineMs - rekordboxFirstBeatMs
phaseError = rawDelta modulo beatIntervalMs, 折叠到 [-beatIntervalMs/2, +beatIntervalMs/2]
```

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

建议验收阈值先按灰区处理：

- `firstBeatPhaseAbsErrorMs <= 8ms`：优秀。
- `8ms < firstBeatPhaseAbsErrorMs <= 15ms`：灰区，人工复核。
- `> 15ms`：失败。
- `barBeatOffset` 必须匹配；不匹配就是 downbeat 错。

阈值后续可以根据样本池扩大再收紧。

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

## 8. 以后优化算法的验证工作流

### 8.1 建 truth dataset

每次从 Rekordbox 准备一批样本，生成 truth dataset。

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
grayCount
failCount
bpmAbsErrorMedian
firstBeatPhaseAbsErrorMedianMs
gridMeanAbsMs
gridP95AbsMs
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

当 benchmark 出现灰区或失败：

1. 在 FRKB 里显示 Rekordbox truth grid。
2. 显示 FRKB analyzer grid。
3. 两套 grid 都画在 FRKB raw waveform 上。
4. 看差异是 BPM、首拍、downbeat，还是时间轴。
5. 如果 Rekordbox 真值本身有误，回 Rekordbox 修 grid，再重新生成 truth dataset。

不要在 FRKB 里手工写补偿把失败样本抹平。

## 9. 推荐的工程落地顺序

### 阶段 1：固定 rkb truth dataset

- 保留当前 33 首作为第一批回归样本。
- 每首记录 Rekordbox grid 和 `timeBasisOffsetMs` 计算明细。
- 把当前“33 首全对”作为基线。

### 阶段 2：自动提取 Rekordbox truth

- 从 Rekordbox 桌面库 `abc` 播放列表读取 `.DAT beat_grid`。
- 生成 `truth` JSON。
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

`PWV5` 能帮助观察 Rekordbox 自己的细节波形语义，但不能作为 FRKB 默认波形源。

原因：

- 目标是比较 FRKB analyzer 与 Rekordbox analyzer。
- 如果波形也换成 Rekordbox 的，验证基准就被污染。

### 10.4 缓存会误导复测

旧 `song_cache` 里可能保存旧的 `timeBasisOffsetMs`。

当前已经在 `scanSongs.ts` 对 `rkb` 扫描做了快照覆盖，但以后如果换 truth dataset，也要确认：

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

## 11. 当前结论

当前 33 首 `rkb/abc` 验证通过后，可以把这条链路作为后续 FRKB 分析算法优化的基准：

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
