# MusicBrainz 声纹匹配扩展方案（草案）

## 目标
- 在现有的 MusicBrainz 文本检索能力之上叠加“声纹识别”，让标签缺失或错误的曲目也能利用音频内容进行匹配。
- 用户体验保持一致：声纹匹配只是额外的候选来源，仍然由用户挑选并决定回填到哪些字段。

## 技术路线
### 1. 声纹生成
- **算法/工具**：采用 Chromaprint（`fpcalc` CLI）以保证与 AcoustID 官方兼容。
- **打包策略**：随应用附带 Windows/macOS 的 `fpcalc` 可执行文件，首次运行时解压到临时目录，通过子进程调用。
- **调用示例**：`fpcalc -json -length 120 <file>`，`-length` 控制最大分析时长，输出 `duration` 与 `fingerprint`。
- **任务管理**：主进程维护串行队列，显示进度并允许取消，异常（超时/不支持格式）要有明确错误。

### 2. AcoustID 查询
- **API**：`https://api.acoustid.org/v2/lookup`，参数包含 `client`（App key）、`duration`、`fingerprint`、`meta=recordings+releasegroups+releases+tracks+compress`。
- **速率限制**：匿名 key 默认 3 rps，后续若需要更高额度再评估替代方案。
- **结果解析**：遍历 `results[].recordings[]`，基于 `score` 选择候选；若 `score < 0.3` 标记为“低置信度”并提示复核。

### 3. 与 MusicBrainz 的衔接
- 获取 recording/release MBID 后复用现有 `musicbrainz:suggest` 链路，避免重复实现字段映射。
- 将声纹候选转为 `IMusicBrainzMatch`，并带上 `source: 'acoustid'` 等标记，方便前端展示。
- 请求失败或超时，返回特定错误码（如 `ACOUSTID_TIMEOUT`），UI 上提示可回退到文本搜索。

### 4. 缓存策略
- 新增 `fingerprintCache.json`：键为文件内容哈希（可复用现有 fingerprint 逻辑）+ 文件大小，值为 `{ fingerprint, duration, acoustIdResults, createdAt }`，7 天过期。
- 声纹生成结果与 AcoustID 响应均缓存，命中缓存时直接复用，减少 CPU 与网络开销。

## UI 与交互
### 1. MusicBrainz 对话框
- 在查询区域新增“声纹匹配”按钮或二级入口，点击后显示“解析音频/上传指纹”的进度条。
- 声纹候选与文本候选共用列表，卡片右上角增加来源标签，如 “AcoustID”。
- 回填流程保持不变：用户需要勾选字段后手动应用。

### 2. 批量补全
- 批量任务流水线：先生成所有声纹，再统一调用 AcoustID，最后逐条展示候选等待确认。
- 失败条目标记为“声纹生成失败/AcoustID 超时”，支持手动重试或跳过。

## 风险与待定事项
- **二进制体积**：Chromaprint 可执行文件仍会增加少量体积（虽已有 ffmpeg，可复用现有分发策略），需评估是否可选下载。
- **性能**：声纹生成需要解码音频，长音频/高比特率时 CPU 占用高；必须提供进度和取消。

## 实施顺序建议
1. 主进程封装 `fpcalc` 子进程、缓存与错误处理，打通 “fingerprint → AcoustID → MusicBrainz” 数据链路，并补齐单元/集成测试。
2. MusicBrainz 对话框接入声纹入口与进度提示，候选卡片支持来源标签。
3. 批量补全流程接入声纹匹配（可作为后续里程碑的子任务）。

文档评审通过后，可以据此拆分任务：`fpcalc` 集成、AcoustID service、前端 UI、文档与测试等。
