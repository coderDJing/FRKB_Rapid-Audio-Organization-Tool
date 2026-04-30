# FRKB Hybrid Correct Beatgrid Solver 草案

## 目标

本方案的目标不是复刻 Rekordbox 的所有输出习惯，而是利用已经人工过滤过的
Rekordbox 正确样本作为 truth，生成音乐上正确、DJ 软件可用的网格线。

当前 truth 的含义：

- 保留：人工确认正确的 Rekordbox 网格。
- 排除：Rekordbox 分析错误或人工认为不可用的样本。
- 验收对象：`bpm`、`firstBeatMs`、`barBeatOffset` 组成的常速 beatgrid。

因此，算法目标应表述为：

```text
音频 -> 多源节拍/起拍/下拍特征 -> FRKB 自己的全局网格求解器 -> 正确 DJ beatgrid
```

而不是：

```text
BeatThis postprocessed beats -> 局部修补 -> 期待等价于正确 beatgrid
```

## 当前瓶颈

当前 `current` benchmark 最新状态：

- 总样本：931
- 通过：587
- 失败：344
- 通过率：63.05%
- 失败分类：`first-beat-phase` 298，`bpm` 31，`downbeat` 14，`half-or-double-bpm` 1
- 候选覆盖：629 首存在 passing candidate，302 首候选池缺正确答案，42 首是 scorer 选错

这说明继续只调 scorer 和 guard 的收益会很低。因为 scorer 只能在已经存在的候选里选择；
302 首没有正确候选的样本，需要先提高 candidate recall。

## 核心判断

BeatThis 仍然应该保留，但它不应该直接负责最终网格。

BeatThis 适合提供：

- beat logits
- downbeat logits
- 粗 beat/downbeat 序列
- 粗 BPM 与节拍周期线索

BeatThis 不适合单独承担：

- 2ms 级 `firstBeatMs` 精修
- DJ constant beatgrid 的全曲相位决策
- Rekordbox/人工 truth 语义下的 bar offset 决策

原因是 BeatThis 的高层输出是 beat/downbeat times，不是 DJ beatgrid。它的 frame rate 是 50fps，
天然是 20ms 粒度；最终要对齐到毫秒级，需要用 waveform/onset/envelope 做连续相位搜索和精修。

## 可抄作业的部分

### BeatThis

继续作为主要神经特征源。短期优先使用 logits，而不是只使用 postprocessed beats。

可借鉴：

- `Audio2Frames` / `Spect2Frames` 的 frame logits 输出思想。
- `split_predict_aggregate` 的长音频切片预测方式。
- downbeat logits 作为 bar phase 评分来源。

注意：

- 高层 `Audio2Beats` 结果可以保留为候选来源之一。
- 不应把 `Audio2Beats` 输出的第一拍直接视为最终 `firstBeatMs`。

### madmom / DBN 思路

madmom 的价值不在于“直接替换 BeatThis”，而在于 DBN/Viterbi 风格的序列约束。

可借鉴：

- tempo 状态连续性
- beat phase 状态转移
- downbeat/meter 状态转移
- 用动态规划选全曲最一致的路径

短期不一定直接集成 madmom，先实现简化版 constant-grid lattice scorer 更现实。

### Essentia

Essentia 的 `RhythmExtractor2013(method="multifeature")` 可以作为独立 BPM/beat 候选来源。

可借鉴：

- multi-feature tempo estimation
- confidence / interval 输出
- 整首歌离线分析思路

授权注意：

- Essentia 涉及 AGPLv3 / 商业授权风险。
- 在授权确认前，只适合作为实验对照或可选外部工具，不应直接打进发行包。

### Mixxx / DJ 软件思路

Mixxx 这类 DJ 软件的关键启发是：最终产品模型不是 beat list，而是 beatgrid。

可借鉴：

- 默认按整首歌分析。
- 支持 constant tempo 假设。
- 把错误拆成 BPM 错、first beat 错、bar/downbeat 错。
- UI 上允许用户修正第一拍和 BPM，但算法层先尽量给出稳定初值。

注意：

- Mixxx 是 GPL 系项目，不能直接复制代码进当前产品。
- 可以参考设计思想和公开文档，不照搬实现。

## 新架构

### 1. Feature Cache 层

目标：把慢的音频特征提取和快的候选实验拆开。

每首歌缓存：

- 解码后的基础信息：sample rate、duration、channels、time basis。
- BeatThis beat/downbeat logits。
- BeatThis postprocessed beats/downbeats。
- fullband onset envelope。
- lowband onset envelope。
- spectral flux / transient strength。
- 可选外部候选：Essentia BPM/beat，madmom/BeatNet 对照结果。

缓存要求：

- 按音频文件 hash、mtime、BeatThis 版本、checkpoint、特征参数生成 cache key。
- 任何 solver 参数变化不触发重新跑 BeatThis。
- benchmark 实验优先读缓存，避免每次迭代几小时。

### 2. Tempo Lattice 层

目标：先让正确 BPM 候选进入候选池。

候选来源：

- BeatThis beat interval median / robust regression。
- BeatThis logits autocorrelation。
- onset envelope autocorrelation。
- comb filter tempo search。
- Essentia/madmom/BeatNet 可选候选。
- 整数 BPM snap。
- half/double/octave variants。

输出：

```json
{
  "bpm": 124.0,
  "source": "logit-autocorrelation",
  "confidence": 0.82,
  "octaveGroup": "124/62/248"
}
```

第一阶段目标不是选中唯一 BPM，而是提高 tempo recall。

### 3. Phase Lattice 层

目标：让正确 `firstBeatMs` 相位进入候选池。

对每个 BPM 候选做全曲相位搜索：

- 粗扫：1ms 或 2ms step。
- 精修：在 top phase 附近做 0.1ms 到 0.25ms 局部搜索。
- 评分特征：
  - beat logits sampled mean
  - beat logits sampled p75/p90
  - onset envelope peak alignment
  - lowband onset alignment
  - local peak contrast
  - silence/head-start penalty
  - drift penalty

关键变化：

- 不再只相信 BeatThis 的第一个 beat。
- firstBeat 可以落在 BeatThis frame 之间，由 envelope 连续精修决定。
- 对 intro/pickup/弱起样本，允许 phase 从全曲一致性反推。

### 4. Bar Phase 层

目标：独立决定 `barBeatOffset`，不要和 firstBeat 修正混在一起。

候选范围：

- 常规 4 拍 bar phase：0、1、2、3
- 当前系统需要保留 exact 32 offset 时，再扩展到 0..31

评分特征：

- downbeat logits sampled mean
- downbeat logits margin
- downbeat peak coverage
- phrase-level consistency
- harmonic/onset accent 可选特征

输出应区分：

- mod4 downbeat 是否正确
- exact32 offset 是否正确

### 5. Unified Grid Scorer 层

最终候选形态：

```json
{
  "bpm": 124.0,
  "firstBeatMs": 12.4,
  "barBeatOffset": 0,
  "tempoSource": "logit-autocorrelation",
  "phaseSource": "full-track-phase-lattice",
  "barSource": "downbeat-logit-lattice",
  "features": {
    "tempoScore": 0.91,
    "phaseScore": 0.84,
    "downbeatScore": 0.76,
    "onsetScore": 0.81,
    "driftPenalty": 0.02,
    "headRisk": 0.14
  }
}
```

评分器原则：

- 不看文件名、歌名、truth、pass/fail 状态。
- 不写逐曲规则。
- 先使用可解释手工权重。
- 候选覆盖足够后，再考虑用 truth 训练 ranking model。

## Benchmark 验收方式

不要只看最终 pass rate，要拆成四层：

1. Tempo recall：正确 BPM 是否在候选池。
2. Phase recall：正确 `firstBeatMs` 是否在候选池。
3. Downbeat recall：正确 `barBeatOffset` 是否在候选池。
4. Selection pass：最终 scorer 是否选中正确候选。

推荐新增 summary：

```json
{
  "tempoCandidatePassCount": 0,
  "phaseCandidatePassCount": 0,
  "downbeatCandidatePassCount": 0,
  "gridCandidatePassCount": 0,
  "selectedPassCount": 0
}
```

阶段性目标：

- 短期：candidate pass 从 629 提升到 720+。
- 中期：selected pass 从 587 提升到 680+。
- 长期：稳定通过率进入 80% 区间，再考虑更复杂的动态 tempo 或人工校准体验。

## 实施路线

### Phase 0：固化基线

- 保留当前 `frkb-current-latest.json` 作为 baseline。
- 固化当前 931 首 truth dataset。
- 输出失败样本分层报表：BPM miss、phase miss、downbeat miss、scorer miss。

### Phase 1：Feature Cache

新增实验脚本，优先不动生产 bridge：

- `scripts/rkb_beatgrid_feature_cache.py`
- `grid-analysis-lab/rkb-rekordbox-benchmark/feature-cache/`

目标：

- 一次性提取 BeatThis logits 和 onset 特征。
- 后续 candidate/scorer 实验只读缓存。
- 把一次实验从几小时压到分钟级。

### Phase 2：Tempo/Phase Candidate Lab

新增实验脚本：

- `scripts/rkb_beatgrid_candidate_lab.py`

目标：

- 不改变现有生产输出。
- 只统计候选覆盖率。
- 优先攻克 302 首 candidate miss。

### Phase 3：Unified Solver

新增独立 solver：

- `scripts/rkb_hybrid_beatgrid_solver.py`

目标：

- 输入 feature cache。
- 输出统一候选列表和最终选择。
- 与当前 `beat_this_bridge.py` 并行对照，先不替换线上路径。

### Phase 4：接入 bridge

当 hybrid solver 在 current benchmark 上明显优于旧路径，并且没有大面积回退后，再接入：

- `scripts/beat_this_bridge.py`
- Electron `beatThisAnalyzer` 调用链

接入方式：

- 默认走 hybrid solver。
- 保留旧 solver 作为 debug/对照开关。
- benchmark 输出同时记录 solver version。

### Phase 5：可选外部引擎

按授权和打包成本决定是否加入：

- Essentia：作为外部实验候选源或商业授权后集成。
- madmom：优先借鉴 DBN 思路，直接集成需验证 Windows 打包成本。
- BeatNet：仅作为 research candidate source，先不作为核心依赖。

## 非目标

短期不做：

- 实时 beat tracking。
- 自动修动态 tempo / live drumming 全曲变速。
- 从零训练神经网络。
- 直接复制 GPL/AGPL 代码进产品。
- 为单首失败歌写规则。

## 风险

- 2ms 级 truth 会暴露 BeatThis 50fps 粒度限制，必须做 waveform/onset phase refine。
- 如果 truth 样本风格偏，后续 ranking model 可能过拟合。
- 外部库授权和 Windows 打包可能比算法本身麻烦。
- 如果不先做 feature cache，实验效率会继续拖垮迭代。

## 下一步建议

优先做 Phase 1 和 Phase 2，不急着改生产 bridge。

第一张交付表应该长这样：

```text
baseline selected pass: 587
baseline grid candidate pass: 629
hybrid tempo recall: xxx
hybrid phase recall: xxx
hybrid downbeat recall: xxx
hybrid grid candidate pass: xxx
hybrid selected pass: xxx
```

只要 `hybrid grid candidate pass` 明显涨，后面 scorer 才有继续优化的空间。

## 参考

- BeatThis: https://github.com/CPJKU/beat_this
- beat-this PyPI: https://pypi.org/project/beat-this/
- Essentia RhythmExtractor2013: https://essentia.upf.edu/reference/std_RhythmExtractor2013.html
- madmom: https://github.com/CPJKU/madmom
- Mixxx: https://github.com/mixxxdj/mixxx
