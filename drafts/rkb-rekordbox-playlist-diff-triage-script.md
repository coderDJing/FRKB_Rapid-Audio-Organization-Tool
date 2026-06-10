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
- 当前算法对比阈值：沿用 benchmark 脚本里的 `STRICT_TOLERANCE_MS`
- 默认是 dry-run，只写报告，不修改 Rekordbox

## Upan 源头清理

如果本轮样本源来自 Rekordbox `Upan` 歌单，第一步先运行源头清理脚本，再继续从
`Upan` 抽样到 `test`。脚本固定按下面顺序执行：

1. 去重：和 current truth 重复的曲目直接从 `Upan` 移除，一首不留；只在 `Upan` 内部重复、
   且不命中 current truth 的曲目，保留第一条 playlist entry，移除后续多余项。
2. 非整数 BPM 分流：对去重后剩余曲目检查 bridge 的 `bpm` 字段，也就是贴近 Rekordbox UI
   BPM 列的值；UI BPM 非整数的曲目移动到 `upanNonIntegerBpm` 人工筛查歌单。`gridBpm`
   只写入报告辅助核对，不参与筛选。

先跑 dry-run：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" `
  "scripts/move_upan_non_integer_bpm_tracks.py"
```

确认报告里的 `duplicateRemovalTrackCount`、`nonIntegerBpmTrackCount` 和预览明细没问题后，
再写回：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" `
  "scripts/move_upan_non_integer_bpm_tracks.py" `
  --apply
```

`--apply` 会先从 `Upan` 直接移除重复 playlist 条目，再创建或复用 `upanNonIntegerBpm`，
把非整数 UI BPM 曲目追加到该歌单并从 `Upan` 移除。它不删除音频文件，也不处理 BPM
缺失/无效曲目。

## 适用场景

适合处理这种情况：

1. Rekordbox 里有一个待筛选歌单。
2. 源头去重和非整数 UI BPM 分流已经提前完成。
3. 需要用当前 FRKB beatgrid 算法逐首对比 Rekordbox 网格。
4. 一致的保留在源歌单，不一致的移动到 review 歌单。

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

- `summary.differenceTrackCount`：当前算法与 Rekordbox 不一致的曲目数。
- `differences[]`：准备移动到目标 review 歌单的曲目明细。

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

1. 对源歌单曲目跑当前算法分析。
2. 如果目标歌单不存在，创建目标歌单。
3. 把不一致曲目追加到目标歌单。
4. 从源歌单移除这些不一致曲目。

所以执行完成后，源歌单只应该留下“当前算法与 Rekordbox 一致”的曲目。

## 从报告写回

如果已经有确认过的 dry-run 报告，可以不重新分析音频，直接按报告写回：

```powershell
& "vendor/demucs/win32-x64/runtime-cpu/python.exe" `
  "scripts/move_rekordbox_playlist_grid_diffs.py" `
  --from-report "grid-analysis-lab/rkb-rekordbox-benchmark/rekordbox-test-need-review-latest.json" `
  --target-playlist "needReview" `
  --apply
```

这条路径只按报告里的 `differences[]` 写入目标歌单并从源歌单移除，不重新分析音频，
也不做去重。

## 常用参数

- `--source-playlist`：源 Rekordbox 歌单名，默认 `test`。
- `--target-playlist`：不一致曲目的目标 Rekordbox 歌单名，默认 `needReview`。
- `--audio-root`：分析音频搜索根目录；多个目录用分号分隔。
- `--only`：按文件名 / 标题 / 艺人做子串过滤，可重复传入。
- `--limit`：限制本次最多处理多少首，用于小批量验证。
- `--copy-only`：只把不一致曲目追加到目标歌单，不从源歌单移除。

## 去重位置

去重已经前移到 `scripts/move_upan_non_integer_bpm_tracks.py`。这个差异分拣脚本不再读取
`rekordbox-current-truth.json` 做去重，也不再处理源歌单内部重复项，避免每次分拣重复扫描。
如果源歌单来自 `Upan`，先完成 Upan 源头清理，再运行本脚本。

## 注意事项

- `--apply` 会修改 Rekordbox 本机库歌单；先跑 dry-run。
- `--apply` 不删除音频文件，只移动 / 移除 Rekordbox 歌单条目。
- 目标歌单写入使用 Rekordbox `trackId`，源歌单移除使用 playlist `rowKey`。
- 如果源歌单和目标歌单同名，脚本会拒绝 move。
- 如果只是想保留源歌单完整内容，只追加 review 副本，用 `--copy-only`。
