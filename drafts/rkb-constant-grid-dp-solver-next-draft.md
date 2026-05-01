# RKB Constant Grid / DP Beatgrid Solver 下一步草案

## 背景结论

当前两条路都不能继续按原样推进：

- 旧方案 selected：`587 / 931 = 63.05%`
- 当前 hybrid selected：`587 / 931 = 63.05%`
- 当前 hybrid selected 全部来自 legacy candidate
- hybrid full candidate oracle：`871 / 931 = 93.56%`
- hybrid top40 oracle：`807 / 931 = 86.68%`
- constant-grid-dp conservative selected：`594 / 931 = 63.80%`
- constant-grid-dp candidate oracle：`872 / 931 = 93.66%`
- constant-grid-dp 最终选择来源：legacy fallback 902，new conservative switch 29

结论：

```text
候选生成有价值，自动 selector 失败。
继续堆现有弱特征、阈值、MLP/listwise ranker，过拟合风险高，不应进生产。
本轮只保留一个保守小幅正收益闸门，不能把它误判成 selector 已解决。
```

下一步要停止“从一堆候选里猜哪个像 truth”，改成真正求解 DJ constant beatgrid：

```text
音频特征 -> tempo lattice -> phase lattice / DP -> bar phase solver -> confidence 分流
```

## 目标

构建新的实验 solver，先命名为：

```text
rkb-constant-grid-dp-solver
```

它不是现有 hybrid selector 的调权版，而是新的全曲 constant-grid 求解器。

目标分三层：

1. **全量 selected pass rate**
   - 必须超过 legacy 的 `63.05%`
   - 只有 train/tune/holdout 都上涨才算有效

2. **high-confidence pass rate**
   - 高信心样本必须显著高于全量平均
   - 低信心样本允许交给人工校正或 legacy 作为产品兜底，但不能假装新算法自动成功

3. **候选/路径 oracle**
   - 保持或超过当前 hybrid candidate oracle
   - 但重点从“候选覆盖”转为“结构评分能否稳定选中”

## 反过拟合规则

算法决策禁止使用：

- 文件名
- title
- artist
- 路径
- truth
- benchmark pass/fail
- 当前样本的误差
- 针对单曲或少数歌曲的规则
- 高维小样本模型
- 只在 train/tune 漂亮、holdout 不涨的模型

允许使用：

- 音频派生特征
- BeatThis beat/downbeat logits
- BeatThis window beat/downbeat 序列
- onset / attack envelope
- lowband onset / attack envelope
- 音频容器时间基准 `timeBasis`
- encoder / skip samples 等解码时间元数据
- source 类型仅用于诊断，不用于强制优先级

任何新规则必须同时报告：

- train
- tune
- holdout
- all
- legacy pass 被误伤数量
- legacy fail 被救回数量
- candidate miss 数量
- oracle selected fail 数量

## 新架构

### 1. Feature Cache 继续保留

继续复用现有 feature cache：

- `beatLogits`
- `downbeatLogits`
- `fullAttackEnvelope`
- `lowrateAttackEnvelope`
- BeatThis windows
- legacy result 仅作为候选/对照，不再强行置顶

不重新跑慢特征，除非发现 cache 内容缺字段或时间基准错误。

### 2. Tempo Lattice

目标不是直接选唯一 BPM，而是生成稳定 tempo hypotheses。

候选来源：

- BeatThis window raw BPM
- integer BPM snap
- centi-BPM
- half/double variants
- beat-logit autocorrelation
- attack-envelope autocorrelation
- legacy BPM 作为普通候选

每个 tempo hypothesis 输出：

```json
{
  "bpm": 128.0,
  "source": "tempo-lattice",
  "tempoScore": 0.91,
  "tempoStability": 0.84,
  "octaveRisk": 0.02
}
```

Tempo 评分重点：

- 全曲 beat-logit periodicity
- 分段 periodicity 是否一致
- window BPM 是否聚集
- half/double 是否有更强证据
- 128 beats drift 风险

### 3. Phase Lattice / DP

这是下一轮核心。

对每个 BPM，在一个 beat interval 内搜索相位：

- 粗扫：`1ms` 或 `2ms`
- 精扫：top phase 附近 `0.25ms`
- 每个 phase 不是只算全曲均值，而是按时间分段打分

Phase score 需要包含：

- beat logits sampled robust score
- fullband attack robust score
- lowband attack robust score
- local peak offset consistency
- segment agreement
- phase margin
- head / intro 风险

建议先实现非学习版：

```text
phaseScore =
  beatLogitRobustScore
  + onsetRobustScore
  + lowbandRobustScore
  + segmentStability
  + localPeakConsistency
  + marginToSecondBest
  - headRisk
```

关键不是让某个分数在 train 上高，而是让正确 phase 在 holdout 上也稳定排前。

### 4. Bar Phase Solver

Bar phase 独立求解，不和 firstBeat 修正混在一起。

候选范围：

- mod4：`0..3`
- exact32 暂时只做诊断，不作为第一阶段目标

评分来源：

- downbeat logits sampled score
- downbeat segment stability
- downbeat margin
- BeatThis downbeat sequence agreement

如果 downbeat margin 弱：

- 不强行改 bar
- 标记 low confidence
- legacy bar 可以作为普通候选参与比较，但不能无条件保底

### 5. Confidence 分流

新 solver 必须输出 confidence，不再只输出一个貌似确定的 grid。

建议输出：

```json
{
  "bpm": 128.0,
  "firstBeatMs": 313.943,
  "barBeatOffset": 0,
  "confidence": 0.87,
  "confidenceLevel": "high",
  "lowConfidenceReasons": [],
  "features": {
    "tempoMargin": 0.14,
    "phaseMargin": 0.21,
    "segmentAgreement": 0.88,
    "downbeatMargin": 0.31
  }
}
```

Confidence level：

- `high`：可以自动采用
- `medium`：产品上可提示检查
- `low`：不宣称自动正确，交给人工校正或 legacy 兜底

## 第一轮实现计划

### Step 0：冻结对照

保留当前数据作为 baseline：

- legacy selected：`587 / 931`
- hybrid selected：`587 / 931`
- hybrid oracle：`871 / 931`
- split：
  - train legacy：`353 / 527`
  - tune legacy：`132 / 201`
  - holdout legacy：`102 / 203`

### Step 1：新增离线实验脚本

新增脚本建议：

```text
scripts/rkb_constant_grid_dp_lab.py
```

职责：

- 读取 truth + feature cache
- 对每首歌构建 tempo lattice
- 对每个 tempo 构建 phase lattice
- 对 phase 做 segment scoring
- 输出完整候选和 summary

输出建议：

```text
grid-analysis-lab/rkb-rekordbox-benchmark/constant-grid-dp-lab-latest.json
```

### Step 2：只做 phase lattice MVP

第一版先不重做所有东西，优先验证最大风险点：

```text
固定 tempo 候选集合 -> 新 phase scorer -> bar phase solver -> benchmark
```

Tempo 候选先使用：

- legacy BPM
- window integer BPM
- window centi-BPM
- beat-logit autocorr top BPM

如果 phase scorer 在 holdout 不能明显超过 legacy，就不要继续堆 bar/selector。

### Step 3：加入分段稳定性

把 120 秒音频切成多个段：

- 4 段：每段 30 秒
- 或 8 段：每段 15 秒

每个 phase 输出：

- `segmentMean`
- `segmentMedian`
- `segmentMin`
- `segmentStd`
- `segmentAgreement`

真正可信的 phase 应该不是只靠某一段爆分。

### Step 4：重新做 bar phase

在 phase 结果稳定后，再接 downbeat logits：

- mod4 candidate score
- margin
- segment stability
- low confidence reason

不要让 bar phase 的不确定性污染 firstBeat phase。

### Step 5：接 benchmark profile

当 lab 输出稳定后，再接入：

```text
scripts/benchmark_rkb_rekordbox_truth.py
scripts/run_parallel_rkb_rekordbox_benchmark.py
```

新增 solver 名：

```text
constant-grid-dp
```

不要覆盖 `hybrid`，避免污染现有实验记录。

## 验收标准

### 可继续推进

满足以下条件才继续工程化：

- all selected pass > legacy
- train/tune/holdout 都上涨
- holdout 不低于 legacy holdout
- legacy pass 误伤明显小于 legacy fail 救回
- 没有依赖 source/name/path/truth 的规则

### 可认为有突破

满足以下条件才认为新主线有效：

- all selected pass >= `70%`
- holdout selected pass >= `65%`
- high-confidence pass >= `80%`
- high-confidence coverage >= `50%`

### 接近产品化

满足以下条件才考虑替代 legacy：

- all selected pass >= `80%`
- holdout selected pass 同步接近或超过 `80%`
- high-confidence pass 稳定高于 `90%`
- 低信心样本能被可靠识别

## 判死标准

以下情况出现，应停止该方向：

- train/tune 明显上涨但 holdout 不涨
- 需要高维模型才能涨
- 需要按 source 写复杂优先级
- 需要使用 encoder/offset 的稀有组合硬调
- 救回数和误伤数接近
- high-confidence 只是低覆盖的样本挑选，不能解释全量改进

## 下一轮开工顺序

1. 建 `scripts/rkb_constant_grid_dp_lab.py`
2. 实现 feature cache 读取和 split summary
3. 实现 tempo lattice 最小集合
4. 实现 phase lattice 粗扫 + 精扫
5. 实现 segment scoring
6. 输出候选 JSON
7. 用 truth 只做 benchmark 评估，不进入算法决策
8. 和 legacy / current hybrid 对比
9. 如果 holdout 不涨，停止该 branch
10. 如果 holdout 涨，再接 bar phase 和 confidence

## 当前判断

现有 hybrid 不应继续作为生产 solver 推进。

但它留下了一个有价值事实：

```text
正确答案经常能被生成，但现有 selector 没有足够稳定信号选中。
```

所以下一阶段的核心不是“更多候选”，而是：

```text
用全曲结构和分段稳定性重新定义正确 beatgrid 的评分函数。
```

## 本轮归档结论

已落地内容：

- 新增 feature cache / candidate lab / hybrid solver / constant-grid-dp solver 实验链路。
- `benchmark_rkb_rekordbox_truth.py` 和 parallel runner 支持 `legacy`、`hybrid`、
  `constant-grid-dp` solver。
- constant-grid-dp 使用保守切换闸门：仅在 legacy 内部质量弱、new top candidate 分数足够、
  tempo 稳定且 downbeat evidence 不过强时，从 legacy fallback 切到新候选。
- 全量 current 已按 constant-grid-dp conservative 结果归档：
  `594 pass / 337 fail = 63.80%`。
- classification 派生视图和音频目录已同步；复查 `sync_frkb_classification_audio_dirs.py --dry-run`
  结果为 `moveCount = 0`。

已判死或暂缓的方向：

- 单纯调现有 selector 权重，直接选 new top1 只有约 22% pass。
- 线性 ranker、小 MLP、legacy 置信度 gate、固定 phase shift、target peak offset 和
  BeatThis beat lag target 都没有在 split 上稳定接近 70%。
- 正确候选常在候选池中，但很多时候不是现有音频峰值/BeatThis 贴合度最高的候选。

下一步优先级：

1. 做人工观察工具，不继续盲调 selector。
2. 同轴展示 Rekordbox truth、legacy、top candidate、oracle candidate、waveform peak、
   onset/front、BeatThis beats。
3. 只让人工判断“Rekordbox truth 更像贴前缘、峰值中心还是其他视觉网格习惯”。
4. 把观察结果变成 offset 分布和 split 报告，再决定是否新增 onset-front / transient-front
   phase evidence。
