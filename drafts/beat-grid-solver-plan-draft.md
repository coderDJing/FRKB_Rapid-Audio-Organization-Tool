# Beat Grid Solver 方案草案

## 背景

当前 FRKB 的固定 BPM 网格主要依赖 Beat This 输出的 `beats / downbeats`，再用轻量 anchor 后处理修正 `firstBeatMs`。这条链路能跑，但问题是它把局部窗口的第一条 beat 赋予了过高权重，后续只能靠一堆毫秒级参数补救。继续这样调参没有清晰终点，容易在新增样本上过拟合。

Rekordbox 的准确度更像完整工程链的结果：它不会只相信第一拍，而是用全曲节奏稳定性、攻击点、BPM 先验、小节相位和异常剔除共同决定最终网格。

## 目标

- Beat This 降级为候选生成器，不再作为最终裁判。
- 最终输出由 Grid Solver 决定：`bpm`、`firstBeatMs`、`barBeatOffset`。
- `firstBeatMs / bpm` 与 `barBeatOffset` 分开求解、分开评估。
- 人耳真值以节拍器拍头为准，不要求同时校准小节重拍。

## 核心流程

1. Beat This 生成候选

   - 输出 `beats` 与 `downbeats`。
   - 这些候选用于估计节奏周期与小节相位，不直接决定最终第一拍。

2. 稳健 BPM 拟合

   - 对 beat 候选做线性拟合，估计 `beatInterval`。
   - 对电子舞曲保留整数 BPM 吸附，但必须允许非整数例外。
   - 后续可升级为 RANSAC / Huber loss，剔除漏拍、鬼拍、break 区错误候选。

3. Onset 相位评分

   - 从 PCM 构建多频段或宽频 attack envelope。
   - 固定 BPM 后，在候选第一拍附近扫描相位。
   - 每个相位生成完整网格，用窗口内所有网格点的 onset 分数评估。
   - 选择全局得分最高且置信度足够的相位作为 `firstBeatMs`。

4. 攻击起点校正

   - 不吸附到峰值中心，而是尽量回溯到 attack start。
   - 这解决“网格线看着落在鼓峰后面”的主观问题。

5. Downbeat / barBeatOffset 单独求解

   - `barBeatOffset` 只表示小节相位，不参与节拍器拍头真值。
   - 先保证每拍网格准确，再使用 Beat This downbeats、低频结构、phrase 周期选小节线。

## 第一阶段施工范围

- 在 `scripts/beat_this_bridge.py` 内加入保守版 Grid Solver。
- 复用现有 attack envelope，避免新增运行时依赖。
- 在当前 30 秒窗口内做相位扫描，先不改 IPC 与主进程滑窗结构。
- 仅当 Grid Solver 置信度足够时覆盖原 anchor 结果，否则回退现有 refined anchor。
- benchmark 目标：19 首人工真值 `refinedMeanGridAbsMs` 不高于当前基线 `4.198ms`。

## 后续阶段

- 将主进程滑窗改为全局候选汇总，而不是窗口早停。
- 引入跨窗口 beat 候选合并与 RANSAC BPM 拟合。
- 增加低频 kick envelope 与宽频 transient envelope 的加权评分。
- 给每首歌输出 grid confidence，低置信自动标记人工复核。
