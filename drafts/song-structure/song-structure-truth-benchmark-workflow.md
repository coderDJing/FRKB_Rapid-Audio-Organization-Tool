# FRKB 段落真值集与 Benchmark 工作流

> 未来任何段落算法会话先读本文。本文是样本位置、人工真值、prediction、benchmark、批准流程和
> holdout 纪律的长期唯一入口；不要再靠聊天记录猜哪首歌曾经“效果不错”。

## 1. 三个固定根目录

当前机器的完整音频根：

```text
G:/FRKB_database-A/analysis/song-structure-truth/audio/
```

音频以 SHA-256 前两位分桶：

```text
<audio-root>/<sha256[0:2]>/<sha256>.<ext>
```

换机器时不要改 manifest 里的样本 ID。通过环境变量或命令行覆盖音频根：

```powershell
$env:FRKB_SONG_STRUCTURE_AUDIO_ROOT = "G:/FRKB_database-A/analysis/song-structure-truth/audio"
```

仓库内、可提交的真值根：

```text
test-data/song-structure/
  manifest.json                     # 样本索引、网格、split、状态和音频哈希
  schema/                           # manifest/truth/prediction JSON Schema
  tracks/<sha256>.truth.json        # 人工试听真值；不是算法输出
  baselines/vN/<sha>.prediction.json# 历史生产算法输出快照
  replay/README.md                  # replay 资产约束
```

本机临时工作区：

```text
structure-analysis-lab/
  reports/                          # benchmark 报告
  replay/                           # 本地可复用特征缓存
  diagnostics/                      # 临时逐四拍块诊断
  intake/                           # 未归档草稿
```

`structure-analysis-lab/` 已加入 `.gitignore`。`drafts/`、`tmp/`、`test-data/` 和
`structure-analysis-lab/` 同时从 `electron-builder.yml` 与 `package.json.build.files` 排除，
不得进入正式安装包。完整音频永远不进 Git，也不放 `resources/`。

## 2. 数据的四种身份

### 2.1 Manifest

`manifest.json` 是曲目索引，不是标签真值。每首歌至少记录：

- SHA-256、大小、原始文件名和哈希音频相对路径；
- fixed 或 dynamic 网格；
- `calibration / development / regression / holdout` split；
- `approved / review-queue / known-failure` 状态；
- truth 文件和历史 prediction 文件列表。

固定网格：

```json
{
  "kind": "fixed",
  "bpm": 126,
  "firstBeatMs": 26,
  "downbeatBeatOffset": 0
}
```

动态网格直接保存生产 `SongBeatGridClip` 语义，不另造测试格式：

```json
{
  "kind": "dynamic",
  "clips": [
    { "startSec": 0, "anchorSec": 0.026, "bpm": 126, "downbeatBeatOffset": 0 },
    { "startSec": 182.883, "anchorSec": 182.883, "bpm": 127, "downbeatBeatOffset": 0 }
  ]
}
```

benchmark 会用 `createSongBeatGridMapV2FromClips` 生成生产四拍网格与 signature，禁止手写另一套
动态网格投影。manifest/truth schema v2 只使用 `downbeatBeatOffset`，不再保存大节线、小节线或
phrase 相位概念。

### 2.2 Truth

`tracks/*.truth.json` 只保存人工试听结论：

- `coverage=full`：整首已标注；
- `coverage=partial`：只对列出的连续区间负责；
- `coverage=none`：待试听，`sections` 必须为空；
- `kind` 是严格标签；
- `acceptableKinds` 表达 Techno 中合理的语义歧义；
- `startDownbeatOrdinal / endDownbeatOrdinal` 使用零基、半开区间，直接对应连续四拍块；
- `boundaryToleranceDownbeats` 表达边界允许偏差的四拍块数量。

只有用户实际试听并明确认可后，才能把 `review.status` 改成 `approved`。算法 prediction、UI 当前
显示、旧聊天里“看起来还行”的描述都不能自动升级成 truth。

### 2.3 Prediction baseline

`baselines/vN/*.prediction.json` 是生产算法历史输出，只用于回答“升级前后改了什么”。它必须与
truth 分离，并记录：

- algorithmVersion / formatVersion / strategy；
- `decoderBackend`，用于确认 benchmark 与正式 Worker 使用同一音频解码路径；
- Git HEAD 与 dirty 状态；
- 生成时间、运行时间和最终 sections。

dirty snapshot 只说明它在那个 HEAD 上的脏工作树生成，不能宣称该 commit 本身等于该算法版本。

### 2.4 Local report / replay

`structure-analysis-lab/reports/` 是可覆盖的本地运行报告。仓库内 baseline 是经过审查后保留的历史
快照，两者不能混用。

本地 replay 将来可以缓存生产输入以减少重复解码，但仓库暂不提交二进制 replay。任何可提交
replay 都必须先证明不能还原音乐，并通过“同版本音频直跑与 replay 输出完全一致”的验证。

## 3. 当前首批样本

| 曲目 | SHA 前缀 | Split | 状态 | 当前真值 |
| --- | --- | --- | --- | --- |
| Jo Paciello, Raffaele Ciavolino - A Night | `d5aba7ba` | regression | approved | 完整 ordinals 0–177；171.760s、187.370s、216.638s 为硬回归边界 |
| Kate Bush - Running Up That Hill (Zesto Remix) | `d98aff97` | development | review-queue | 用户已审查 v26 当前结构；尚未逐段录入 full truth |
| ANOTR, Kurtis Wells - 24 | `ae6867d7` | development | review-queue | 只批准 ordinals 80–144 的 Drop → Breakdown → Drop；v26 全曲问题已复核 |
| Avenue One & Jaren - My Way Home | `b5050f4f` | development | review-queue | v21 巨型 Groove 已修复；用户认可 v26 三轮宏观结构，尚无 full truth |
| 7CIRCLE - Sevastra (EAS Remix) | `4593a19d` | development | review-queue | v26 prediction 已冻结；无人工真值 |
| alisha - can't touch us | `7cce867d` | development | review-queue | 用户认可 v26 当前结构；尚未逐段录入 full truth |
| Allfive - Fieldwork | `3b5c4311` | development | review-queue | 用户认可 v26 当前结构及 334.953s Outro 起点；尚未逐段录入 full truth |

当前仓库为全部 7 首保存了生产解码一致的 v26 prediction；旧 v16 / v20 / v21 / v22 baseline 继续
保留作历史差异审查。My Way Home 的 v16 replay 用来证明 v21 巨型 Groove 是明确退化。没有
`decoderBackend` 的旧 baseline 只可用于历史对照，不能作为生产一致 benchmark 结论。

2026-07-16 的 v26 基准节点：7 首全部分析成功，`errorTrackCount=0`。只有 A Night 完整 truth 与
ANOTR 局部 truth 进入准确率分母，共计 241 个四拍块：Boundary Precision `0.700000`、Recall
`0.777778`、F1 `0.736842`，严格/宽松标签准确率均为 `0.892116`。ANOTR 局部为 100%；A Night
整首 Boundary F1 为 `0.666667`、标签准确率为 `0.853107`。这些数字不能被表述成“7 首真值全部
正确”；其余 5 首目前是用户审查过的开发样本或未审查样本，不是自动计分 truth。

本轮 v26 人工审查重点：

- Avenue：恢复为三轮 `Drop → Breakdown / Build → Drop` 宏观结构，不再硬切相邻同标签 Groove；
- alisha：移除极短伪 Drop 与末段伪 Breakdown；
- Allfive：移除 Drop 之间的伪 Build；334.953s 的持续能量下降属于 Outro 起点，即使低频在
  338.333s 才完全抽掉；
- ANOTR：首 Drop 从 78.898s 开始，141.848s 才进入下一 Breakdown，不再吞掉 Drop 后半段；
- Kate：Intro 合并到 30.502s，91.455–121.931s 恢复为 Build，末段周期抽空不再误标 Breakdown；
- A Night：171.760s / 187.370s / 216.638s 三个批准关键点保持不变。

## 4. 添加新样本

先 dry-run：

```powershell
pnpm run song-structure:truth:add -- --file "G:/path/track.mp3" --title "Artist - Track" --bpm 128 --first-beat-ms 42 --downbeat-beat-offset 0 --split development --status review-queue
```

检查哈希、目标路径和网格后执行：

```powershell
pnpm run song-structure:truth:add -- --file "G:/path/track.mp3" --title "Artist - Track" --bpm 128 --first-beat-ms 42 --downbeat-beat-offset 0 --split development --status review-queue --apply
```

动态网格通过 `--grid-json` 输入，格式见第 2.1 节。添加工具只会创建
`coverage=none / review-queue` 草稿，故意不提供 `approved` 快捷参数。

## 5. 批准、局部失败与状态修改

### 批准整首

1. 用户在 UI 中实际试听边界和标签。
2. 手工填写 `tracks/<sha>.truth.json` 全部 sections。
3. 设置 `coverage=full`、`review.status=approved`、`source=user-listening`。
4. 把 manifest 状态改为 `approved`，通常放入 `regression`。
5. 运行 `pnpm run benchmark:song-structure -- --validate-only`。

### 只锁定一个失败区间

用户只指出某一段错误时，truth 用 `coverage=partial`，只写明确区间；manifest 保持
`known-failure / development`。禁止为了凑完整真值，把其余区间直接抄自当前 prediction。

### 待试听

没有用户确认的样本保持 `coverage=none / review-queue`。它可以用于性能、崩溃和人工对比，但不计入
标签准确率。

## 6. 运行 Benchmark

只校验元数据，不解码：

```powershell
pnpm run benchmark:song-structure -- --validate-only
```

跑全部样本，默认把报告写入本地 lab：

```powershell
pnpm run benchmark:song-structure -- --verify-hash
```

只跑不能回退的 approved regression：

```powershell
pnpm run benchmark:song-structure -- --split regression --status approved
```

只跑仍待逐段固化的开发样本：

```powershell
pnpm run benchmark:song-structure -- --split development --status review-queue
```

只跑一首：

```powershell
pnpm run benchmark:song-structure -- --track ae6867d7
```

确认新版本输出值得保存后，才生成版本 baseline：

```powershell
pnpm run benchmark:song-structure -- --write-baseline
```

同版本 baseline 默认拒绝覆盖。只有明确要刷新该版本脏快照时才加
`--overwrite-baseline`，并在 diff 中逐首审查。

benchmark 直接调用：

```text
src/shared/songStructure.ts#buildSongStructureAnalysis
```

音频解码和统一波形输入复用生产实现。禁止在 Python、测试脚本或 benchmark 中复制一份“差不多”的
段落算法。当前 report schema 为 v2，计数统一使用四拍 downbeat，不再输出 bar 计数字段。报告提供：

> 硬规则：MP3 必须与正式 Worker 一样使用 native-libav、44100 Hz、双声道 PCM。禁止用
> `decodeAudioFile` 的默认解码结果代替。`inspect:song-structure`、benchmark 报告和新 prediction
> 都必须输出 `decoderBackend`；若 MP3 不是 `native-libav-waveform`，该次结果不得用于真值评估、
> baseline 更新或算法回归结论。

- 内部边界 precision / recall / F1；
- 严格标签四拍块 accuracy；
- `acceptableKinds` 宽松标签四拍块 accuracy；
- partial truth 只在覆盖区间计分；
- review-queue 只出 prediction，不进入准确率分母。

## 7. 算法升级闸门

每次修改段落算法，至少执行：

1. `pnpm run test:song-structure`；
2. `npx vue-tsc --noEmit`；
3. `pnpm run benchmark:song-structure -- --split regression --status approved`；
4. `pnpm run benchmark:song-structure -- --split development --status review-queue`；
5. 对 prediction diff 做逐曲审查；
6. 用户试听新改善样本后再更新 truth。

默认不接受 approved regression 的退化。A Night 是当前第一条硬回归：修 ANOTR 或后续歌曲时，
171.760s、187.370s、216.638s 三个批准关键点不能回退。开发样本的 v26 prediction diff 也必须
逐首审查，但在没有人工 truth 前不得伪装成准确率提升。

## 8. Holdout 纪律

- `calibration`：用于建立量纲、标注准则和宽松标签口径。
- `development`：允许诊断和调参，已知失败放这里。
- `regression`：用户批准且每次都必须保持的样本。
- `holdout`：锁定后只做阶段性验收，禁止逐曲看诊断、扫阈值或打补丁。

一旦查看 holdout 的逐曲结果并据此改算法，这批数据就已经被消费，必须移出 holdout 或明确标成
consumed。不能在同一批歌上反复调参，再拿同一批分数证明泛化。

当前 7 首全部是已参与讨论或开发的样本，没有一首可以冒充 blind holdout。新的 holdout 应按艺人
隔离，避免同一制作人的重复母带同时出现在 development 和 holdout。

## 9. 维护边界

- 本文只维护当前有效流程和当前样本状态，不追加聊天流水账。
- 算法草案仍在 `drafts/song-structure/techno-song-structure-analysis-optimization-draft.md`；评估执行以本文为准。
- 不要修改 README 来记录内部真值路径。
- 不要删除旧 prediction 来“让新版本看起来更好”。
- 不要把原始音频、可恢复音频的高分辨率特征或本地报告提交到仓库。
