# 历史归档：Rekordbox 样本库根目录迁移草案（G 到 D）

> 已归档，禁止执行本文命令。当前权威样本库是 `.env` 所指向的 `G:/FRKB_database-E`；D 盘库已不存在。
> 现行 fresh 入口见 [`../准备好rkb新样本.md`](../准备好rkb新样本.md)。

## 目的与边界

迁移已完成，当前权威样本库是 `D:/FRKB_database-E`。历史 7 个 immutable sealed manifest 的 3745 条
`sourcePath` 仍指向 G，因此运行时通过 relocation sidecar 将派生 registry 映射到 D；G 原库暂时保留为
已验证的回滚副本，未获得单独确认前不得删除。

本流程使用 `rkb-dataset-root-remap.json` 作为一次性、不可覆盖的 relocation sidecar。它只允许改写
**派生** `rkb-dataset-registry.json` 的 `sourcePath`，不会改写任何历史 manifest、state、truth、baseline
或音频身份。sidecar 会锁定未重定位 registry 的内容 SHA、批次数量、sourceRoot、targetRoot 和 sealed
batches 根目录；不匹配时 hard fail。

`rebuild-registry` 发现 registry 同目录的 canonical sidecar 后会自动使用它，并对 targetRoot 下每个
`sourcePath` 重新计算 asset SHA-256。`build_rkb_rekordbox_dataset_splits.py` 也会自动沿用同一 sidecar，
因此后续 canonical split 不会悄悄把路径写回 G。

本文件保留已执行迁移的可复现流程；未来再次迁移时，不要在未明确确认前执行删除、复制或 `.env` 修改。

## 迁移前条件

1. FRKB 已完全退出，且没有 active sealed batch；当前 7 批必须都为 `consumed`。
2. D 盘已确认有容量。当前口径下，先处理已验证的 D 盘重复音频与可再生 cache 后，再复制完整库。
3. 迁移时始终先**复制** G 到 D，禁止使用 move、`robocopy /MOVE`、`robocopy /MIR` 或任何覆盖删除选项。
4. G 旧库在 D 稳定运行前必须保留；其删除需要单独确认。

## 一次性迁移命令

以下命令仅在确认迁移窗口后执行。变量全部显式指定，避免脚本猜盘符。

```powershell
$Python = (Resolve-Path "vendor/demucs/win32-x64/runtime-cpu/python.exe").Path
$Sealed = "scripts/rkb_sealed_batch.py"
$Benchmark = "grid-analysis-lab/rkb-rekordbox-benchmark"
$BatchesRoot = "$Benchmark/sealed-batches"
$Registry = "$Benchmark/rkb-dataset-registry.json"
$Baseline = "$Benchmark/rkb-dataset-registry-baseline.json"
$SourceRoot = "G:/FRKB_database-E"
$TargetRoot = "D:/FRKB_database-E"
```

先复制，保留 G 原件。`robocopy` 的 0–7 返回码是成功或有可预期差异；大于等于 8 才是失败。

```powershell
robocopy "G:/FRKB_database-E" "D:/FRKB_database-E" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /MT:8
if ($LASTEXITCODE -ge 8) { throw "database copy failed: $LASTEXITCODE" }
```

复制完成后才创建 immutable sidecar。默认输出固定在 registry 同目录，后续重建会自动读取它。

```powershell
& $Python $Sealed create-root-remap `
  --batches-root $BatchesRoot `
  --registry $Registry `
  --baseline $Baseline `
  --source-root $SourceRoot `
  --target-root $TargetRoot
```

随后重建派生 registry。这个命令会对 3745 条目标音频逐条重算 SHA-256；任一缺失或 hash 不同都不会写 registry。

```powershell
& $Python $Sealed rebuild-registry `
  --batches-root $BatchesRoot `
  --registry $Registry `
  --baseline $Baseline
```

重建 canonical split 和三份 registry-enriched truth。该命令会再次验证 relocation sidecar 和目标音频，
所以会再读一遍完整库；这是为了拒绝“第一次检查后文件被替换”的情况。

```powershell
& $Python "scripts/build_rkb_rekordbox_dataset_splits.py" `
  --registry $Registry `
  --output "$Benchmark/rkb-dataset-splits-current.json"
```

最后重建所有路径绑定的 feature cache、再运行现有 benchmark / nested LOBO 的统一 cache 流程。只有这些全部
完成并验证 split membership、`assignmentDigestSha256`、`splitAssignmentsSha256` 不变后，才允许把 `.env`
的 `FRKB_DEV_DATABASE_URL` 从 G 切到 D。

## 不变量与失败处理

- `manifest.json`、`state.json`、baseline 的字节内容和 SHA 都不得改变。
- registry 的 `sourcePath`、registry SHA 和 derived truth 的 registry hash 会改变；这是正常且必须重建的
  派生路径绑定。
- `batchId + assetSha256`、PCM、family、isolation family、assignment 和 LOBO membership 必须保持不变。
- sidecar、目标根目录、source registry SHA、任一 target 音频校验失败时停止；不得修改 sidecar 后重试或
  暂时回退到 G。
- 切 `.env` 后先稳定运行与复核，再单独确认删除 G 旧库和已验证的 D 盘重复副本。
