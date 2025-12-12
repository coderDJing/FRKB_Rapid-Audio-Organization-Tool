# 本地精选预测后端方案（定稿）

## 背景与目标
- 需求：基于历史“已加入精选”的曲目（即便文件已删除）预测筛选库里最可能加入精选的候选；全程离线、用户零配置。
- 约束：仅使用歌曲自身信息（音频内容 + 元数据），不引入播放/跳过等行为特征；纯本地推理，不依赖服务器。
- 目标：在桌面端提供高精度的候选排序，优先准确率，其次兼顾包体和延迟。

## 数据与特征前提
- 正样本：历史精选曲目（含已删除文件），需保留元数据快照 + 音频指纹/嵌入。
- 负样本：筛选库中未被加入精选的曲目，可随机采样或取时间邻近但未选中的项。
- 稳定 ID：上层提供 `songId`，**推荐使用现有的 PCM 内容 SHA256（`sha256_Hash`）** 作为跨路径/重编码一致的主键，用于 features 表去重与历史对齐。
- 音频特征：首选嵌入（OpenL3 small），**第一版必做** Chromaprint 指纹 + HPCP/Chroma + BPM/Key（从音频内容提取），辅以响度、时长等统计特征。
- 元数据特征：艺人/流派/专辑/年份、BPM/调式/时长、比特率；标题/标签可做文本相似度（轻量 TF-IDF 或小型文本嵌入）。

## 模型选型（已拍板）
- **统一使用：OpenL3 small（优先 48 kHz 版，输出 256 维，fp32，`content_type=music`，`input_repr=mel256`）**。音乐相似度表现稳定，模型体积/推理成本和跨平台 ONNX 化风险都较低，满足纯本地开箱即用与准确率目标。
- 若算力/包体允许，可探索更大音频 Transformer（PaSST/Audio-MAE/MERT）的 ONNX 版，但部署复杂度更高。

## 部署形态（开箱即用）
- 推荐链路：开发阶段将模型转 ONNX → Rust 侧用 `onnxruntime` (`ort`) 推理 → 暴露 N-API 给 Electron；随应用打包 ORT 动态库或静态链接，首次运行零下载。
- 兜底：提供 wasm 推理路径（更慢、零原生依赖）以兼容平台差异。
- 预处理：音频解码/重采样、梅尔谱/增广等前处理尽量放在 Rust 侧，减少 JS 往返与 CPU 开销。
- 包体管理：模型与 ORT 二进制可压缩/分片随安装包，启动时校验哈希后解压到 `userData`。

## 推理与排序流程
1) **离线特征提取**  
   - 为筛选库批量提取音频嵌入 + Chromaprint/HPCP/BPM 等统计特征，写入本地缓存（如 SQLite/压缩 JSON/自定义二进制）。  
   - 对历史精选（含已删文件）使用已存快照的嵌入/指纹，无文件则只用已有特征。
2) **召回（相似度优先保证覆盖）**  
   - **默认：暴力全量余弦相似度计算**（不建 ANN 索引），保证无近似损失。  
   - 若后续实测查询过慢，再考虑 HNSW（hnswlib-rs）作为向下优化选项。  
   - 后端不做 Top‑N 预筛，`candidateIds` 全量进入重排；上层若需压缩候选量，可自行先取 Top‑N 再调用预测。
3) **重排（提高准确率）**  
   - **默认：GBDT 重排**，只用内容特征：音频相似度、Chromaprint/HPCP 距离、BPM/调式差、元数据匹配度（艺人/流派/年份/时长/比特率）、标题/标签相似度。  
   - 若暂不训练，可用加权规则先行：音频相似度为主，元数据作平滑加分/扣分（如低比特率、异常时长）。  
   - 输出最终排序，返回 Top‑K 候选。
4) **缓存与更新**  
   - 嵌入/索引持久化，检测文件 mtime/哈希变化后增量更新。  
   - 模型/索引版本号记录，便于升级时重建或迁移。

## 性能与体验
- 预处理/推理线程池在 Rust 侧控制，避免阻塞主进程；长任务要有可取消/进度回报。
- 曲库 < 数万：直接矩阵相似度即可；更大规模且查询变慢时再考虑 HNSW 向下优化。  
- 首次批量提取可分批执行并落盘中间结果，防止崩溃丢进度。
- 低配机型可降级到 wasm 推理路径（同一模型但更慢），保证可用性，不提供额外模式入口。

## 许可证与合规
- OpenL3 为 MIT 兼容，可随包分发；需确认转出的 ONNX/二进制依赖的许可证。  
- 不使用外部服务，无额外隐私风险；音频仅本地处理。

## 后端结论与风险
- **策略已定：暂不设包体/首次索引时间上限，以最大准确率为基线实现**；若实测包体或首次索引时间不可接受，再逐步向下探（量化、截断时长、降低窗口数等）。  
- **已定：第一版必做 Chromaprint/HPCP/BPM/Key**，并在缺失时依靠 `has_bpm/has_key/has_hpcp` 等标记让 GBDT 自行学习忽略。  
- **已定：训练降级阈值**：当 `positiveIds < 20` 或 `negativeIds < 4 * positiveIds` 时不训练 GBDT，直接回退到 OpenL3 相似度排序 + 规则平滑。  
- **已定：默认候选与输出**：后端不做 Top‑N 预筛；`predictSelectionCandidates` 默认返回 Top‑K=100（上层可覆盖）。  
- **已定：GBDT 实现与序列化**：使用纯 Rust `gbdt` crate；模型用 `bincode` 序列化保存，加载失败或版本不匹配时由上层触发重训。  
- **风险/假设**：元数据侧（BPM/Key/流派/年份等）存在缺失或噪声时，GBDT 依赖 `has_*` 标记自动降权；若缺失比例极高，元数据软特征贡献会变小，效果主要由 OpenL3/指纹特征决定。

## 准确率优先的初始配置
- 模型：OpenL3 small **fp32 全精度**，优先选 256 维输出（若有 48 kHz 版本则优先 48 kHz）。  
- 取样策略：**整曲滑窗提嵌入**。窗口长度按 OpenL3 原生约 1s；步长 `hop=0.1s`（≈90% 重叠）；首尾采用 center+reflect padding；整曲向量用能量加权平均（RMS 加权，低能量窗跳过）。  
- 运行时：Rust 侧优先使用 ORT（`ort`）推理以获取最稳的算子支持与较高性能；仅在平台兼容问题时退到 wasm 路径。  

## GBDT 特征与训练（基线）
### 1. 特征集合（仅歌曲自身信息）
**OpenL3 相似度统计（核心）**
- `openl3_sim_max`：候选与历史精选集合的最大余弦相似度。  
- `openl3_sim_top5_mean / openl3_sim_top20_mean`：Top‑5/Top‑20 相似度均值，提升稳健性。  
- `openl3_sim_centroid`：候选与“精选全局质心向量”的余弦相似度。  

**指纹/调性/节奏补充**
- `fp_sim_max / fp_sim_top5_mean`：Chromaprint 指纹相似度统计（哈明/相关系数）。  
- `hpcp_corr_max`：HPCP/Chroma 与精选曲目的最大相关（或最小距离）。  
- `bpm_diff_min`：与任一精选曲目 BPM 的最小绝对差。  
- `key_dist_min`：与任一精选曲目调式/主调的最小距离（五度圈/半音距离，模式不同时加 1）。  

**元数据相似度/约束（软特征）**
- `artist_match_any / album_match_any`：是否命中任一精选曲目的艺人/专辑（0/1）。  
- `genre_jaccard_max`：候选流派集合与精选流派集合的最大 Jaccard 相似度。  
- `year_diff_min`：与精选年份的最小绝对差（缺失则置为大值并加 `has_year` 标记）。  
- `duration_diff_min`：与精选时长的最小绝对差。  
- `bitrate_kbps`：候选码率（低码率会被树自动学习为负向信号）。  
- 关键字段缺失标记：`has_artist/has_genre/has_year/has_bpm/has_key` 等（0/1）。  

> 说明：训练集里若样本本身是正样本，计算 `*_sim_max/topK` 时需 **排除自身**（leave‑one‑out），避免泄露“自相似=1”。  

### 2. 训练方式（本地）
- 任务形式：二分类 GBDT（logistic loss），预测“加入精选概率”，按概率排序输出 Top‑K。  
- 样本输入（后端无业务假设）：  
  - 正样本 ID 列表 `positiveIds` 与负样本 ID 列表 `negativeIds` **由上层业务/前端提供**；后端仅基于这些样本做特征构建与 GBDT 训练/推理，不关心样本来自何种 UI 或业务流程。  
  - 上层若需要采样策略，可参考：正:负 ≈ 1:4，且负样本中约 50% 为与正样本相似但未被选中的 Hard negatives，用于提升 Top‑K 精度；具体如何采样由业务侧决定。  
- 训练实现：使用纯 Rust `gbdt` crate；超参先固定不调参：`depth 6–8, trees 300–600, lr 0.03–0.05, subsample 0.8`，必要时加早停。模型用 `bincode` 持久化，加载失败即视为需重训。  

### 3. 评估方式（离线、与业务指标对齐）
- 数据划分：优先按“加入精选时间”做时间切分（训练旧精选，验证新精选），若无时间戳再做分层随机 5‑fold。  
- 主指标：`Precision@K`、`Recall@K`、`NDCG@K`（K 建议 50/100），直接衡量前若干候选的命中质量。  
- 辅助指标：ROC‑AUC 监控整体分离度；同时记录不同流派/艺人子集的 Precision@K 做偏差检查。  

## 相似度计算与缓存（基线实现）
### 1. OpenL3 相似度
- 预处理：每首歌的整曲向量做 L2 归一化，余弦相似度可用点积直接计算。  
- 预测时计算：对筛选库候选向量 `C (N×256)` 与精选向量 `P (M×256)` 做批量点积/矩阵乘，得到相似度矩阵 `S (N×M)`。  
- 统计提取：对每个候选的 `S[i,*]` 用 partial‑topK（如 `select_nth_unstable`）取 Top‑20，再算 `openl3_sim_max/top5_mean/top20_mean`；`openl3_sim_centroid` 仅需候选与精选质心点积。  
- leave‑one‑out：训练时若样本本身属于正样本，计算其相似度统计时需从 `P` 中排除自身向量。  
- 计算实现：Rust 侧优先用 `rayon` 并行逐候选点积；若 N、M 都较大，再考虑 `ndarray + blas` 批量乘加。  

### 2. Chromaprint/HPCP/BPM/Key 相似度
- **第一版必做**这些特征的离线提取并落盘：  
  - Chromaprint：复用随包的 `fpcalc` 生成指纹（与现有指纹链路一致）。  
  - HPCP/BPM/Key：在 Rust 侧基于解码后的 PCM 计算 Chroma/HPCP、节拍与调式（具体算法实现可先用纯 Rust DSP 方案，后续按精度再迭代）。  
  预测/训练阶段仅做距离/相关计算。  
- 对 `bpm_diff_min/year_diff_min/duration_diff_min/key_dist_min` 等最小差值特征，可把精选侧字段整理为数组/集合，线性扫描取最小值。  

### 3. 缓存与增量
- 嵌入与特征缓存：**统一落到 SQLite**（建议独立文件 `features.db`，未来可并入全局数据库）。表存 `songId, fileHash, modelVersion, vector(256f32 blob), rms_mean` 等，仅在文件内容变化时重算。  
- 统计缓存：不预存 `openl3_sim_*`，因为它依赖“当前精选集合”；每次预测按最新 `P` 现算，避免缓存失效。  
- 版本化：OpenL3 与 GBDT 模型版本写入 **数据库根目录** `models/selection/manifest.json`，上层在检测到版本变化时触发重提嵌入/重训。  

### 4. SQLite 结构设计（可与未来指纹库合并）
- 文件位置：**放在数据库根目录**（与 `songFingerprint` 同级），文件名暂定 `features.db`；保证不同库之间特征完全隔离，且不与现有 `frkbdb` 格式耦合，后续重构时再评估是否合并。  
- 基础表建议：  
  - `song_features`：`songId TEXT PRIMARY KEY, fileHash TEXT, modelVersion TEXT, openl3_vector BLOB, rmsMean REAL, hpcp BLOB, bpm REAL, key TEXT, durationSec REAL, bitrateKbps REAL, updatedAt TEXT`。  
  - `schema_meta`：`key TEXT PRIMARY KEY, value TEXT`（记录 schemaVersion、模型版本等）。  
- 向量存储：`openl3_vector/hpcp` 用 **f32 小端序 BLOB**（无损），必要时可再加 `zstd` 无损压缩列。  
- 索引：对 `fileHash`、`modelVersion`、`updatedAt` 建索引，保证增量扫描与版本迁移效率。  
- 迁移策略：`schema_meta.schemaVersion` 单调递增；升级时做原子迁移（新表→拷贝→切换），与未来把 `songFingerprint` 迁到 SQLite 时保持同一套版本化/备份约定。

## 训练/推理触发与接口（基线）
- 训练触发（建议）：上层在 `positiveIds ≥ 20` 且 `negativeIds ≥ 4 * positiveIds` 时进行首次训练；不足则跳过训练并仅用相似度排序。之后当 `positiveIds/negativeIds` 发生变化时按需重新训练（准确率优先）。后端不自行判断业务事件，只响应训练调用。  
- N‑API 接口草案：  
  - `extractOpenL3Embedding(filePath) -> Float32Array(256)`（内部整曲滑窗聚合）。  
  - `trainSelectionGbdt(positiveIds, negativeIds, featureStorePath) -> { status, modelPath?, metrics? }`（`status` 可能为 `trained | insufficient_samples | failed`）。  
  - `predictSelectionCandidates(positiveIds, candidateIds, featureStorePath, modelPath?, topK?) -> [{ id, score }]`（`topK` 默认 100；`modelPath` 缺失时回退到 OpenL3 相似度排序）。  
- 模型持久化：GBDT 模型二进制落到 **数据库根目录** `models/selection/selection_gbdt_v1.bin`，与 manifest 一起管理与迁移。  

## 下一步建议
1) 以 OpenL3 small 为基线实现完整离线管线（提嵌入→召回→重排→展示），不规划模式切换。  
2) 选定推理栈（Rust + ort），完成 OpenL3 的 ONNX 转换与最小推理原型（单曲推理 + 全量相似度统计）。  
3) 设计特征缓存与索引存储格式（含版本与校验），实现增量更新。  
4) 用历史精选/非精选样本快速训练或调试一版加权规则/GBDT 重排，评估 Precision@K/NDCG。  
5) 前端规划：候选列表展示、进度/取消与错误提示。
