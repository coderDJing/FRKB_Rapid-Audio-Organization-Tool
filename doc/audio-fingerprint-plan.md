# 音频声纹去重与质量标签方案

## 背景
- 当前 Rust 模块使用文件级哈希（SHA256）识别重复音频，无法排除元数据差异导致的重复。
- 用户希望无需额外安装依赖，即开箱即用地支持“同曲异容器”识别，并区分同格式下的不同音质版本。

## 目标
- 引入基于声纹的内容识别，跨格式识别相同歌曲。
- 同时保留音频封装格式、编码参数等信息，为前端建立“质量标签”。
- 避免用户手动安装 Chromaprint，所有依赖随应用分发。

## 方案概述
- **声纹生成**：集成 Chromaprint（通过 Rust FFI 调用 libchromaprint）。流程为：读取文件 → 使用 Symphonia 解码为降采样 PCM → 调用 Chromaprint 生成指纹 → 得到声纹 ID（hash）。
- **依赖打包**：在构建阶段预编译并随应用打包各平台的 `libchromaprint`（或静态库），运行时通过相对路径加载，保证用户零配置。
- **质量标签**：在解码或读取容器元数据时获取以下字段：
  - 容器/扩展名（`format_ext`）
  - 比特率（平均或实时，单位 kbps）
  - 采样率（Hz）、位深（bit）、声道数
  - 时长（秒）
  - 文件大小（字节），用于辅助判断
  将这些字段组合成字符串标签，例如 `MP3 · 320kbps · 44.1kHz · Stereo`。
- **结果输出**：Rust 返回结构包含 `fingerprint`、`format_ext`、质量标签（`quality_label`），以及原有的 `sha256_hash` 等字段供前端使用。
- **开发模式**：在 `mainWindow` 指纹任务入口检测 `is.dev`，详细打印每首歌曲的分析结果并跳出流程，跳过指纹库写入、去重、持久化等耗时步骤，便于调试。生产模式仍执行完整流程。

## 实施细节

### 原生库准备
- 统一在仓库目录（如 `rust_package/libs/<platform>/`）存放预编译好的 Chromaprint 库。
- `build.rs` 根据目标平台设置 `cargo:rustc-link-search` 与 `cargo:rustc-link-lib`，并在 npm 包发布流程中复制对应文件。
- 若目标平台缺少预编译库，可在 CI/CD 中用官方源码编译生成。

### Rust 集成
- 新增模块封装 Chromaprint FFI：
  - 初始化指纹上下文 `chromaprint_new`，设置选项（位深、声道、采样率）。
  - 分块向上下文推送 PCM 数据；数据来源可复用现有的 Symphonia 解码器。
  - 结束后获取 `chromaprint_get_fingerprint` 或 `chromaprint_get_raw_fingerprint`。
- 为保证性能，可在 Symphonia 解码时做一次降采样（Chromaprint 推荐 11025Hz 单声道）。
- 指纹生成结束后，释放原生资源，防止内存泄漏。

### 质量标签构建
- 拓展现有的文件探测逻辑，读取 `CodecParameters` 或容器级 metadata：
  - `codec` → 映射出格式扩展名。
  - `channel_layout`、`sample_rate`、`bits_per_sample` → 音频参数。
  - `bit_rate`（若缺失，可用 `filesize / duration` 估算）。
- 将上述字段组合成可读字符串；若信息缺失，按“未知”占位。
- 对 MP3 额外解析帧头时，标注 CBR/VBR 类型。

### 并发与性能
- 声纹计算需要解码整首歌曲，但 Chromaprint 只需中低采样率，单次 CPU 开销低于全量 PCM 哈希。
- 继续沿用 Rayon 并行策略；确保原生库调用线程安全（Chromaprint 文档允许多实例并行）。
- 对大批量处理，考虑缓存指纹结果（fingerprint → metadata）以支持增量扫描。

### 错误处理与日志
- 若加载或调用 Chromaprint 失败，返回明确错误类型，提醒检查随包库文件。
- 声纹生成异常时，可回退到文件哈希逻辑，但需在日志中标记（避免把异常数据视为正常结果）。
- 依旧遵守“预期错误不写入上传日志”的约定。

## 后续工作建议
- 编写单元测试覆盖：
  - 指纹生成基础流程（可用短音频片段做黄金结果）。
  - 质量标签构建逻辑（各种 codec/参数组合）。
- 更新 Node.js/N-API 层数据结构，确保前端能读取 `fingerprint` 与 `quality_label`。
- 根据业务需要，设计声纹匹配阈值与去重流程（例如：声纹相同 + 格式相同 → 比较质量标签）。
- 评估是否引入指纹缓存和数据库序列化方案，以提高重复扫描速度。

