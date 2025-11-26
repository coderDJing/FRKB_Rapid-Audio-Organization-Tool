# MusicBrainz 元数据补全方案

## 背景与动机
- backlog.md 中的“元数据补全”需求已经明确，希望借助 MusicBrainz 这样的公共数据库来减少人工填写工作量。
- 现有能力：主进程通过 `music-metadata` 读取标签（`src/main/services/metadataEditor.ts`），前端在 `editMetadataDialog.vue` 中提供逐字段的编辑体验（自 `src/renderer/src/components/editMetadataDialog.vue:205` 起绑定表单）。目前尚无外部数据源、也没有自动化补全链路。

## 目标
1. 提供一个稳定的“从 MusicBrainz 拉取候选并快速回填”能力，优先覆盖单曲手动补全场景。
2. 在保持可控的 API 请求速率前提下，允许用户批量为多首歌曲填充标签。
3. 最终补全结果能覆盖标题、艺人、专辑、发行年份、曲序、封面、ISRC 等字段，且允许用户选择性覆盖。

## 非目标
- 暂不实现自动重命名文件或根据标签重建目录（已有 backlog 条目会在后续迭代）。
- 暂不接入声纹/AcoustID，第一阶段仅基于已有标签 + 文件名 + 时长进行匹配。
- 不修改云指纹同步协议，MusicBrainz 相关数据只作用于本地元数据。

## 用户体验设计
### 1. 单曲手动补全（第一阶段）
1. 在 `editMetadataDialog` 顶部添加“MusicBrainz 补全”入口，按钮点击后展开侧栏。
2. 默认使用当前曲目的 `title/artist/album/duration` 构建查询；用户可编辑查询条件后重新搜索。
3. 搜索面板展示候选列表：每条记录展示曲名、主要艺人、所属专辑/发行、年份、曲序、精确程度（与本曲时长差值、匹配字段数量等）。
4. 选中候选后进入“字段映射”界面，可勾选要覆盖的字段，实时预览更新对比。
5. 支持勾选“同时更新封面”，触发 Cover Art Archive 下载。
6. 用户确认后回到表单，字段被填充，但仍可继续手动修改再保存。

### 2. 批量补全（第二阶段）
1. 在曲目列表右键菜单（`useSongItemContextMenu.ts`）新增“MusicBrainz 批量补全”项，仅在多选时可见。
2. 弹出批量对话框：左侧为待处理队列（显示匹配状态），右侧为当前曲目候选。
3. 允许用户为每首歌曲挑选结果或标记为“跳过”；支持自动回填策略（如“若置信度>=阈值则自动套用”，手动复核可回滚）。
4. 批量保存时，依次调用元数据更新 IPC，必要时自动合并写入任务并提示失败条目。

### 3. 未来增强（第三阶段）
- 支持“根据 MusicBrainz 标签批量重命名文件/移动目录”以及“基于 release 结构批量补齐整张专辑”。
- 引入 AcoustID + Chromaprint 进行无标签匹配，但需评估依赖（`fpcalc`）和性能。

## 技术方案
### 1. API 选择与调用流程
1. **Recording 搜索**：`GET https://musicbrainz.org/ws/2/recording?query=<query>&fmt=json&limit=5&offset=0&inc=releases+isrcs+artists`。`query` 由字段组合而成：  
   `recording:"{title}" AND artist:"{artist}" AND release:"{album}" AND dur:[{duration-2s} TO {duration+2s}]`，缺失字段自动忽略。
2. **Release 详情**：选择候选后，再请求 `GET https://musicbrainz.org/ws/2/release/<MBID>?inc=recordings+artists+isrcs+labels+genres&fmt=json`，补足专辑级信息及曲序。
3. **Cover Art**：优先命中 Cover Art Archive：`https://coverartarchive.org/release/<MBID>/front-500`。不存在则回退到 recording 的 `relations`（若携带 URL）。
4. **速率限制**：MusicBrainz 要求匿名请求平均 1 rps。实现一个基于 `p-limit` 或自研队列的“令牌桶”，入口在主进程 service 内统一控制。
5. **User-Agent 规范**：`FRKB/<version> ( https://coderDJing.github.io/FRKB_Rapid-Audio-Organization-Tool/ )`。必要时在设置页暴露可配置的 contact email。

### 2. 前后端职责划分
| 层 | 职责 |
| --- | --- |
| Renderer (`editMetadataDialog.vue` 新增 panel) | 采集查询条件、显示候选、选择要覆盖的字段、触发 IPC 并接收结果 |
| Main (`src/main/services/musicBrainz.ts` 新建) | 负责 HTTP 请求、缓存、评分算法、字段映射（MB 数据 → `ITrackMetadataDetail`），并返回结构化候选 |
| 共享类型 (`src/types/globals.d.ts`) | 新增 `IMusicBrainzMatch`, `IMusicBrainzSearchPayload`, `IMusicBrainzApplyResult` 等接口 |

### 3. 字段映射
| MusicBrainz 字段 | FRKB 字段 | 说明 |
| --- | --- | --- |
| `recording.title` | `title` | 直接覆盖 |
| `artist-credit[0].name` | `artist` | 若多名艺人，使用 MB 返回的 join phrase 结果 |
| `release.title` | `album` | 取用户选择的 release |
| `release["artist-credit"]` | `albumArtist` | 无则回退到 recording 主艺人 |
| `release["date"]`/`release-group["first-release-date"]` | `year` | 取 YYYY 部分 |
| `medium.track[position]` + `medium.track[count]` | `trackNo`/`trackTotal` | 若 release 不含总数，仅写当前 trackNo |
| `release.media[position]` + `release.media[count]` | `discNo`/`discTotal` | 同上 |
| `recording.isrcs[0]` | `isrc` | 只保留首个 |
| `release["label-info"][0].label.name` | `label` | 多个 label 仅保留第一个 |
| `recording["genre-list"]` | `genre` | 以逗号拼接或取首个 |

### 4. 匹配评分
- **字段命中率**：标题/艺人/专辑各占 30%，存在完全匹配加分（不区分大小写）。
- **时长偏差**：与本地时长差绝对值 ≤1.5s 记满分，>6s 直接判为“低置信度”。
- **ISRC/MBID 缓存命中**：如果曾为同一路径保存过 `musicBrainzRecordingId`，再次打开直接定向查询。
- 主进程返回 `score`（0-100）、`matchedFields`（string[]）、`durationDiffSeconds` 供前端展示。

### 5. 缓存策略
- 在 `app.getPath('userData')/cache/musicbrainz/` 下维护两个 JSON 缓存：
  1. **搜索缓存**（键：标准化查询字符串，值：recording ID 列表，24h 过期）。
  2. **详情缓存**（键：MBID，值：release/recording 详情，7d 过期）。
- 内存中也保留 LRU（例如 100 条），减少频繁磁盘 IO。
- 缓存元数据需写入 `etag`/`lastUpdated` 以便后续扩展。

### 6. IPC 设计
1. `ipcMain.handle('musicbrainz:search', async (_e, payload: IMusicBrainzSearchPayload) => IMusicBrainzMatch[])`
   - Payload：`{ title?, artist?, album?, durationSeconds?, filePath }`
   - 返回：候选数组；如达到速率上限，返回错误码 `rate_limited`，Renderer 端展示等待提示。
2. `ipcMain.handle('musicbrainz:releaseDetail', async (_e, recordingId: string, releaseId?: string) => IMusicBrainzMatchDetail)`
3. `ipcMain.handle('musicbrainz:cover', async (_e, releaseId: string, opts) => { dataUrl } )`（可复用现有 `getSongCoverThumb` 的缓存逻辑）。

### 7. 安全与错误处理
- 捕获 HTTP 429/503，并在 Renderer 显示“请稍后再试”。
- 对 `coverartarchive` 404 时保底给出占位图，并允许用户保持原封面。
- 所有网络请求在 8 秒超时后自动中断。

## 里程碑拆解
1. **M1 - 单曲手动补全**
   - 新建主进程 service + IPC。
   - `editMetadataDialog` 加搜索 panel、候选列表与字段映射 UI。
   - 支持封面抓取、字段预览、用户确认回填。
2. **M2 - 批量操作**
   - `useSongItemContextMenu.ts` 新增入口及批量对话框。
   - 批量匹配流水线（任务队列、自动策略、失败重试）。
3. **M3 - 高级功能**
   - 存储 MBID、支持自动重命名与目录整理。
   - 引入 AcoustID / 指纹匹配。

## 未决问题
- 是否需要在设置页暴露 MusicBrainz 请求速率/代理等选项？
- 批量模式下，若用户一次处理上千首歌曲，如何提示 MusicBrainz 限速导致的排队时间？可能需要与用户沟通可选的本地镜像或 API key（MusicBrainz 支持注册账户提高限额）。
- 后续若加入 AcoustID，需在打包中引入 `chromaprint` 或复用现有 Rust 包；需评估体积与许可证兼容性。

## 下一步行动
1. 评审本文档后，确认 M1 范围与 UI 交互稿。
2. 依据 M1 范围创建具体任务（service/IPC/UI/国际化/测试）。
3. 在 `README` 或官网补充分页，说明需要网络以使用 MusicBrainz 功能，并尊重其 ToS。

