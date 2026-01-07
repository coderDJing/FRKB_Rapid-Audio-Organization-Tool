# Mixxx QM 调性分析草案

状态：草案

目标
- 离线批量分析调性，输出与 Mixxx 一致。
- 输出 ID3v2 ASCII 文本（例如 C#m）。
- 仅实现 Mixxx Queen Mary 算法。
- 支持 fast analysis：只分析前 60 秒。

非目标
- 实时分析。
- 多算法切换。
- 持久化 key change list。
- 8 声道 stem 特殊处理（暂不做）。

Mixxx 参考位置
- src/analyzer/plugins/analyzerqueenmarykey.cpp
- lib/qm-dsp/dsp/keydetection/GetKeyMode.cpp
- src/analyzer/constants.h（fast analysis 60s）
- src/track/keyutils.cpp（ID3v2 字符串 + 全局 key 计算）
- src/analyzer/plugins/buffering_utils.cpp（下混 + 重叠分帧）

算法概要（Queen Mary / GetKeyMode）
1) 输入：交错立体声 float32 PCM。
2) 下混为单声道 + 重叠分帧。
3) Constant-Q chromagram（每八度 36 个 bin）。
4) HPCP 平均 + 中值滤波。
5) 与大调/小调模板做相关性（Krumhansl profiles）。
6) 每个窗口取相关性最大值作为 key。
7) key change list：当 key 发生变化时记录。
8) 全局 key：按持续时长投票，取最大值。

关键参数（来自 Mixxx）
- 调音频率：440 Hz
- 每八度 bin 数：36
- Decimation factor：8
- Frame overlap factor：1
- HPCP average：10
- Median average：10
- Fast analysis 上限：60 秒

输入处理
- 解码为 float32，交错立体声。
- 单声道：复制到双声道。
- 多声道：简单平均下混为双声道。
- fast analysis 打开时，仅处理前 60 秒。

输出
- 仅返回全局 key 的 ID3v2 ASCII 文本。
- key change list 只用于内部计算，随后丢弃。

ID3v2 ASCII 映射（Mixxx s_IDv3KeyNames）
- INVALID -> o
- C_MAJOR -> C
- D_FLAT_MAJOR -> Db
- D_MAJOR -> D
- E_FLAT_MAJOR -> Eb
- E_MAJOR -> E
- F_MAJOR -> F
- F_SHARP_MAJOR -> F#
- G_MAJOR -> G
- A_FLAT_MAJOR -> Ab
- A_MAJOR -> A
- B_FLAT_MAJOR -> Bb
- B_MAJOR -> B
- C_MINOR -> Cm
- C_SHARP_MINOR -> C#m
- D_MINOR -> Dm
- E_FLAT_MINOR -> Ebm
- E_MINOR -> Em
- F_MINOR -> Fm
- F_SHARP_MINOR -> F#m
- G_MINOR -> Gm
- G_SHARP_MINOR -> G#m
- A_MINOR -> Am
- B_FLAT_MINOR -> Bbm
- B_MINOR -> Bm

全局 key 计算（Mixxx）
- 对每个 change i：
  duration = next_frame - frame_i（最后一段用 total_frames）。
  histogram[key_i] += duration。
- 全局 key = histogram 最大值对应的 key。

实现方案（Rust + C++）
- 引入 QM DSP 子集（GetKeyMode 及依赖）。
- 加一层 C wrapper：
  - init(sample_rate)
  - process(stereo_pcm, frames)
  - finalize() -> key change list
- Rust 侧：
  - 解码音频 -> float32
  - 转成 stereo
  - 流式喂给 QM analyzer；fast analysis 超过 60s 即停止
  - 计算全局 key + 映射到 ID3v2 文本
  - 返回结果

拟议 N-API（草案）
- analyze_key(paths, { fast: true }) -> [{ filePath, keyText, error }]

验证
- 10-20 首对照样本，与 Mixxx 同版本输出比对。
- 验收标准：ID3v2 key 文本完全一致。

风险/备注
- Mixxx 对 8 声道 stem 有特殊策略（排除鼓通道）；当前不做。
- QM DSP 内部用 double，建议保持一致以减少偏差。

下一步
- 确认解码格式边界。
- 确定 QM DSP 代码落位位置。
- 实现 C wrapper + Rust FFI。
