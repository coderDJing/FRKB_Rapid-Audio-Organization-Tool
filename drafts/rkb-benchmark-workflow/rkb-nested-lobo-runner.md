# RKB Nested LOBO Runner 使用说明

这套入口用于在已经 consumed 的六个 primary 批次上，执行固定候选、无训练器的两阶段 nested
LOBO。它提供的是历史 consumed 数据上的防泄漏泛化估计，不是 fresh sealed 证明，也不能替代下一批
fresh 的一次性验收。

用户侧人工流程仍然是 `Upan -> test -> needReview -> review`。本文步骤只属于开发者内部评估，不要求
用户改变分拣操作。

权威防过拟合约束见
[`drafts/rkb-benchmark-workflow/rkb-nested-lobo-anti-overfit-contract.md`](./rkb-nested-lobo-anti-overfit-contract.md)。

## 1. 固定输入

本文使用以下候选 manifest：

- [`drafts/rkb-nested-lobo-candidates.example.json`](../rkb-nested-lobo-candidates.example.json)
- 唯一 no-op：当前 solver 默认参数，`complexityRank = 0`
- 唯一非 no-op：只把 `phaseStepMs` 从 `2.0` 改成 `1.0`
- candidate grid 故意保持很小，避免在 3745 首已消费样本上继续扩大搜索空间

示例 policy 是一份可直接运行的、偏保守的预注册起点，不是跑完后可以追着结果改的参数模板。开始
`select` 前可以基于业务风险一次性审阅；一旦开始同一个 primary study，就不得根据 inner 或 outer
结果修改候选、阈值、objective 或 complexity rank。

示例阈值的量纲与含义如下：

| Gate | 预注册值 | 含义 |
| --- | ---: | --- |
| inner `maximumPassToFailRate` | `0.005` | 单个 inner batch 最多容忍 0.5 个百分点 |
| inner BPM 大错率增量 | `0.0025` | 单个 inner batch 最多容忍 0.25 个百分点 |
| inner downbeat failure 增量 | `0.005` | 单个 inner batch 最多容忍 0.5 个百分点 |
| outer 正向 folds | `>= 4 / 6` | 至少四个 primary batch 严格正向 |
| outer macro 净增 | `>= 0.001` | 六折 unweighted macro 至少增加 0.1 个百分点 |
| outer 最差 fold 净增 | `>= -0.0025` | 任一 fold 最多下降 0.25 个百分点 |
| outer error count | `0` | 任一算法执行错误都否决本次 aggregate |

这些数值是在首次 primary 运行前给出的风险合同，不是从本次六折结果反推的“最佳阈值”。若维护者认为
业务风险边界不同，必须在首次 `select` 前改成另一份明确 manifest 并记录理由；不能等 outer 暴露后
回头改。

六个 primary outer folds 固定为：

- `blind608`
- `current1407`
- `old377`
- `test316`
- `test327`
- `test353`

`new357` 是 diagnostic-only，不进入 effective train/tune、六折 aggregate 或晋级 gate。

## 2. 必须使用项目 Python

在仓库根目录打开 PowerShell，先固定命令变量：

```powershell
$Python = (Resolve-Path "vendor/demucs/win32-x64/runtime-xpu/python.exe").Path
$Runner = "scripts/run_rkb_nested_lobo.py"
$Splits = "grid-analysis-lab/rkb-rekordbox-benchmark/rkb-dataset-splits-current.json"
$Candidates = "drafts/rkb-nested-lobo-candidates.example.json"
$FeatureCache = "grid-analysis-lab/rkb-rekordbox-benchmark/feature-cache-by-batch/primary"
$New357FeatureCache = "grid-analysis-lab/rkb-rekordbox-benchmark/feature-cache-by-batch/new357"
$StudyId = "rkb-primary-nested-lobo-v2-groot"
$WorkDir = "grid-analysis-lab/rkb-rekordbox-benchmark/nested-lobo/$StudyId"
$Ledger = "grid-analysis-lab/rkb-rekordbox-benchmark/nested-lobo-outer-exposure-ledger.json"
```

确认 CLI 可以由正确环境加载：

```powershell
& $Python $Runner --help
```

不要把系统 `py` 当作这条链路的标准解释器。runner 在 argparse 输出 `--help` 前就会加载 NumPy、
solver、benchmark 和 beat_this 相关模块，所以即使只是执行下面这条命令，也可能先因系统 Python
缺少 NumPy、Torch、soxr 或 beat_this 依赖而失败：

```powershell
py "scripts/run_rkb_nested_lobo.py" --help
```

这类失败表示解释器环境不对，不表示 `--help` 或 runner 参数定义坏了。统一使用
`vendor/demucs/win32-x64/runtime-xpu/python.exe`。本机 Intel Arc 可用时，feature 生成必须配合
`--device xpu`，避免无意义地把 BeatThis 推理放回 CPU。

## 3. feature-generation policy 与 G 盘权威库

当前权威音频库是 `.env` 所指向的 `G:/FRKB_database-E`；D 盘路径已经失效，禁止回退或拿旧 manifest
判断样本总数。现有 XPU feature cache 已完成身份校验和物化：primary 为 3388 首，`new357` 为 357 首。
下面的重建命令仅用于 cache 损坏后的恢复，不能作为常规 LOBO 前置步骤，更不能在已封存 study 后用
`--force` 覆盖 cache。

runner 会从每条 metadata 的 `cachePayload` 锁定 feature cache version、sample rate、channels、scan
时长、device、checkpoint、BeatThis 签名和 feature function 源码签名，并要求 3388 个 primary 实例的
policy SHA 完全一致。混用两代 cache 会 fail closed，这是必要保护，不得绕过。

如确实需要从头恢复 feature cache，所有七批必须用同一 policy、XPU runtime 和独立输出目录；某批失败
时立即停止，禁止拿不完整目录继续物化：

```powershell
$BatchesRoot = "grid-analysis-lab/rkb-rekordbox-benchmark/sealed-batches"
$Registry = "grid-analysis-lab/rkb-rekordbox-benchmark/rkb-dataset-registry.json"
$DatabaseRoot = "G:/FRKB_database-E"
$RebuiltRoot = "grid-analysis-lab/rkb-rekordbox-benchmark/feature-cache-policy-current"

foreach ($BatchId in @("current1407", "blind608", "old377", "test316", "test327", "test353", "new357")) {
  & $Python "scripts/run_parallel_rkb_beatgrid_feature_cache.py" `
    --truth "$BatchesRoot/$BatchId/truth.json" `
    --truth-batch-id $BatchId `
    --registry $Registry `
    --audio-root $DatabaseRoot `
    --cache-dir "$RebuiltRoot/$BatchId" `
    --shard-dir "$RebuiltRoot/shards-$BatchId" `
    --device xpu `
    --force
  if ($LASTEXITCODE -ne 0) {
    throw "feature policy rebuild failed: $BatchId"
  }
}
```

重算必须输出到新目录，禁止覆盖历史 cache；完成后必须验证六个 primary 的 policy SHA 和 instance
identity 完全一致，再进入物化。`new357` 不得混入 primary cache。

## 4. 一次性物化 instance-safe feature cache

新的 batch cache 已按独立目录重建。统一 policy 后，再使用现有 materializer 把六个 primary 批次以
hardlink 方式汇入统一目录；默认不复制巨型 arrays。

先定义 primary batch 到当前 cache 的固定映射：

```powershell
$BatchesRoot = "grid-analysis-lab/rkb-rekordbox-benchmark/sealed-batches"
$FeatureSources = [ordered]@{
  current1407 = "$RebuiltRoot/current1407"
  blind608 = "$RebuiltRoot/blind608"
  old377 = "$RebuiltRoot/old377"
  test316 = "$RebuiltRoot/test316"
  test327 = "$RebuiltRoot/test327"
  test353 = "$RebuiltRoot/test353"
}
```

先对六批全部 dry-run：

```powershell
foreach ($Entry in $FeatureSources.GetEnumerator()) {
  & $Python "scripts/materialize_rkb_feature_cache_by_batch.py" `
    --batch-id $Entry.Key `
    --batches-root $BatchesRoot `
    --source-cache-dir $Entry.Value `
    --target-cache-dir $FeatureCache `
    --splits $Splits `
    --dry-run
  if ($LASTEXITCODE -ne 0) {
    throw "feature cache dry-run failed: $($Entry.Key)"
  }
}
```

只有每一批都显示 `missing = 0`，并且六批 generation policy 完全一致时才执行写入：

```powershell
foreach ($Entry in $FeatureSources.GetEnumerator()) {
  & $Python "scripts/materialize_rkb_feature_cache_by_batch.py" `
    --batch-id $Entry.Key `
    --batches-root $BatchesRoot `
    --source-cache-dir $Entry.Value `
    --target-cache-dir $FeatureCache `
    --splits $Splits
  if ($LASTEXITCODE -ne 0) {
    throw "feature cache materialization failed: $($Entry.Key)"
  }
}
```

六个 primary batch 共 `3388` 个实例。runner 还会按 split 的 exact instance roster、metadata 与 arrays
digest 建立 immutable feature contract；缺实例、弱身份、多 cache proof 冲突都会 fail closed。

## 5. `plan`：只核对分折与候选合同

```powershell
& $Python $Runner plan `
  --study-id $StudyId `
  --work-dir $WorkDir `
  --splits $Splits `
  --candidates $Candidates
```

预期输出必须满足：

- `primaryFoldIds` 正好是六个 primary batch；
- `diagnosticFoldIds` 只有 `new357`；
- `filteredDiagnosticTuneCounts` 显示 diagnostic 实例已从各折 effective tune 中移除；
- `fixedNoFitOnly = true`；
- `outerTruthRead = false`。

`plan` 不读取 outer 结果，也不会建立 outer exposure。若这里失败，先修 split、truth 或 candidate
contract，禁止带病进入 `select`。

## 6. `select`：只在 effective development 上冻结六个选择

第一次运行：

```powershell
& $Python $Runner select `
  --study-id $StudyId `
  --work-dir $WorkDir `
  --splits $Splits `
  --candidates $Candidates `
  --feature-cache-dir $FeatureCache `
  --evidence-role "primary-consumed-nested-estimate"
```

该阶段会冻结 study lock、feature contract、fold plan、每折 tune results、六个 selection locks 和
`selection-index.json`，并把 selection plan、path-independent evidence universe 锚进中央 ledger。它不读取
对应 fold 的 outer holdout。

如果进程在 selection 未完成时中断，只能用完全相同的输入加 `--resume`：

```powershell
& $Python $Runner select `
  --study-id $StudyId `
  --work-dir $WorkDir `
  --splits $Splits `
  --candidates $Candidates `
  --feature-cache-dir $FeatureCache `
  --evidence-role "primary-consumed-nested-estimate" `
  --resume
```

正常完成时状态应为 `primary_selections_locked`，且 `primaryFoldCount = 6`。no-op 是合法胜者；如果
非 no-op 在任一 primary inner batch 上出现更差的最坏净增，selector 选择 baseline 正是预期保护，
禁止为了“必须有提升”而移除 baseline 或改 objective。

## 7. `evaluate`：一次性暴露六个 outer holdout

这是不可逆证据边界。运行前最后确认：

- candidate manifest、selection policy 和 aggregate policy 不再修改；
- `selection-index.json` 已覆盖六个 immutable selection locks；
- ledger 路径正确，且没有另一个 lock 已经暴露同一 dataset contract；
- 接受本次结果可能为零提升或 gate 失败，失败后只做诊断，不追着 outer 调参再宣称 primary。

第一次运行：

```powershell
& $Python $Runner evaluate `
  --study-id $StudyId `
  --work-dir $WorkDir `
  --splits $Splits `
  --candidates $Candidates `
  --feature-cache-dir $FeatureCache `
  --ledger $Ledger `
  --evidence-role "primary-consumed-nested-estimate"
```

runner 在每折实际求值前先追加 `outer-exposed` ledger 事件。若进程只完成了部分 outer folds，使用完全
相同的输入加 `--resume`，已存在结果必须通过正文 digest、provenance 和 roster 重验：

```powershell
& $Python $Runner evaluate `
  --study-id $StudyId `
  --work-dir $WorkDir `
  --splits $Splits `
  --candidates $Candidates `
  --feature-cache-dir $FeatureCache `
  --ledger $Ledger `
  --evidence-role "primary-consumed-nested-estimate" `
  --resume
```

正常完成后，`primary-report.json`、`primary-complete` ledger event 和 `primary_complete` state 三者必须
同时存在，完整 study 禁止再次 evaluate。唯一例外是进程恰好在 report 写完、complete event/state 写入前
崩溃：相同输入的 `--resume` 只允许重验六个已有 fold result、重算 report aggregate 并补齐 event/state，
绝不会再次运行 outer solver。最终报告只聚合六个 primary folds，`freshProofEligible` 固定为 `false`。

## 8. post-outer diagnostic：独立 replay `new357`

primary 完整结束后，使用独立 replayer，而不是向已封存 primary workDir 写入 diagnostic。它会先验证
primary 的六折结果、selection locks、3388 条 primary feature proof、357 条 `new357` feature proof，然后
在单独目录创建自己的 immutable diagnostic lock：

```powershell
$PostOuterRunner = "scripts/run_rkb_post_outer_diagnostic.py"
$PostOuterStudyId = "$StudyId-post-outer-new357-v1"
$PostOuterWorkDir = "grid-analysis-lab/rkb-rekordbox-benchmark/post-outer-diagnostics/$PostOuterStudyId"

& $Python $PostOuterRunner `
  --study-id $PostOuterStudyId `
  --parent-study-id $StudyId `
  --parent-work-dir $WorkDir `
  --work-dir $PostOuterWorkDir `
  --splits $Splits `
  --candidates $Candidates `
  --feature-cache-dir $FeatureCache `
  --feature-cache-dir $New357FeatureCache
```

该命令读取六个 immutable selection locks，把其中选中的 config 按执行 SHA 去重后全部 replay；不会在
`new357` 上再选一次最佳 config，也不会修改 parent 的 `primary-report.json` 或 `state.json`。输出固定在
`$PostOuterWorkDir`：`diagnostic-study-lock.json`、`diagnostic-report.json` 和独立 state。

报告必须同时写明 `selectionPerformed = false`、`primaryAggregateEligible = false`、
`freshProofEligible = false`、`parameterSelectionAllowed = false`。如果
`diagnosticSolverMatchesPrimary = false`，它只是一份由当前封存诊断代码生成的回放记录，不能与 primary
aggregate 混合，更不能据此调参或宣称提升。

`new357` 也必须先按第 3 节完整重建为 357 条强 instance identity，才允许运行这条命令；禁止拿局部
结果冒充整批 diagnostic。

## 9. 怎么读结果而不继续过拟合

只看预注册 aggregate gate，不从六个 outer folds 中挑一折、挑一种错误类型或挑一个 config 继续包装
“提升”：

- `minimumPositivePrimaryFoldCount >= 4` 才满足多数批次同向；
- macro 净增必须达到 manifest 预注册下限；
- 最差 fold 不能跌破预注册下限；
- error、pass-to-fail、BPM 大错和 downbeat failure 分别按各自最坏 fold 审核；
- 任一 outer error 都会让示例 aggregate gate 失败；
- `new357` 的任何 diagnostic 指标都不得改变六个 selection locks 或 primary aggregate。

这套结果只回答“预注册选择流程在六个已消费批次间能否稳定泛化”。production 最终配置需要另走
all-consumed final-fit；真正的版本晋级仍必须等待下一批未曝光 fresh 数据，并在首次完整曝光后立即把
该批转为 consumed。
