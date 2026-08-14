# RKB Beatgrid 证据与数据契约

> 本文定义什么数据可信、如何比较以及如何归因。批次生命周期见
> [`rkb-sealed-batch-workflow.md`](./rkb-sealed-batch-workflow.md)，历史结果见
> [`rkb-beatgrid-evidence-ledger.md`](./rkb-beatgrid-evidence-ledger.md)，算法红线见
> [`rkb-beatgrid-solver-pitfalls.md`](./rkb-beatgrid-solver-pitfalls.md)。

## 1. 权威数据与身份

- Rekordbox 是外部 truth 来源，只用于离线校准；FRKB 运行态不能依赖 Rekordbox 或以 truth 覆盖分析结果；
- `rkb-dataset-registry.json` 是 consumed 实例的身份源。实例使用 `batchId + assetSha256`，近重复隔离使用
  audio-only `isolationFamilyId`；文件名只能在同一不可变 batch 内连接 truth；
- fresh / evaluating / exposed 批次不能进入 development split。缺 audio identity、近重复隔离或 roster
  provenance 时必须 fail closed；
- truth、benchmark、classification 和诊断 JSON 是本机分析工作区产物，不是默认应提交的仓库资产。

## 2. 音频目录职责

权威根目录由 `.env` 的 `FRKB_BENCHMARK_DATABASE_ROOT` / `FRKB_DEV_DATABASE_URL` 解析。其下的
`library/FilterLibrary` 固定使用：

| 目录 | 含义 |
| --- | --- |
| `new` | 新的 current 样本暂存 |
| `sample` | 当前 classification 为 pass 的 current 音频 |
| `grid-failures-current` | 当前非 pass 或 benchmark error 的 current 音频 |
| `blind-rekordbox-truth` | 已 consumed 的 blind truth 音频归档 |
| `sealed-eval/<batchId>` | 已曝光、已归档的 consumed sealed 回归音频 |
| `sealed-intake/<batchId>` | prepare 创建的 fresh 临时入口；`finalize` 后必须恢复为空闲，保留 `.frkb.uuid` |

`new`、`sample`、`grid-failures-current` 是 classification 派生视图，不是真值来源；同一 current 样本不能
同时存在于多个 current 目录。blind / sealed 是数据集隔离边界，不能混入 current 目录，也不能按日期无限
新建长期歌单。

## 3. 时间轴与字段语义

一首歌有三层数据：音频文件、Rekordbox truth、FRKB analyzer 输出。truth 至少含 `bpm`、`firstBeatMs` 和
`barBeatOffset`；FRKB 最终输出必须表达同一语义。

- Rekordbox `firstBeatMs` 是 Rekordbox timeline 上的网格时间戳，不是音频第一个声音的位置；
- analyzer 中间候选允许 `firstBeatMs < 0`，表示等价拍线外推到 decoded sample 0 之前；不得提前丢弃；
- FRKB 若输出 audio 时间轴，benchmark 前转换为
  `frkbFirstBeatTimelineMs = frkbFirstBeatAudioMs + timeBasisOffsetMs`；若已经是 app timeline，不得二次加偏移；
- `timeBasisOffsetMs` 只修坐标，不移动音频、不改 Rekordbox truth、也不是全局相位补偿手段。

`timeBasisOffsetMs` 由容器证据计算：基础为 `ffprobe stream.start_time * 1000`；仅当大写 LAME tag、首包
`Skip Samples.skip_samples` 和有效 sample rate 同时成立时，才追加 `skip_samples / sample_rate * 1000`。

## 4. usable-grid 等价判定

先允许候选与 truth 的 `0.5x / 1x / 2x` BPM family 归一化，再比较：

```text
beatIntervalMs = 60000 / rekordboxBpm
phaseErrorMs = circularPhase(frkbFirstBeatTimelineMs - rekordboxFirstBeatMs, beatIntervalMs)
```

以下必须同时成立：

- `firstBeatPhaseAbsErrorMs <= 5ms`；
- `gridMaxAbsMs <= 5ms`；
- `bpmOnlyDrift128BeatsMs <= 5ms`；
- 非 octave tempo 不通过；
- 归一化首拍若产生整数拍折叠，必须把同一 `firstBeatShiftBeats` 应用于 `barBeatOffset` 后再比较 downbeat。

没有灰区。phase / tempo pass 不能掩盖 downbeat 错误；exact BPM 一致只作 diagnostic。

## 5. 缓存边界

可跨算法版本复用的缓存只能是“同一音频、同一模型下必然相同且与最终选择无关”的中间证据，例如 BeatThis
raw predictions、full-track logits、attack / onset 序列、ffprobe 容器证据。

候选 dump、scorer feature、候选覆盖和排名诊断只能临时使用，必须绑定 solver version 或 run id。不得跨版本
复用最终 `bpm` / `firstBeatMs` / `barBeatOffset`、最终候选、scorer 排名、benchmark pass/fail、anchor 选择或
任何混入 truth / error / category 的特征。

判断问题只有一个：改 solver 或 scorer 后，这份缓存是否仍必然完全相同？答案不是明确“是”，就不能作为
跨版本验收依据。

## 6. 人工归因流程

人工复核只服务于 truth QA、错误归因和研究，不是产品低置信兜底。遇到 benchmark 失败时：

1. 在同一 raw waveform 时间轴上显示 Rekordbox truth、FRKB 最终 grid 与候选池 grid / score / ranking；
2. 区分候选缺失、selector 排名错误、BPM 错、phase 错、downbeat 错、time basis 错或 Rekordbox truth 错；
3. truth 错则回 Rekordbox 修正，修正后的数据只可进入 consumed development；
4. 正确候选缺失则修 candidate generator；正确候选存在但排名错误才研究 scorer；
5. 若同类变化只在开发集改善、holdout 或 fresh 退化，即判为过拟合；不得在 FRKB 写逐曲补偿抹平失败。

fresh evaluate 曝光后才发现 truth 错，也必须 finalize 为 reject / consume；修正后禁止重跑同一批并把新分数称作
fresh 证据。
