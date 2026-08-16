# 段落分析重做方向草案

创建日期：2026-07-28

状态：方向讨论草案，未实施、未验证。本文只负责回答"为什么现在的路走不下去"和"可以换哪几条路"，
不替代 `song-structure-truth-benchmark-workflow.md`（唯一有效评估流程），也不替代
`techno-song-structure-analysis-optimization-draft.md`（v17–v32 架构演进与历史实验记录）。

本文所有代码事实来自 2026-07-28 对 `a49782ef` 工作树的实际阅读。所有性能、精度数字若未注明来源，
均为待验证估计，不得当成已测结论引用。

目标口径（本次讨论确认）：**任何比较规整的电子音乐都要准**，不限于当前个人曲库。太极端 / 实验性的
素材不在范围内。这个口径是后面所有路线取舍的前提——它排除了"只靠手调规则拟合自己那几首"的做法。

---

## 1. 三个诊断

### 1.1 没有尺子（最关键）

现有 truth 集里可评分的 5 首，**不是人工标注，是算法自己跑出来、用户看着满意就留下的结果**。

后果有三层：

1. 指标测的是"算法和它自己过去的输出有多一致"，这直接解释了 strict label accuracy = `0.964722`
   这种数字——它不是精度高，是自我一致。
2. 指标会**惩罚任何改动**。任何让算法偏离旧输出的改进，在这套指标下都表现为下降。这解释了
   v29 / v31 / v32 三个版本 boundary F1 全部锁死在 `0.918033` 的现象。
3. 这违反了 `song-structure-truth-benchmark-workflow.md` §2.2 自己写下的规则（原文）：

   > 只有用户实际试听并明确认可后，才能把 `review.status` 改成 `approved`。算法 prediction、UI 当前
   > 显示、旧聊天里"看起来还行"的描述都不能自动升级成 truth。

结论：**当前有效真值数量为 0**。在补上真值之前，任何"指标涨了/跌了"的结论都不成立。

### 1.2 缺的是标注工具，不是标注意愿

用户手上现在**没有任何标注手段**，唯一的操作是"打开 FRKB，看分析结果"。所以真值缺失的根因是工具
缺失，不是不愿意标。

一个够用的标注工具需要：

- 拖拽粗定位 + 自动吸附到四拍线（truth 存的是 `startDownbeatOrdinal`，不是秒，所以拖拽不精确不重要）
- 方向键微调 ±1 个四拍块
- 段落标签编辑
- 增删边界
- 标签本身有歧义时能写 `acceptableKinds`

顺带的好处：这套 UI 同时就是日常检查分析结果的界面，不是一次性投入。

### 1.3 自由度和监督量严重不匹配

语义 / 边界后处理层的规模（不含 spec 文件）：

```
songStructureSemanticLabels.ts             1004
songStructureSpectralClustering.ts          731
songStructureSemanticOutro.ts               625
songStructureSemanticInactiveValley.ts      595
songStructureSemanticFoundationLanding.ts   412
songStructureDirectionalBoundaries.ts       409
songStructureSemanticBuild.ts               242
songStructureSemanticBoundaryAlignment.ts   229
songStructureSemanticStateGuards.ts         223
songStructureStructuralEvidence.ts          198
songStructureSemanticMacroActivity.ts       159
songStructureSemanticReentry.ts             126
songStructureSemanticStability.ts            84
songStructureSemanticActivity.ts             77
------------------------------------------ ----
合计                                       5114
```

加上 `songStructureAnalysis.ts`（36 KB）与 `songStructureAlgorithmic.ts`（29 KB），总量约 6800 行，
其中包含 **588 个手写的 `0.xx` 小数常量**。

监督信号是 0 首真值。6800 行 / 588 个常量 vs 0 首真值——这个比例本身就说明为什么继续加规则不会收敛。

### 1.4 用户实际抱怨的错误类型

边界位置错、段落数量错、标签错，**三种都有**。如果只有标签错，那是后处理规则问题；三种同时出现，
指向的是更底层的**表征层**（喂给聚类的特征根本分不开这些段落），不是某条规则。

### 1.5 不是主要问题的两件事

- **四拍线偶尔是错的**，但单个网格的相位大概率是对的。所以网格质量不是当前瓶颈；标注时避开网格明显
  有问题的曲子即可。
- **拖拽不精确**不是问题，因为边界吸附到四拍线，truth 存的是序号。
- **memory cue 用户不打**（hot cue 偶尔打）。所以"从 cue 里免费捞边界标签"这条路不成立。

### 1.6 一个放大器：默认跳到 drop

`playbackRange.ts` 默认定位到 `drop`。这把整个功能的"准不准"绑在六类里最主观的一类上，会显著放大
用户感知到的不准。这一条和算法本身无关，但影响体验判断。

---

## 2. 已确认的技术前提

### 2.1 生产环境跑的不是实验路径（重要）

`src/main/workers/keyAnalysisWorker.ts:590-634` 的生产调用漏掉了第三个参数：

```ts
const songStructure = buildSongStructureAnalysisV23({
  waveformData: structureWaveformData,
  beatGridMap
})
```

没有传 `structureFeatureData`，所以生产环境静默走的是 **pseudo-color 路径**（`summarizeBar`，
`src/shared/songStructureSpectralFeatures.ts:319`），而不是绝对频段路径（`summarizeAbsoluteBar`，
同文件 `:430`，约 400 行已测但生产未启用的代码）。

`buildSongStructureFeatureDataFromMixxx` 需要的 `waveform` 变量**就在同一个函数作用域里**，是可以直接
传的。用户对这个遗漏的回应是"没印象"——所以这是**意外漏掉，不是有意推迟**。

同时 `scripts/benchmark_song_structure_truth.ts:317` 的 `--absolute-bands` 默认 **false**。所以历史记录
的所有指标都是 pseudo-color 路径的指标，绝对频段路径**从来没有做过生产 A/B**。

`techno-song-structure-analysis-optimization-draft.md` §4.4 已经写明相对频段占比无法替代绝对频段。也就
是说，文档知道这件事，代码写好了，但两边都没打开开关。

### 2.2 项目已经带着完整的 Python + torch 运行时

`vendor/demucs/{win32-x64,darwin-*,linux-*}/runtime-{cpu,cuda}`，配合
`prepare-demucs-runtimes.mjs` / `ensure-demucs-runtime.mjs` / `package-demucs-runtime-assets.mjs`，
`electron-builder.yml` 的 `extraResources` 已经在分发 `demucs/bootstrap` 和 `demucs/models`。
DirectML / MPS 加速与 CPU 回退都已经处理过。

这条直接**推翻** `techno-song-structure-analysis-optimization-draft.md` §11.7 "不建议直接引入大型神经
网络"的前提——当时的理由是分发成本，而分发成本现在已经付过了。

### 2.3 Beat This 的表征被浪费了

生产已在用 Beat This 做节拍网格。它的结构是：

```
LogMelSpect(22050 Hz, hop 441 → 50 fps, 128 mel, 30–11000 Hz)
  → stem conv + 3 个 frontend block（partial freq/time transformer）
  → linear → transformer_dim=512
  → 6 层 RoFormer（rotary embedding, dim_head=32, 12 heads）
  → SumHead → beat / downbeat logits
```

`scripts/beat_this_bridge.py:895-974` 只取 `model_prediction["beat"]` / `["downbeat"]`。也就是
**512 维 / 50 fps 的 transformer 输出被压成了 2 个标量**。而 `serve()` 是常驻进程、模型常驻内存，
逐首喂 stdin——多取一份中间表征几乎不增加推理成本。

---

## 3. 候选路线

按"是否需要大量人工真值"和"能不能泛化到任意规整电子音乐"两个维度排。

### 3.1 路线 A：冻结预训练编码器 + 训练一个薄头（推荐主线）

核心逻辑：泛化能力来自数据量；用户提供不了数据量；所以数据量必须来自公开数据或预训练模型。冻结一个
强预训练音乐编码器，只训练很薄的一层头——这样需要的标注量降到最低，同时拿到大模型的泛化能力。

**证据 1：SongFormer**（arXiv 2510.02797，2025-10，`github.com/ASLP-lab/SongFormer`，代码 CC-BY-4.0，
权重在 HuggingFace `ASLP-lab/SongFormer`）

结构：**冻结的** MuQ + MusicFM(MSD) 两个 SSL 编码器，取第 10 层，分别在 30 s 和 420 s 两个窗口上跑
→ 四路 1024 维拼接 → 降采样 ×3（25 Hz → 约 8.33 Hz）→ 可学习的 source embedding（HX/E/H/G，推理时固定
为 HarmonixSet）→ 4 层 Transformer（hidden 512）→ boundary head + functional head。

损失：BCE + boundary-aware 1D TV 平滑；CE + focal。后处理沿用 All-In-One（sigmoid → 局部极大值滤波 →
peak-picking；每段标签取平均概率最高的类）。

**没有 demucs，没有 NATTEN。**

标签 8 类：intro, verse, pre-chorus, chorus, bridge, inst, silence, outro（7 类评估时 pre-chorus 并入 verse）。

指标：

| 测试集 | ACC | HR.5F | HR3F |
| --- | --- | --- | --- |
| SongFormBench-HarmonixSet(200) | .795 | .703 | .784 |
| SongFormBench-CN(100) | .891 | .690 | .852 |
| RWC-Pop(100，完全留出) | .814 | .650 | .804 |

对比：LinkSeg-7Labels .780/.630/.762；Gemini 2.5 Pro .748/.423/.813。

速度：单张 NVIDIA L40 上 2–4 s/首（LinkSeg 3–5 s，All-In-One 9–12 s，Gemini 30–90 s）。

安装：`git submodule update --init --recursive`（拉 MuQ + MusicFM），Python 3.10，
`pip install -r requirements.txt`，`python utils/fetch_pretrained.py`。推理
`src/SongFormer/infer/infer.py` / `infer.sh`，`-i` 传一个 SCP 目录路径（每行一个音频绝对路径）。
已知需要打的补丁：`src/third_party/musicfm/model/musicfm_25hz.py` 第 121 行可能要改
`weights_only=False`。

**未验证的风险**：只在 Ubuntu 22.04.1 上测过；benchmark 跑在 NVIDIA L40 上；脚本围绕
`CUDA_VISIBLE_DEVICES` 组织；**Windows / CPU 支持既没确认也没否认**。所有 benchmark 都是流行乐，
没有任何 EDM 分项。

**证据 2：《Do Foundational Audio Encoders Understand Music Structure?》**（arXiv 2512.17209，2025-12）

11 个 FAE 家族，全部**冻结 + 单层线性**（1 个 boundary 输出 + 7 个 function 输出）评测：

- MusicFM(MSD) 总体最好：boundary HR.5F 54.2（unpooled），PWF 66.9，ACC 68.1。
- AudioMAE(Zhong) 在 pooled 设置下 HR.5F 53.9 / HR3F 64.9 最好。
- 编解码器类（EnCodec、DAC）最差（HR.5F 约 19–24，ACC 约 45–55）——重建导向的声学特征打不过
  掩码语言建模的语义特征。
- MULE 被 0.5 Hz 帧率拖累；论文主张帧率 ≥2 Hz。
- **长上下文有用**：MusicFM 的 30 s 窗口优于 MERT / AudioMAE 的 5 s。

这篇的意义是：**一层线性就能到 ACC 68.1**。它把"冻结编码器 + 薄头"从猜测变成了有下限的方案，也说明
需要的标注量远低于从零训练。（同样没有 EDM 分项；微调留作 future work。）

**待解问题**：

- SongFormer / MusicFM / MuQ 在 Windows CPU 上能不能跑、多快。没找到硬性阻塞（纯 Transformer，
  无 NATTEN），但没测过。
- 这些编码器的表征里有没有 techno 特有的结构语义（所有 benchmark 都是 pop）。
- 标签体系不匹配：SongFormer 8 个 pop 类 vs FRKB 6 个 techno 类
  （intro / groove / breakdown / build / drop / outro）。假设：**SongFormer 的边界可能直接可用，
  标签需要一个小的重映射头**——给已经切对的段落改名，比从零找边界容易得多。

### 3.2 路线 B：Beat This 线性探针（廉价的可行性探测）

拿 §2.3 里那份被丢掉的 512 维 / 50 fps 表征，冻结，接一层线性，看能不能预测边界。

价值不在于它一定能work，而在于成本极低：模型已经常驻内存，推理已经在跑，只需要多导出一份中间张量。
如果它有信号，说明"冻结表征 + 薄头"这条路在本项目内可行且几乎零分发成本；如果没有，也只花了很少
的时间，并且给路线 A 的必要性提供了证据（节拍任务的表征不含结构语义）。

风险：Beat This 是为节拍任务训练的，表征可能高度特化于周期性，不含段落语义。这是需要测的，不是能
推断的。

### 3.3 路线 C：绝对频段 A/B（已经写好的实验，顺手做）

代码已存在且已测（§2.1），只是生产和 benchmark 两边的开关都没开。成本几乎为零：

- `keyAnalysisWorker.ts` 补传 `structureFeatureData`
- benchmark 加 `--absolute-bands`

但要注意：**在没有真值的前提下，这个 A/B 无法判定好坏**（§1.1 第 2 点）。所以它的排序应该在标注工具
之后，或者只用来做人工试听对比。

### 3.4 路线 D：产品语义调整（独立于算法）

改 `playbackRange.ts` 的默认落点，不要默认跳 `drop`（§1.6）。这不修算法，但降低感知不准。可以随时做。

---

## 4. 明确不推荐的方向

### 4.1 继续加手写规则

在目标口径是"任意规整电子音乐都准"的前提下，手调规则的上限就是**编码个人偏好**。泛化需要学习，学习
需要数据量，数据量只能来自公开数据或预训练模型。已有 588 个常量 / 6800 行的事实说明这条路已经到顶。

（如果目标退回"只要我这几十首准"，手调规则是可行的——但用户明确否掉了这个口径。）

### 4.2 All-In-One（Kim & Nam, WASPAA 2023, arXiv 2307.16425, MIT）

技术上很强：demixed（HT-Demucs）频谱 → Beat Transformer 前端 → 交替 1D DiNA + 2D NA。约 300K 参数
（Small 46K）。Harmonix 8-fold：HR.5F .660，PWF .738，Sf .769，beat F1 .958，downbeat F1 .915。
输出 100 fps，embedding `[stems=4, time, 24]`，10 个标签。

**因分发原因排除**：依赖 NATTEN——Windows 上只能用 MSVC 从源码构建，官方声明未测试 / 不支持，且要求
NVIDIA compute capability 7.5+；madmom 必须从 GitHub 装而不是 PyPI。FRKB 主要分发到 Windows，且必须
在没有独立显卡的机器上能跑。

### 4.3 在补真值之前追指标

见 §1.1。当前指标是自我一致度，会惩罚任何改进。在有真人标注之前，指标数字不能作为决策依据。

---

## 5. 建议的执行顺序

1. **零成本先看一眼**：把 3–5 首熟悉的 techno 丢进 SongFormer（或它的 HuggingFace Space demo），
   人眼看边界对不对。**不需要标注、不需要改代码、不需要训练。** 这一步决定路线 A 值不值得投入。
2. **做标注工具**（§1.2）。它是所有后续判断的前提，且顺带改善日常检查体验。
3. **标一批真值**。避开四拍线明显有问题的曲子（§1.5）。数量按"验收信号"要求走——干净、可以少
   （训练信号可以廉价 / 有噪声 / 来自公开数据，两者不要混为一谈）。
4. **路线 B 线性探针**（§3.2），廉价，同时验证"冻结 + 薄头"这套做法在本项目的可行性。
5. **路线 A 落地**（§3.1），先验证 Windows / CPU 可跑性，再处理标签重映射。
6. 路线 C / D 随时可插入，成本极低。

---

## 6. 待回答的问题

- SongFormer 在 Windows CPU 上的可跑性与速度（无已知阻塞，未测）。
- 冻结编码器的表征是否含 techno 结构语义（所有公开 benchmark 都是 pop，无 EDM 分项）。
- Beat This 表征是否含结构信息（路线 B 的直接测试目标）。
- 标签映射：SongFormer 8 类 pop → FRKB 6 类 techno 的对应关系怎么定，是否需要单独的小头。
- 现有 6800 行后处理层的处置：如果路线 A 成立，哪些模块保留（例如边界对齐到四拍块）、哪些废弃。
- 可用公开数据：Harmonix Set（912 首 pop，含 beats/downbeats/functional segments，**只有标注没有
  音频**）、SALAMI、RWC-Pop、Isophonics、Verse-Bench。

---

## 7. 文档维护边界

- 本文只写方向与诊断，**不写任何单曲信息**。
- 评估流程的执行细节归 `song-structure-truth-benchmark-workflow.md`（含 MP3 必须用 native-libav /
  44100 Hz / 立体声 PCM，以及 §8 holdout 纪律）。
- v17–v32 架构演进与历史实验记录归 `techno-song-structure-analysis-optimization-draft.md`。
- 本文推翻了该文档 §11.7 的前提（见 §2.2），但不修改该文档——历史记录保持原样，以本文为后续依据。
