# Rekordbox USB `abc` 歌单 PQTZ/PQT2 探测结论

生成时间：`2026-04-24`

相关文件：

- 脚本：`drafts/rekordbox-usb-abc-pqtz-probe.cjs`
- 输出：`drafts/rekordbox-usb-abc-pqtz-probe.out.json`

## 当前状态补充

截至 `2026-04-24` 后续排查，本文的 `PQTZ` 结论仍然有效：

- `PQTZ` 证明 Rekordbox 网格真值本身基本可信
- 不应继续把主要问题归因到“没读完整 PQTZ 多锚点”
- 后续工程修复已经转向 `timeBasisOffsetMs` 的全链路传播，以及 FFmpeg audio sec 与 FRKB timeline sec 的转换一致性

不要把本文误读成：

- `PQTZ[0]` 单独搬进 FRKB 就足够
- Rekordbox 快照值错了
- `PQTZ/PQT2` 仍是当前首要排查方向

## 结论

路径 C 已完成最关键的事实确认：

1. `G:/PIONEER/rekordbox/export.pdb` 中 `abc` 歌单共 `33` 首歌，全部都能在 `USBANLZ` 找到对应 `ANLZ0000.DAT`
2. 这 `33` 首歌全部存在 `PQTZ`
3. `PQTZ` 不是只有首拍，它是**每拍一条记录**
4. 但这 `33` 首歌的 `PQTZ` 又几乎都严格落在 `firstBeat + n * beatSec` 这条直线上
5. 所以：**“FRKB 对不上 Rekordbox” 这件事，在这 33 首歌上，不支持“Rekordbox 实际网格是多锚点漂移网格”这个假设**

换句话说，`PQTZ` 证明了 Rekordbox 确实存了完整逐拍真值；但这些逐拍真值在当前样本上又几乎等价于：

`firstBeatMs + (beatIndex * 60000 / bpm)`

因此，之前离线探测里看到的 `50ms ~ 120ms` 级别 drift，根因更像是：

- FRKB 解码时间线和 Rekordbox 播放时间线不一致
- 或我们拿来对齐的音频事件并不是 Rekordbox 网格实际锚定的事件

而不是：

- `PQTZ[0]` 之外还藏着一套大幅修正时间线的逐拍锚点

## 关键事实

### 1. `PQTZ` 条目结构

从 U 盘导出文件直接解析得到，`PQTZ` 的每条记录为 8 字节：

- `u16 beat`
- `u16 bpm_x100`
- `u32 time_ms`

例如 `Gamma` 的前几条：

- `(beat=1, bpm=145.00, timeMs=26)`
- `(beat=2, bpm=145.00, timeMs=440)`
- `(beat=3, bpm=145.00, timeMs=853)`
- `(beat=4, bpm=145.00, timeMs=1267)`

这已经足够证明：Rekordbox 导出的设备库里，基础 beatgrid 是逐拍时间戳，不是只存首拍。

### 2. 这 33 首歌没有出现“多 BPM 段”现象

全量统计：

- `trackCount = 33`
- `pqtzTrackCount = 33`
- `tracksWithVariableBpm = 0`

也就是这批样本里，`PQTZ` 所有记录的 `bpm_x100` 都是单值，没有出现同一首歌里多个 BPM 段的情况。

### 3. `PQTZ` 对常速外推的偏差极小

脚本对每首歌都计算了：

- 以 `PQTZ[0]` 为起点
- 以 `60000 / bpm` 为拍长
- 用整首 `PQTZ` 去对比理论外推线

结果：

- 没有任何一首歌的 `maxBeatTimeDriftMs >= 10`
- 大多数歌的最大偏差 `< 1ms`
- 最差样本也只有 `6.521ms / 1121 beats`

这属于整数毫秒量化误差级别，不是结构性 drift。

### 4. 快照本身没取错

能按文件名精确对上的快照样本里：

- `snapshot.firstBeatMs == PQTZ[0].timeMs`
- `snapshot.bpm == PQTZ[0].bpm`
- `snapshot.firstBeatLabel == PQTZ[0].beat`

至少对得上的这些样本，现有 `rkbRekordboxAbcGridSnapshot.json` 的来源值本身没有问题。

## 代表样本

### `Developer - Have It All (Original Mix).mp3`

- `PQTZ entryCount = 775`
- `firstBeat = 61ms`
- `bpm = 141`
- `maxBeatTimeDriftMs = 0.596`

### `len faki - gamma (glaskin remix) (1).mp3`

- `PQTZ entryCount = 776`
- `firstBeat = 26ms`
- `bpm = 145`
- `maxBeatTimeDriftMs = 0.655`

## 当前判断

路径 C 给出的答案是：

- `PQTZ` 的确是逐拍真值
- 但这批歌的 `PQTZ` 并没有呈现出能解释 FRKB 大幅 drift 的“多锚点修正”

因此下一步如果继续追根因，优先级应转回：

1. FRKB 解码时间线 vs Rekordbox 播放时间线
2. 音频起点 / priming / trim / seek 基准差异
3. Rekordbox 细节波形或别的内部参考点，是否和我们离线脚本测的能量峰不是同一事件

而不是继续押注“PQTZ 多 entry 导致当前公式失真”。
