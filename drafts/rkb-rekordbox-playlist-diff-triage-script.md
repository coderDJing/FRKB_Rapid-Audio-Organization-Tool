# Rekordbox 歌单差异分拣脚本

这是一条独立按需使用的维护脚本，不是 `rkb-rekordbox-truth-validation-workflow.md`
里的固定 intake / benchmark 流程。只有需要清理某个 Rekordbox 歌单，并把当前算法与
Rekordbox 网格不一致的曲目集中到 review 歌单时，才单独运行它。

脚本入口：

```text
scripts/move_rekordbox_playlist_grid_diffs.py
```

默认行为：

- 源 Rekordbox 歌单：`test`
- 目标 Rekordbox 歌单：`needReview`
- 当前样本去重基准：`grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-current-truth.json`
- 当前算法对比阈值：沿用 benchmark 脚本里的 `STRICT_TOLERANCE_MS`
- 默认是 dry-run，只写报告，不修改 Rekordbox

## Upan 非整数 BPM 前置筛查

如果本轮样本源来自 Rekordbox `Upan` 歌单，先把 UI BPM 列已经显示为非整数的曲目移到
`upanNonIntegerBpm` 人工筛查歌单，再继续从 `Upan` 抽样到 `test`。这一步使用 bridge 的
`bpm` 字段，贴近 Rekordbox UI BPM 列；`gridBpm` 只写入报告辅助核对，不参与筛选。

先跑 dry-run：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" `
  "scripts/move_upan_non_integer_bpm_tracks.py"
```

确认报告里的 `nonIntegerBpmTrackCount` 和预览明细没问题后，再写回：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" `
  "scripts/move_upan_non_integer_bpm_tracks.py" `
  --apply
```

`--apply` 会创建或复用 `upanNonIntegerBpm`，把非整数 UI BPM 曲目追加到该歌单，再从
`Upan` 移除这些 playlist 条目。它不删除音频文件，也不处理 BPM 缺失/无效曲目。

## 适用场景

适合处理这种情况：

1. Rekordbox 里有一个待筛选歌单。
2. 歌单里可能混入重复曲目，或已经存在于当前主样本 truth 的曲目。
3. 需要先从这个 Rekordbox 源歌单里移除重复项。
4. 再用当前 FRKB beatgrid 算法逐首对比 Rekordbox 网格。
5. 一致的保留在源歌单，不一致的移动到 review 歌单。

它不负责把新样本合入 `rekordbox-current-truth.json`，也不负责刷新 current benchmark /
classification。那些仍然属于主 truth workflow。

## Dry-run

先跑 dry-run 看报告：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" `
  "scripts/move_rekordbox_playlist_grid_diffs.py" `
  --source-playlist "test" `
  --target-playlist "needReview" `
  --output "grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-test-need-review-latest.json"
```

dry-run 会生成 JSON 报告，重点看：

- `summary.dedupe.skippedCount`：准备从源歌单移除的重复条目数。
- `summary.dedupe.selfDuplicateCount`：源歌单内部重复数。
- `summary.dedupe.currentSampleDuplicateCount`：已存在于当前主 truth 的重复数。
- `summary.differenceTrackCount`：当前算法与 Rekordbox 不一致的曲目数。
- `differences[]`：准备移动到目标 review 歌单的曲目明细。
- `dedupe.skipped[]`：准备从源歌单移除的重复条目明细。

dry-run 不会创建 `needReview`，也不会改动 Rekordbox 歌单。

## Apply

确认 dry-run 报告没问题后，再执行实际写回。写回前关闭 Rekordbox，确保本机
Rekordbox 数据库可写。

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" `
  "scripts/move_rekordbox_playlist_grid_diffs.py" `
  --source-playlist "test" `
  --target-playlist "needReview" `
  --output "grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-test-need-review-latest.json" `
  --apply
```

`--apply` 的写回顺序固定：

1. 先从源 Rekordbox 歌单移除 dedupe 命中的重复条目。
2. 再对去重后剩余曲目跑当前算法分析。
3. 如果目标歌单不存在，创建目标歌单。
4. 把不一致曲目追加到目标歌单。
5. 从源歌单移除这些不一致曲目。

所以执行完成后，源歌单只应该留下“非重复且当前算法与 Rekordbox 一致”的曲目。

## 从报告写回

如果已经有确认过的 dry-run 报告，可以不重新分析音频，直接按报告写回：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" `
  "scripts/move_rekordbox_playlist_grid_diffs.py" `
  --from-report "grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-test-need-review-latest.json" `
  --target-playlist "needReview" `
  --apply
```

这条路径同样会先按报告里的 `dedupe.skipped[]` 移除源歌单重复条目，再按
`differences[]` 写入目标歌单并从源歌单移除。

## 常用参数

- `--source-playlist`：源 Rekordbox 歌单名，默认 `test`。
- `--target-playlist`：不一致曲目的目标 Rekordbox 歌单名，默认 `needReview`。
- `--current-truth`：当前样本去重基准，默认 `rekordbox-current-truth.json`。
- `--audio-root`：分析音频搜索根目录；多个目录用分号分隔。
- `--only`：按文件名 / 标题 / 艺人做子串过滤，可重复传入。
- `--limit`：限制本次最多处理多少首，用于小批量验证。
- `--copy-only`：只把不一致曲目追加到目标歌单，不从源歌单移除。
- `--include-duplicates`：关闭默认去重移除逻辑，把重复曲目也纳入分析。

## 去重口径

默认去重分两层：

1. 源歌单自去重：按 `trackId`、`fileName`、`title + artist + BPM` 保守匹配，保留第一条。
2. 当前样本去重：和 `--current-truth` 指向的主 truth 比对，按 `fileName` 以及
   `title + artist + BPM` 保守匹配。

去重命中的条目不参与算法分析。带 `--apply` 时，它们会先从源 Rekordbox 歌单移除。

## 注意事项

- `--apply` 会修改 Rekordbox 本机库歌单；先跑 dry-run。
- `--apply` 不删除音频文件，只移动 / 移除 Rekordbox 歌单条目。
- 目标歌单写入使用 Rekordbox `trackId`，源歌单移除使用 playlist `rowKey`。
- 如果源歌单和目标歌单同名，脚本会拒绝 move。
- 如果只是想保留源歌单完整内容，只追加 review 副本，用 `--copy-only`。
