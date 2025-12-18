# 本地精选预测方案（后端定稿 + 前端交互草案）

> 说明：本文后端方案为定稿；前端交互/触发规则为草案，后续可按体验迭代。

## 当前实现状态（持续更新）
- ✅ `features.db`：SQLite 结构与读写已落地（`schemaVersion=2`；`song_features` / `song_prediction_cache` / `schema_meta`）。
- ✅ GBDT：训练/推理与模型落盘已落地（`models/selection/selection_gbdt_v1.bin` + `models/selection/manifest.json`）。
- ✅ 标签落盘：库目录 `selection_labels.db`（SQLite），并维护 `sampleChangeCount`；`neutral` 为默认态不落行。
- ✅ 主进程 IPC：已接入 `selection:*` 处理器（训练/预测/标签/特征 upsert）。
- ✅ 基础特征提取：已提供 `selection:features:extractAndUpsert`（离线提取并写入 `chromaprintFingerprint/rmsMean/hpcp/bpm/key/durationSec/bitrateKbps`）。
- ✅ filePaths 直连：已提供 `selection:labels:setForFilePaths` / `selection:predictForFilePaths`（内部自动计算 `sha256_Hash`）。
- ✅ songId 映射索引：库目录 `selection_path_index.db`（SQLite），持久化缓存 `filePath+size+mtime → songId(PCM SHA256)`；支持移动迁移与 GC。
- ✅ 自动重训：在 `selection:labels:set` 后按 `sampleChangeCount` + 8s debounce 自动触发训练（成功后清零计数，并广播 `selection:autoTrainStatus` 事件）。
- ✅ 自动补齐特征：打开列表完成加载后会后台补齐缺失音频特征（主进程并发=2，**不依赖预测列是否可见**）；未提取特征的曲目**不展示预测分**（避免无意义分数）。
- ✅ 元数据编辑：`audio:metadata:update` 保存后，若可编辑元数据发生真实变化，会按 `songId=sha256_Hash` 清理该曲目的预测缓存；若该曲目为样本（`liked/disliked`）则计入 `sampleChangeCount` 并触发自动重训调度。
- ✅ 渲染层：右键菜单已支持“喜欢/不喜欢/清除喜好”，并新增列 `columns.selectionScore`（打开列表后后台刷新预测分数）。
- ✅ 批量打标：歌单/库右键菜单已支持“喜欢/不喜欢全部歌曲”（分批 + 控并发，且 UI 立即更新喜好标记）。
- ✅ 清除训练数据：设置页已提供“清除模型训练数据”，会清空所有“喜欢/不喜欢”标记并重置预测/模型状态。
- ✅ OpenL3：已接入 ONNX 推理并写入 `song_features.openl3_vector`（需放置模型文件；缺失则降级为 `runtime_unavailable`）。
- ✅ Chromaprint：已接入 `fpcalc` 指纹落盘（`song_features.chromaprintFingerprint`），并纳入 GBDT 特征（`chromaprint_sim_max/has_chromaprint`）。
- ✅ OpenL3 ONNX 产物：支持本地导出；Release CI 会自动导出并注入打包产物（见下文）。

## OpenL3 ONNX 获取/导出

### 1) 本地导出（推荐）

前置：Python 3.11（`openl3==0.4.2` 在 Python 3.12+ 会因 `imp` 被移除而安装失败）。建议使用独立 venv（例如 `.venv-openl3`，仓库已在 `.gitignore` 中忽略 `.venv*/`）。

PowerShell 示例：

```powershell
# 1) 创建 venv（如系统已安装 Python Launcher）
py -3.11 -m venv ".venv-openl3"

# 2) 安装依赖（固定版本，避免 NumPy 2.x 与 tf2onnx 旧接口不兼容）
& ".venv-openl3/Scripts/python.exe" -m pip install --upgrade pip setuptools wheel
& ".venv-openl3/Scripts/python.exe" -m pip install --upgrade --force-reinstall `
  "numpy==1.26.4" "protobuf==3.20.3" "tensorflow==2.15.1" "kapre==0.3.6" "openl3==0.4.2" "tf2onnx==1.16.1"

# 3) 导出 ONNX，并把 sha256 写回 manifest
& ".venv-openl3/Scripts/python.exe" "scripts/export-openl3-onnx.py" `
  --manifest "resources/ai/openl3/manifest.json" --write-sha256
```

产物：
- 生成 `resources/ai/openl3/*.onnx`
- 更新 `resources/ai/openl3/manifest.json`（写入 `sha256`）

当前仓库约定（便于核对是否导出成功）：
- `resources/ai/openl3/manifest.json`：
  - `modelFile=openl3_small_48k_music_mel256_512d_fp32.onnx`
  - `sha256=8bf0b490320334c78c5fec218edea9318797bc7d22045e73556433e7da74dd46`

注意：`resources/ai/openl3/*.onnx` 默认被 `.gitignore` 排除（避免误提交大文件）。若你发现 `.venv-openl3` “未被忽略”，通常是因为该目录已被 Git 追踪，需要先 `git rm -r --cached` 解除追踪（不会删除本地文件）。

### 2) GitHub Actions（Release）自动导出

Release 工作流 `/.github/workflows/release.yml` 已包含 `prepare_openl3_onnx` job：使用 Python 3.11 执行 `scripts/export-openl3-onnx.py`，并把 `resources/ai/openl3/*.onnx` + `manifest.json` 作为 artifact 传递到各平台打包 job 中，确保安装包内始终携带可用模型文件。

## 批量打标（歌单/库）

目标：对大量曲目快速批量设置 `liked/disliked`，**不阻塞 UI**，并且列表“喜好标记”列会**立即可见更新**；特征提取在后台队列静默执行。

### UI 入口
- **歌单列表（含回收站歌单）**：右键歌单 → `喜欢歌单内全部歌曲` / `不喜欢歌单内全部歌曲`
- **库图标（左侧）**：右键 `FilterLibrary / CuratedLibrary / RecycleBin` → `喜欢库内全部歌曲` / `不喜欢库内全部歌曲`
  - `ExternalPlaylist` 图标**不提供**该功能（外部歌曲不应被“全库打标”影响）。

### 执行流程（关键点）
1) 扫描目标范围的文件列表：复用 IPC `scanSongList`，拿到 `filePaths` 后去重。
2) 二次确认：提示将要影响的曲目数量。
3) **乐观 UI 更新**：通过 `emitter.emit('selectionLabelsChanged', { filePaths, label })` 让当前打开列表先显示更新。
4) 后台分批落盘：按 `batchSize=200`、`concurrency=2` 分批调用 `selection:labels:setForFilePaths`；主进程侧仍会做任务队列/并发限制，避免拖垮前台。

### 相关实现位置（便于下次继续开发）
- 歌单右键菜单：`src/renderer/src/components/libraryItem/useLibraryContextMenu.ts`
- 库图标右键菜单：`src/renderer/src/pages/modules/librarySelectArea.vue`
- 批处理工具：`src/renderer/src/utils/selectionActions.ts`（`setSelectionLabelForFilePathsBatched`）
- UI 列表接收并刷新：`src/renderer/src/pages/modules/songsArea/composables/useSongsAreaEvents.ts`（监听 `selectionLabelsChanged`）
- i18n：`src/renderer/src/i18n/locales/zh-CN.json` / `src/renderer/src/i18n/locales/en-US.json`（`selection.likeAllIn*`、`selection.bulkConfirm*` 等 key）

## 清除模型训练数据（设置页）

目标：一键恢复“未训练”状态，方便重新标注与验证。

- 入口：设置页 → `清除模型训练数据`（与“清除曲目指纹库”同样式/交互）
- 行为：清空本库所有 `liked/disliked`（置为 `neutral`），并重置预测/模型状态（如预测缓存、模型文件等）；完成后会广播 `selection:autoTrainStatus` 的 `reset` 状态，让前端清空预测分/标记。
- 相关实现：
  - UI：`src/renderer/src/components/settingDialog.vue`
  - 主进程：`src/main/ipc/selectionPredictionHandlers.ts`（IPC：`selection:training:reset`）

## 调试与日志（实战信息）
- 主进程日志前缀统一为 `[selection]`，且已改为中文，便于用户侧排查耗时卡点（解码/指纹/OpenL3/写库等）。
- 渲染层调试日志默认仅在开发环境输出；如需在 Release 包里看更详细日志，可在 DevTools Console 执行：
  - `localStorage.setItem('FRKB_DEBUG_SELECTION', '1')` 后刷新/重启应用

## 下一轮待办（重要）
- 音频片段策略：当前 `src/main/services/selectionFeatureExtractor.ts` 使用 `INTRO_SKIP_SECONDS=30`（跳过前 30 秒后再算 RMS/HPCP/BPM）。对前奏较长的常见曲风（如 EDM）不理想，需要改为更“信息量密集”的片段策略（例如中段采样/多段采样/按能量段选窗），并与 OpenL3 的 `maxAnalyzeSeconds/maxWindows` 一起联动调参。
- 批量打标体验：目前只有“确认 + 完成提示”，缺少进度/取消/后台任务列表；可考虑复用现有任务系统或新增轻量 job 面板。

## 背景与目标
- 需求：基于用户显式标注的“喜欢/不喜欢”（可兼容历史“已加入精选”的曲目作为喜欢）预测筛选库里最可能被用户喜欢/加入精选的候选；全程离线、用户零配置。
- 约束：仅使用歌曲自身信息（音频内容 + 元数据），不引入播放/跳过等行为特征；纯本地推理，不依赖服务器。
- 目标：在桌面端提供高精度的候选排序，优先准确率，其次兼顾包体和延迟。

## 库目录与数据落盘约定
- FRKB 库目录：用户选择 `FRKB.database.frkbdb` 所在目录（以该目录为库的根目录）。
- 可携带性：除用户界面配置外，与该库相关的所有数据均落在库目录中（如 `FRKB.database.frkbdb`、`features.db`、`models/selection/*` 等）；库目录移动路径或迁移到其他电脑后，重新选择该 `FRKB.database.frkbdb` 即可继续使用。

## songId 映射缓存（filePath → songId）

### 背景
- `songId` 统一使用 PCM 内容 SHA256（`sha256_Hash`）作为稳定主键，优点是**不受元数据影响**、跨路径/重命名一致；缺点是首次计算需要解码音频，成本较高。
- 为避免“每次重启/换歌单都重新解码算哈希”，新增持久化索引。

### 落盘与命中规则
- 落盘：库目录 `selection_path_index.db`（SQLite）。
- Key：`pathKey`（对 `filePath` 做规范化后的 key），并同时记录 `filePath`、`size`、`mtimeMs`。
- 命中：仅当 `pathKey` 相同且 `size/mtimeMs` 与当前文件一致时，直接复用缓存的 `songId/fileHash`；否则重新计算并覆盖写入。

### 迁移与回收（GC）
- 迁移：应用内“移动曲目到其他歌单”（`moveSongsToDir`）会在移动成功后将旧路径的缓存迁移到新路径，并删除旧路径条目，避免移动后再次解码。
- 回收：索引带 TTL 与容量上限回收（带防抖，默认 24h 最多执行一次），避免索引无限增长；回收只影响性能，不影响正确性（缺失时会重新计算并写回）。

## 数据与特征前提
- 正样本：用户标注为“喜欢”的曲目（可包含“已加入精选”的历史曲目，含已删除文件的快照），需保留元数据快照 + 音频指纹/嵌入。
- 负样本：用户标注为“不喜欢”的曲目（仅显式 `disliked`）；不从 `neutral` 自动采样补齐，负样本不足则视为不可训练/不可预测。
- 稳定 ID：上层提供 `songId`，**统一使用现有的 PCM 内容 SHA256（`sha256_Hash`）** 作为跨路径/重编码一致的主键，用于 features 表去重与历史对齐。
- 音频特征：首选嵌入（OpenL3 small），**第一版必做** Chromaprint 指纹 + HPCP/Chroma + BPM/Key（从音频内容提取），辅以响度、时长等统计特征。
- 元数据特征：艺人/流派/专辑/年份、BPM/调式/时长、比特率；标题/标签可做文本相似度（轻量 TF-IDF 或小型文本嵌入）。

## 模型选型（已拍板）
- **统一使用：OpenL3 small（48 kHz，输出 512 维，fp32，`content_type=music`，`input_repr=mel256`）**。音乐相似度表现稳定，模型体积/推理成本和跨平台 ONNX 化风险都较低，满足纯本地开箱即用与准确率目标。
- 若算力/包体允许，可探索更大音频 Transformer（PaSST/Audio-MAE/MERT）的 ONNX 版，但部署复杂度更高。

## 部署形态（开箱即用）
- 推荐链路：开发阶段将模型转 ONNX → Rust 侧用 ONNX 推理引擎推理（优先 ORT；当前实现使用 `tract-onnx` 纯 Rust 推理，后续可切换 ORT）→ 暴露 N-API 给 Electron；随应用打包推理运行时，首次运行零下载。
- 预处理：音频解码/重采样、梅尔谱/增广等前处理尽量放在 Rust 侧，减少 JS 往返与 CPU 开销。
- 应用资源：OpenL3 ONNX 模型随安装包（建议 `resources/ai/openl3/*`），启动时校验哈希后解压到 `userData/ai/openl3/*`（与库目录无关，移动库不受影响；若后续切换 ORT，再补充 ORT 运行时分发）。
- 库数据：训练产物、特征与缓存均落在库目录（含 `models/selection/*`，移动库会保留训练结果；见“库目录与数据落盘约定”）。

### OpenL3 ONNX 怎么获得（开发期一次性）
> 结论：OpenL3 官方提供的是 `.h5` 权重（安装/下载时会从 `marl/openl3` 的 `models` 分支拉取），需要用 Python + TensorFlow 转成 ONNX；本仓库不提交 `.onnx`（体积大），你本地生成后放到 `resources/ai/openl3/` 即可。
>
> 备注：Release CI 会自动导出并打包（见 `.github/workflows/release.yml` 的 `prepare_openl3_onnx`）。

1) 准备 Python 环境（任意机器均可，建议 Python 3.10/3.11）  
   - 重要：**不要用 Python 3.12+/3.13**（`openl3==0.4.2` 的打包脚本依赖 `imp`，在 3.12+ 已移除，会报 `ModuleNotFoundError: No module named 'imp'`；同时 TensorFlow 也通常不会为 3.13 提供可用轮子）。
   - 先确认 Python 版本：`python --version`（应为 3.10/3.11）；若系统默认是 3.13，请用 Python Launcher 指定 3.11 创建 venv（见下方示例）。
   - Windows 小贴士：若 `py` 不在 PATH，可用 `& "$env:LOCALAPPDATA/Programs/Python/Launcher/py.exe"` 直接调用 Python Launcher（例如 `& "$env:LOCALAPPDATA/Programs/Python/Launcher/py.exe" -0p` 查看已安装版本）。
   - 安装依赖（建议固定版本 + 强制重装，避免残留冲突；同时避免 `kapre>=0.4.0` 把 `tensorflow/numpy` 拉到新版本导致 `tf2onnx` 运行报错）：`python -m pip install --upgrade --force-reinstall "numpy==1.26.4" "protobuf==3.20.3" "tensorflow==2.15.1" "kapre==0.3.6" "openl3==0.4.2" "tf2onnx==1.16.1"`
   - 建议始终用 venv 的 Python 执行 pip：`python -m pip ...`（或直接用 `& ".venv-openl3/Scripts/python.exe" -m pip ...`），避免新开终端后把依赖装到系统 Python。
   - 若报 `ModuleNotFoundError: No module named 'tensorflow.keras'`（Windows 偶发，TensorFlow 安装不完整），在 venv 内执行：`pip install --force-reinstall --no-deps --no-cache-dir "tensorflow-intel==2.15.1"`。
   - venv 目录（如 `.venv-openl3`）无需提交，仓库已在 `.gitignore` 忽略 `.venv*/`。
   - 说明：`openl3` 在安装时会自动下载并解压官方权重（例如 `openl3_audio_mel256_music-v0_4_0.h5.gz`）。

2) 导出 ONNX（导出“librosa 前端”版本：输入为 log‑mel，避免把 kapre 前处理打进 ONNX）  
   - 参考脚本（示例输出名以 `resources/ai/openl3/manifest.json` 为准）：
      - `frontend='librosa'`、`input_repr='mel256'`、`content_type='music'`、`embedding_size=512`（small）
      - 输入 shape：`[None, 256, 199, 1]`（float32，`n_mels=256`，`1s@48kHz`、`hop=242` → `199` 帧）

   ```powershell
   # Windows PowerShell（确保使用 Python 3.11）
   # 若可用 Python Launcher：
   py -3.11 -m venv ".venv-openl3"
   # 若 py 不在 PATH，可直接用 Launcher 路径：
   # & "$env:LOCALAPPDATA/Programs/Python/Launcher/py.exe" -3.11 -m venv ".venv-openl3"

   & ".venv-openl3/Scripts/python.exe" -m pip install --upgrade pip setuptools wheel
   & ".venv-openl3/Scripts/python.exe" -m pip install --upgrade --force-reinstall `
     "numpy==1.26.4" "protobuf==3.20.3" "tensorflow==2.15.1" "kapre==0.3.6" "openl3==0.4.2" "tf2onnx==1.16.1"
   & ".venv-openl3/Scripts/python.exe" -c "import tensorflow as tf; import tensorflow.keras as k; print(tf.__version__)"
   & ".venv-openl3/Scripts/python.exe" "scripts/export-openl3-onnx.py" --manifest "resources/ai/openl3/manifest.json" --write-sha256
   ```

   ```bash
   # macOS/Linux（建议使用 Python 3.11）
   python3.11 -m venv ".venv-openl3"
   source ".venv-openl3/bin/activate"
   python -m pip install --upgrade pip setuptools wheel
   python -m pip install --upgrade --force-reinstall \
     "numpy==1.26.4" "protobuf==3.20.3" "tensorflow==2.15.1" "kapre==0.3.6" "openl3==0.4.2" "tf2onnx==1.16.1"
   python "scripts/export-openl3-onnx.py" --manifest "resources/ai/openl3/manifest.json" --write-sha256
   ```

3) 放置与校验  
    - 把导出的 `.onnx` 放到 `resources/ai/openl3/`，文件名与 `resources/ai/openl3/manifest.json` 的 `modelFile` 一致。
    - 建议在导出时加 `--write-sha256` 自动写回 `manifest.json`；或手动计算（Windows 可用 `Get-FileHash -Algorithm SHA256 "<onnx>"`）。
    - 运行时逻辑：启动后会从安装包内 `resources/ai/openl3/*` 复制到 `userData/ai/openl3/*` 并设置 `FRKB_OPENL3_MODEL_PATH`；若缺失则 OpenL3 特征自动降级跳过，不影响 Chromaprint/GBDT 主流程。
    - 若运行时日志出现 `openl3 推理失败: Clashing resolution for expression ...`：通常是 **本地 `rust_package` N-API 二进制未更新**（旧版会在 batch 变化时触发 tract 符号冲突）。请在仓库内重新构建：`cd rust_package && corepack yarn run build`（或 `npx --yes @napi-rs/cli@2.18.4 build --platform --release`）。

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
   - 若模型未训练或样本不足：不输出预测分数/排序；由上层提示用户继续标注“喜欢/不喜欢”后再训练。  
   - 训练完成后输出最终排序，返回 Top‑K 候选。
4) **缓存与更新**  
   - 嵌入/索引持久化，检测文件 mtime/哈希变化后增量更新。  
   - 模型/索引版本号记录，便于升级时重建或迁移。

## 性能与体验
- 预处理/推理线程池在 Rust 侧控制，避免阻塞主进程；长任务要有可取消/进度回报。
- 曲库 < 数万：直接矩阵相似度即可；更大规模且查询变慢时再考虑 HNSW 向下优化。  
- 首次批量提取可分批执行并落盘中间结果，防止崩溃丢进度。

## 许可证与合规
- OpenL3 为 MIT 兼容，可随包分发；需确认转出的 ONNX/二进制依赖的许可证。  
- 不使用外部服务，无额外隐私风险；音频仅本地处理。

## 后端结论与风险
- **策略已定：暂不设包体/首次索引时间上限，以最大准确率为基线实现**；若实测包体或首次索引时间不可接受，再逐步向下探（量化、截断时长、降低窗口数等）。  
- **已定：第一版必做 Chromaprint/HPCP/BPM/Key**，并在缺失时依靠 `has_bpm/has_key/has_hpcp` 等标记让 GBDT 自行学习忽略。  
- **已定：训练门槛**：当 `positiveIds < 20` 或 `negativeIds < 4 * positiveIds`（`negativeIds` 仅来自用户显式 `disliked`）时不训练 GBDT；预测不做任何回退排序，仅返回 `insufficient_samples` 等状态供上层展示提示。  
- **已定：默认候选与输出**：后端不做 Top‑N 预筛；`predictSelectionCandidates` 默认返回 Top‑K=100（上层可覆盖）。  
- **已定：GBDT 实现与序列化**：使用纯 Rust `gbdt` crate；模型用 `bincode` 序列化保存，加载失败或版本不匹配时由上层触发重训。  
- **风险/假设**：元数据侧（BPM/Key/流派/年份等）存在缺失或噪声时，GBDT 依赖 `has_*` 标记自动降权；若缺失比例极高，元数据软特征贡献会变小，效果主要由 OpenL3/指纹特征决定。

## 准确率优先的初始配置
- 模型：OpenL3 small **fp32 全精度**，输出 **512 维**（48 kHz，`mel256/music`）。  
- 取样策略：**整曲滑窗提嵌入**。窗口长度按 OpenL3 原生约 1s；步长 `hop=0.1s`（≈90% 重叠）；首尾采用 center+reflect padding；整曲向量用能量加权平均（RMS 加权，低能量窗跳过）。  
- 运行时：当前实现使用 `tract-onnx`（纯 Rust）；后续若要更高兼容/性能可切换 ORT（`ort`）。  

## GBDT 特征与训练（基线）
### 0. 当前已实现（GBDT v1）
- `feature_names`：`hpcp_corr_max`、`bpm_diff_min`、`key_dist_min`、`duration_diff_min_log1p`、`bitrate_kbps`、`rms_mean`、`has_hpcp`、`has_bpm`、`has_key`、`has_duration`、`has_bitrate`、`has_rms`、`chromaprint_sim_max`、`has_chromaprint`。
- 说明：OpenL3 相似度统计已落地（`openl3_sim_max/openl3_sim_top5_mean/openl3_sim_top20_mean/openl3_sim_centroid`）；Chromaprint 相似度第一版使用 64-bit SimHash 的汉明相似度做轻量近似。

### 1. 特征集合（仅歌曲自身信息）
**OpenL3 相似度统计（核心）**
- `openl3_sim_max`：候选与历史精选集合的最大余弦相似度。  
- `openl3_sim_top5_mean / openl3_sim_top20_mean`：Top‑5/Top‑20 相似度均值，提升稳健性。  
- `openl3_sim_centroid`：候选与“精选全局质心向量”的余弦相似度。  

**指纹/调性/节奏补充**
- `chromaprint_sim_max`：Chromaprint 指纹相似度统计（第一版使用 64-bit SimHash 的汉明相似度做轻量近似）。  
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
  - 已定：负样本仅使用用户显式标注为 `disliked` 的曲目；不从 `neutral` 自动采样补齐；建议保持正:负≈1:4，比例不足则返回 `insufficient_samples` 不训练。  
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
- 版本化：OpenL3 与 GBDT 模型版本写入 **库目录** `models/selection/manifest.json`；`modelRevision` 为库内自增整型（初始为 0），每次 `trainSelectionGbdt` 成功（`status=trained`）后 `+1`，用于预测缓存失效与展示更新。  

### 4. SQLite 结构设计（可与未来指纹库合并）
- 文件位置：**放在库目录**（与 `FRKB.database.frkbdb` 同级），文件名暂定 `features.db`；保证不同库之间特征完全隔离，且不与现有 `frkbdb` 格式耦合，后续重构时再评估是否合并。  
- 基础表建议：  
  - `song_features`：`songId TEXT PRIMARY KEY, fileHash TEXT, modelVersion TEXT, openl3_vector BLOB, chromaprintFingerprint TEXT, rmsMean REAL, hpcp BLOB, bpm REAL, key TEXT, durationSec REAL, bitrateKbps REAL, updatedAt TEXT`。  
  - `schema_meta`：`key TEXT PRIMARY KEY, value TEXT`（记录 schemaVersion、模型版本等）。  
  - `song_prediction_cache`：`songId TEXT, modelRevision INTEGER, fileHash TEXT, score REAL, updatedAt TEXT, PRIMARY KEY(songId, modelRevision, fileHash)`（预测分数缓存，仅用于加速列表展示）。  
- 向量存储：`openl3_vector/hpcp` 用 **f32 小端序 BLOB**（无损），必要时可再加 `zstd` 无损压缩列。  
- 索引：对 `fileHash`、`modelVersion`、`updatedAt` 建索引，保证增量扫描与版本迁移效率。  
- 迁移策略：`schema_meta.schemaVersion` 单调递增；升级时做原子迁移（新表→拷贝→切换），与未来把 `songFingerprint` 迁到 SQLite 时保持同一套版本化/备份约定。

## 训练/推理触发与接口（基线）
- 训练触发（建议）：上层在 `positiveIds ≥ 20` 且 `negativeIds ≥ 4 * positiveIds`（`negativeIds` 仅为显式 `disliked`）时进行首次训练；不足则跳过训练并视为“不可预测”（不做任何回退排序/打分）。之后当 `positiveIds/negativeIds` 发生变化时按需重新训练（准确率优先）。后端不自行判断业务事件，只响应训练调用。  
- 标签更正：上层若发现样本归类有误（负样本改为正样本或反之），更新 `positiveIds/negativeIds` 后重新调用训练即可；后端不持久化历史标签，新模型会覆盖旧影响。  
- 训练形态：基线使用 **全量从零重训**（仅重训 GBDT 权重，不重算已缓存的音频特征）。当前选用的纯 Rust `gbdt` 不支持可靠的在线/增量更新；若未来必须增量训练，需要改为支持 warm‑start 的框架（如 XGBoost/LightGBM FFI）或引入在线模型作为辅助手段。  
- 推理口径（已定）：预测使用“最近一次训练时的喜欢集合快照”（由后端随模型保存）；用户后续新增/修改 `liked/disliked/neutral` 标注在触发重训前**不影响当前分数**，仅在重训成功后刷新。  
- N‑API 接口草案：  
  - `upsertSongFeatures(featureStorePath, items) -> affected`（写入/更新 `features.db.song_features`，支持部分字段更新）。  
  - `extractOpenL3Embedding(filePath, maxSeconds?, maxWindows?) -> Promise<Buffer>`（内部整曲滑窗聚合；返回 **f32 小端序 BLOB**；若未放置 `resources/ai/openl3/manifest.json` 对应的 `modelFile` 则返回 `runtime_unavailable`）。  
  - `trainSelectionGbdt(positiveIds, negativeIds, featureStorePath) -> { status, modelRevision?, modelPath?, metrics? }`（`status` 可能为 `trained | insufficient_samples | failed`；`modelRevision` 为库内自增整型，仅在 `trained` 时返回）。  
  - `predictSelectionCandidates(candidateIds, featureStorePath, modelPath?, topK?) -> { status, modelRevision?, items? }`（`status` 可能为 `ok | not_trained | insufficient_samples | failed`；仅当 `ok` 时返回 `modelRevision` 与 `items: [{ id, score }]`；不做任何回退排序）。  
  - `setSelectionLabels(labelStorePath, songIds, label) -> { total, changed, sampleChangeCount, sampleChangeDelta }`。  
  - `getSelectionLabelSnapshot(labelStorePath) -> { positiveIds, negativeIds, sampleChangeCount }`。  
  - `resetSelectionSampleChangeCount(labelStorePath) -> sampleChangeCount`。  
  - `resetSelectionLabels(labelStorePath) -> boolean`。  
- 模型持久化：GBDT 模型二进制落到 **库目录** `models/selection/selection_gbdt_v1.bin`，与 manifest 一起管理与迁移。  

## 前端交互与样本标注（草案，不实现）
- 右键菜单（曲目）：新增“喜欢该曲目 / 不喜欢该曲目 / 清除喜好标记”，支持对当前选中集批量生效；执行后统一覆盖为目标标记（清除=置为 `neutral`）。
- 右键菜单（歌单）：新增“喜欢歌单中的所有曲目 / 不喜欢歌单中的所有曲目”，建议二次确认；大批量时显示进度并支持取消。
- 右键菜单（库 icon）：新增“喜欢库中所有曲目 / 不喜欢库中所有曲目”，同样建议二次确认 + 进度/取消。
- 列表展示：新增一列“预测喜好”（仅在模型已训练时展示分数，显示为 0–100 整数）；允许按该列排序；未训练/样本不足时该列显示 `*`，鼠标悬停提示“样本不足，无法预测，请标记你的喜欢/不喜欢”。
- 预测计算策略（已定）：打开歌单/曲目列表时，若模型状态为 `ok` 则对该列表**全量** `songIds` 启动后台预测任务并边算边刷列表；按 100–300 首/批调用预测接口以控制资源；切换歌单/切库时取消旧任务；同一 `songId` 去重并优先命中 `song_prediction_cache` 后再计算缺失项（需要全量分数时，`topK` 取当前批大小即可）。
- 预测结果缓存：对已算出的分数进行持久化缓存，落在每个库自己的 `features.db` 表 `song_prediction_cache`；缓存键包含 `songId + modelRevision + fileHash`（`modelRevision` 为库内自增整型），在模型重训或音频内容变化后自动失效并重算。
- 缓存回收（GC）：  
  - 模型重训成功后：清理旧 `modelRevision` 的缓存（例如只保留最新一次训练对应的缓存）。  
  - 歌曲被移出库/文件系统删除：在库扫描/导入同步确认移除后，按 `songId` 删除对应缓存行；避免缓存无限增长。  
  - 歌曲内容变更（`fileHash` 变化）：在重算特征并写入新 `fileHash` 后，删除同 `songId` 下旧 `fileHash` 的缓存行。  
- 标签模型：每首歌维护三态 `liked / disliked / neutral`；`positiveIds/negativeIds` 由三态实时派生（Set 去重，避免冲突与重复）。
- 标签持久化：`liked/disliked/neutral` 作为业务真值写入库目录内的 `selection_labels.db`（SQLite，与 `features.db`/`FRKB.database.frkbdb` 解耦，支持随库目录迁移）。
- 删除曲目样本：曲目被移出库或文件系统删除后，其 `liked/disliked` 标签与已落库特征快照作为训练样本永久保留；不提供“清理已删除样本”入口。
- 系统设置（对当前库生效）：新增“初始化 AI 模型”按钮，执行后重置本库所有喜好标记（全部置为 `neutral`）并清空本库的预测/训练产物（如 `models/selection/*`、`song_prediction_cache`，并重置 `modelRevision`）；需二次确认并明确警告“操作不可恢复，初始化后需重新标记喜欢/不喜欢并等待重训才会显示预测分数”。
- 样本变化计数（已实现）：仅统计**真实标签变更**的曲目数量作为 `sampleChangeCount` 累加：`newTag == oldTag` 不计；`neutral→liked/disliked`、`liked↔disliked`、`liked/disliked→neutral` 均计 1。
- 元数据变更（已实现）：内部保存可编辑元数据（艺人/流派/专辑/年份等）后，若发生**真实变化**：
  - 对该 `songId` 清理 `song_prediction_cache`（因为元数据变化时 `fileHash` 可能不变，否则会返回旧缓存分数）。
  - 若该曲目为训练样本（`liked/disliked`），则将本次变更计入 `sampleChangeCount`，并复用同一套阈值与 debounce 触发重训。
- 重训触发：当 `sampleChangeCount ≥ 20` 且满足后端样本阈值（`positiveIds ≥ 20` 且 `negativeIds ≥ 4 * positiveIds`）时触发一次 `trainSelectionGbdt`；训练成功后清零计数；建议对“最后一次打标”做 5–10s debounce 避免频繁重训。

## 训练后台执行与进度（草案，不实现）
- 训练不应阻塞 UI：`trainSelectionGbdt` 在 Rust/N-API 侧启动后台 worker 线程/任务执行，JS 侧以 Promise/任务句柄异步等待。
- 训练资源占用：限制并发（例如同时只允许 1 个训练任务），必要时降低优先级/限制线程数，避免前台明显变慢。
- 进度与取消：训练过程通过事件/回调回传 `progress{phase, percent}`，前端显示进度条；完成/失败后自动消失并提示结果；提供取消 token（切库/用户取消时中断任务）。

## 单曲预测耗时预估（经验值）
- 若该曲目特征已缓存（嵌入/指纹等已落库）：一次“是否喜欢/加入精选”的打分主要是相似度统计 + GBDT 前向，通常为**毫秒级到几十毫秒**（与正样本数量、候选规模相关）。
- 若需要首次提取 OpenL3 嵌入：耗时主要由音频解码与 OpenL3 推理决定，通常与曲长近似线性；在常见桌面 CPU 上，3–5 分钟歌曲往往在 **0.5–3 秒量级**，最终以实测为准。

## 拍板结果（前后端）
- 缓存回收触发：仅做事件驱动清理（训练成功后清理旧 `modelRevision`；库扫描确认移除后按 `songId` 清理；`fileHash` 变化后清理旧 `fileHash`），不做启动时/定期清理。
- IPC 约定：  
  - `status`：`ok | not_trained | insufficient_samples | cancelled | failed`（训练接口可用 `trained` 代替 `ok`）。  
  - `failed.errorCode`：`runtime_unavailable | model_load_failed | db_error | internal_error`。  
  - `progress.phase`：`prepare | train | save`（0–100）。  
  - 取消语义：best-effort，后端收到取消请求后尽快停止并返回 `cancelled`。
- 资源策略：训练/预测/特征提取允许并行，但需限制并发与优先级：  
  - 训练：单任务执行（同一时刻最多 1 个训练任务），线程数上限 1–2。  
  - 预测：按批次执行，线程数上限 1–2，可与训练并行但整体低优先级。  
  - 特征提取：可与训练/预测并行，但总 CPU 线程上限统一由后端调度（避免占满导致前台卡顿）。  

## 下一步建议
1) 以 OpenL3 small 为基线实现完整离线管线（提嵌入→召回→重排→展示），不规划模式切换。  
2) 选定推理栈（Rust + ort），完成 OpenL3 的 ONNX 转换与最小推理原型（单曲推理 + 全量相似度统计）。  
3) 设计特征缓存与索引存储格式（含版本与校验），实现增量更新。  
4) 用历史精选/非精选样本快速训练并调试一版 GBDT 重排，评估 Precision@K/NDCG。  
5) 前端规划：候选列表展示、进度/取消与错误提示。
