# Rekordbox nested LOBO 防过拟合合同

## 1. 目的与边界

本合同约束未来的 nested Leave-One-Batch-Out runner。它只回答：一个预注册的训练/选择流程在
历史 consumed 批次间是否稳定。它不是 fresh proof，也不能把已经看过的 outer fold 重新包装成
未触碰验证集。

当前权威输入：

- canonical `rkb-dataset-splits-current.json`；
- 其 `leaveOneBatchOut` membership、`instances`、`families`、`batchEvidencePolicies`；
- parent split 文件 SHA、registry stable content SHA、truth source SHA、assignment/policy SHA；
- 带完整 instance identity 与 provenance 的 benchmark、feature cache 和 candidate rows。

禁止 runner 自己重新按文件名、category、artist、来源目录或 benchmark 结果分组。split 文件已经是
membership 唯一权威源。

## 2. 证据角色

每个 batch 的证据角色只能从 `batchEvidencePolicies` / `leaveOneBatchOut` 读取：

- `primaryAggregateEligible = true`：可以进入 primary nested aggregate；
- `primaryAggregateEligible = false`：不能成为 nested fold，只能在 primary locks 冻结后 replay；
- `freshProofEligible` 对全部历史 LOBO fold 固定为 `false`。

当前 `new357` 必须满足：

```json
{
  "evaluationRole": "diagnostic-development-reference",
  "primaryAggregateEligible": false,
  "freshProofEligible": false
}
```

建议锁死当前 diagnostic 权限：

```json
{
  "diagnosticBatchPolicy": {
    "mayTrainWhenInDevelopmentTrain": false,
    "mayEnterPrimaryFitOrTune": false,
    "mayAffectPrimarySelectionObjective": false,
    "mayEnterPrimaryAggregate": false,
    "maySatisfyPositiveFoldGate": false
  }
}
```

即：parent split 中即使把 `new357` 实例列在某个 fold 的 `developmentTrain` / `developmentTune`，
primary runner 也必须按 batch policy 过滤掉。它不能参与模型 fit、阈值/超参选择、晋级门槛或 aggregate。
只有全部 primary selection locks 冻结后，才允许用已锁配置做单列 diagnostic replay。

## 3. 顶层 immutable study lock

runner 在计算任何 outer 指标前必须写入不可变 study lock。至少包含：

```json
{
  "type": "rkb-nested-lobo-study-lock",
  "schemaVersion": 1,
  "studyId": "...",
  "evidenceRole": "primary-consumed-nested-estimate",
  "parentSplitPath": "...",
  "parentSplitFileSha256": "...",
  "registrySha256": "...",
  "truthSourcesSha256": "...",
  "splitAssignmentsSha256": "...",
  "audioIsolationPolicySha256": "...",
  "candidateSetSha256": "...",
  "featureContractSha256": "...",
  "solverContractSha256": "...",
  "selectionPolicySha256": "...",
  "foldPlanSha256": "...",
  "primaryFoldIds": ["..."],
  "diagnosticReplayBatchIds": ["new357"],
  "outerResultsMayTuneRules": false,
  "freshProofEligible": false,
  "lockHash": "sha256(canonical locked payload)"
}
```

`candidateSetSha256` 必须覆盖全部候选配置、顺序无关的 canonical config、模型/特征版本、阈值网格、
rank limit、mode 和 complexity rank。禁止看完某个 outer fold 后追加阈值或 guard。

候选集合必须含一个明确的 no-op/baseline 配置。若所有可学习配置都比 baseline 差，selector 必须能够
选择 no-op，不能被迫挑一个负收益配置。

## 4. Fold membership 合同

只对每个 `primaryAggregateEligible=true` 的 `leaveOneBatchOut` row，runner 必须计算并锁定：

```json
{
  "batchId": "outer batch",
  "evaluationRole": "...",
  "primaryAggregateEligible": true,
  "parentDevelopmentTrainRosterSha256": "...",
  "parentDevelopmentTuneRosterSha256": "...",
  "primaryDevelopmentTrainRosterSha256": "...",
  "primaryDevelopmentTuneRosterSha256": "...",
  "excludedDiagnosticTrainRosterSha256": "...",
  "excludedDiagnosticTuneRosterSha256": "...",
  "outerHoldoutRosterSha256": "...",
  "excludedLeakageRosterSha256": "...",
  "foldMembershipSha256": "..."
}
```

roster hash 使用排序后的 `instanceId + isolationFamilyId + assignmentKey` 投影。每个 primary fold 先保留
parent 原始 membership 供审计，再派生仅含 `primaryAggregateEligible=true` batch 的 effective rosters。
必须验证：

1. train、tune、outer holdout 两两无 instance overlap；
2. outer holdout 的任何 `isolationFamilyId` 都不能出现在 train/tune；
3. `excludedDevelopmentIsolationFamilyLeakage` 与 parent split 完全一致；
4. parent train/tune/holdout 的并集与 parent fold membership 完全一致，不能按低置信、错误、
   `needReview` 或缺 cache 缩小分母；
5. effective train/tune 必须恰好等于 parent roster 过滤掉所有非 primary batch 后的结果；
6. 被过滤的 diagnostic train/tune roster 及 hash 必须写入 lock，禁止静默丢弃；
7. 所有 primary development batch 在 effective inner tune 中至少有一个实例，否则该 fold fail closed；
8. 输入顺序变化不能改变任何 roster hash。

## 5. 两阶段执行，禁止 outer 反向影响 selector

执行必须拆成两个全局阶段：

### 阶段 A：锁定全部 primary fold selection

只对 `primaryAggregateEligible=true` 的六个 outer folds：

1. 从 parent `developmentTrain` 过滤非 primary batch，仅把 effective primary train 传入训练函数；
2. 从 parent `developmentTune` 过滤非 primary batch，仅把 effective primary tune 传入选择函数；
3. outer truth label、outer category、outer benchmark metric 不得进入训练/选择进程的参数；
4. 为每个 fold 写 `selection-lock.json`，包含 selected config、model hash、inner metrics digest 和
   parent/effective/filtered roster hashes；
5. 六个 primary fold 的 selection lock 全部写完后，生成 `selectionPlanSha256`。

在所有 primary selection locks 完成之前，runner 禁止执行任何 outer evaluation 或 `new357` replay。
这样即使 fold 按顺序运行，
前一个 outer 结果也不能改变后一个 fold 的 selector。

### 阶段 B：一次性 outer evaluation

只有 `selectionPlanSha256` 已冻结后才能开始：

1. 每个 primary fold 只使用自己锁定的 model/config 对 outer holdout 推理一次；
2. outer 结果只能用于汇报、否决和 aggregate，不能重新训练、扫阈值、改 objective 或生成新 guard；
3. 每个 outer result 必须绑定 selection lock、truth contract、feature/benchmark provenance 与正文 digest；
4. 完整 outer result 存在后，禁止 `--resume` 或覆盖重跑该 fold。

每个 primary fold 可以选择不同 config；nested LOBO 衡量的是“预注册选择流程”的泛化，而不是从 outer 结果中
挑出一个全局最佳 config。最终 production config 必须另走 all-consumed final-fit，并等待下一批 fresh。

### 阶段 C：`new357` 单列 diagnostic replay

`new357` 不运行自己的 fit/tune，也不生成第七个 nested selection lock。六个 primary fold 的
selection locks 全部冻结后，runner 才可以把每个已锁 model/config 分别 replay 到 `new357`：

1. 六个 replay 全部报告，禁止按 `new357` 指标挑“最佳 fold config”；
2. replay 只绑定既有 primary selection lock，不允许新训练、校准阈值或重排 config；
3. replay 结果位于 `diagnosticReplays.new357`，不进入 primary macro/worst/positive 或晋级 gate；
4. 任一 primary lock 改变时，旧 replay provenance 失效；
5. `new357` replay 仍然 `freshProofEligible=false`。

## 6. Inner tune selection objective 与 deterministic tie-break

selection policy 必须作为数据写入 lock，不能只存在代码注释。对每个候选 config，在每个
primary development batch 的 inner tune 上计算：

- `trackCount`：完整 frozen tune 分母；运行错误计入未通过，禁止丢行；
- `netStrictAccuracyDeltaRate = (selectedPass - baselinePass) / trackCount`；
- `passToFailRate = passToFail / trackCount`；
- `switchRate = switchCount / trackCount`；
- BPM 大错率增量、downbeat failure 增量、error count；
- 是否触发预注册 catastrophic threshold。

effective inner train/tune 中不得出现 `new357` 或任何其他非 primary batch；发现即 fail closed。

候选按以下 lexicographic objective 选择，方向不可更改：

1. 最小化 `catastrophicViolationBatchCount`；
2. 最大化 primary inner batches 的最差 `netStrictAccuracyDeltaRate`；
3. 最大化 primary inner batches 的 unweighted macro `netStrictAccuracyDeltaRate`；
4. 最大化 `positivePrimaryInnerBatchCount`，严格 `delta > 0` 才算正向，零不算；
5. 最小化 macro `passToFailRate`；
6. 最小化 overall `switchRate`；
7. 最小化预注册 `complexityRank`；
8. 若仍相同，按 canonical `configSha256` 字典序升序。

catastrophic thresholds 也必须写进 selection policy，至少覆盖：

- `maximumErrorTrackCount`；
- `maximumPassToFailRate`；
- `maximumBpmBigErrorRateIncrease`；
- `maximumDownbeatFailureRateIncrease`。

这些值可以由实现者在首次 primary study 前确定，但运行后不得修改。no-op 配置的所有 delta 为零，
因此任何最差 inner batch 为负的配置不能靠大批次 pooled gain 挤掉 baseline。

严禁：

- 以 pooled track count 代替 batch macro/worst objective；
- 根据 outer 结果更换 objective 次序；
- 依赖 Python dict/输入列表顺序解决平局；
- 把 `fileName`、artist、title、path、truth、category、split/batch identity 当模型特征；
- 根据 outer 失败类型临时扩充 candidate grid。

## 7. Outer 指标与 primary aggregate

每个 outer fold 必须公开：

- 完整 `trackCount`、baseline/selected strict pass、strict accuracy；
- `netPassDelta` 与 `netStrictAccuracyDeltaRate`；
- `failToPass`、`passToFail`、switch count/rate；
- error count/rate；
- BPM 大错 count/rate 与相对 baseline 增量；
- downbeat failure count/rate 与相对 baseline 增量；
- category migration；
- selected config/model/selection lock hash；
- outer result body digest。

primary aggregate 只能由 `primaryAggregateEligible=true` 的完整 folds 生成：

```json
{
  "primaryFoldCount": 6,
  "completedPrimaryFoldCount": 6,
  "positivePrimaryFoldCount": 0,
  "neutralPrimaryFoldCount": 0,
  "negativePrimaryFoldCount": 0,
  "macroBaselineStrictAccuracy": 0.0,
  "macroSelectedStrictAccuracy": 0.0,
  "macroNetStrictAccuracyDeltaRate": 0.0,
  "worstFold": {
    "batchId": "...",
    "netStrictAccuracyDeltaRate": 0.0,
    "passToFailRate": 0.0
  },
  "microTotalsDiagnosticOnly": {},
  "freshProofEligible": false
}
```

聚合规则：

1. macro 是每个 primary fold rate 的不加权平均，不能让 `current1407` 因歌曲多支配结论；
2. worst fold 先按 `netStrictAccuracyDeltaRate` 升序，平局时 `passToFailRate` 更高者更差，再按
   `batchId` 字典序；
3. `positivePrimaryFoldCount` 只统计严格正增，默认“多数同向”至少为
   `floor(primaryFoldCount / 2) + 1`；
4. micro pooled totals 可以报告，但字段必须明确为 diagnostic，不能替代 macro/worst/positive gate；
5. 缺任一 primary fold、重复 fold、fold error 或 provenance 不一致时，aggregate fail closed；
6. `new357` 只能位于 `diagnosticReplays`，不得改变 primary fold count、macro、worst 或 positive count；
7. 所有晋级阈值必须在 study lock 中预注册，例如 minimum positive folds、minimum macro delta、
   minimum worst-fold delta、maximum worst-fold BPM/downbeat/pass-to-fail regression。

LOBO 即使全部通过，也只产生 consumed nested development estimate。production 晋级仍需独立 fresh。

## 8. Resume、provenance 与结果防篡改

建议状态机：

```text
planning -> primary_selections_locked -> outer_running -> primary_complete -> diagnostic_complete
```

规则：

- 同一 run directory 的任何 lock hash 漂移都必须拒绝 resume，不能自动新建配置继续；
- `planning` 阶段只能补齐 primary selection lock；已存在的 lock 必须逐字段/正文 hash 一致；
- `primary_selections_locked` 后 candidate set、objective、fold plan、truth、registry、feature、solver
  任一变化都拒绝；
- `outer_running` 只允许恢复 provenance 完全一致的未完成 shard；
- outer complete 后禁止重跑/覆盖该 fold；
- `new357` replay 只能在 `primary_selections_locked` 后运行，且只能引用既有 primary selection locks；
- merge 必须验证每个 shard 的 truth roster、result identity、configuration provenance 和正文 digest；
- primary aggregate 必须绑定六个 primary fold result digest 的排序列表；diagnostic replay digest 单独绑定，
  输入顺序变化不得改变任一 aggregate hash。

为了阻止“看完 outer 再改规则并重跑，还继续声称 primary”，应维护 append-only outer exposure ledger：

```json
{
  "datasetContractSha256": "...",
  "studies": [
    {
      "studyId": "...",
      "studyLockHash": "...",
      "selectionPlanSha256": "...",
      "exposedOuterFoldIds": ["..."],
      "completedAt": "..."
    }
  ]
}
```

同一 dataset contract 已存在不同 lock 的 outer exposure 后，新 study 只能声明
`post-outer-development-diagnostic`，不得再输出 `primaryNestedEstimateEligible=true`。只有新的 frozen
dataset contract 才能恢复 primary claim。

## 9. 必须覆盖的测试矩阵

| ID | 场景 | 预期 |
| --- | --- | --- |
| L01 | 合法 membership、六个 primary selection 先锁定、随后 outer | 通过 |
| L02 | outer instance 出现在 inner train/tune | 拒绝 |
| L03 | 不同 instance 但 outer isolation family 泄漏到 development | 拒绝 |
| L04 | parent split / fold membership / leakage roster 任一漂移 | 拒绝 |
| L05 | 缺 primary development batch 的 inner tune | 拒绝 |
| L06 | 输入 instance/config/fold 顺序打乱 | selection 与 hash 完全不变 |
| L07 | 候选集中没有 no-op | 拒绝 |
| L08 | pooled gain 大但某 primary inner batch 为负 | no-op 或 worst 更好的配置胜出 |
| L09 | worst 相同、macro 不同 | macro 更高者胜出 |
| L10 | worst/macro 相同、正向批次数不同 | 正向批次更多者胜出 |
| L11 | 指标完全相同、complexity 不同 | complexity 更低者胜出 |
| L12 | 全部相同且输入顺序不同 | config SHA 字典序较小者胜出 |
| L13 | parent train/tune 含 `new357`，effective roster 未过滤 | 拒绝 |
| L14 | 过滤后 roster/hash 与 batch policy 可复算 | 通过并锁定 excluded diagnostic roster |
| L15 | `new357` 被送入 fit/train 或 tune selector | 拒绝 |
| L16 | 修改 `new357` label/metric 试图反转 selector | 六个 primary selected configs/hash 不得变化 |
| L17 | `new357` 被加入 primary macro/worst/positive | 拒绝 |
| L18 | primary selection locks 未齐就运行 outer 或 `new357` replay | 拒绝 |
| L19 | `new357` replay 后按其结果挑一个最佳 config | 拒绝；必须保留六个已锁配置的全部 replay |
| L20 | 早期 outer 结果试图改变后续 fold config | selectionPlan hash 不变，否则拒绝 |
| L21 | outer 结果完成后 resume/re-run | 拒绝 |
| L22 | 未完成 outer shard、全部 provenance 相同 | 允许 resume |
| L23 | resume 时 truth/registry/feature/solver/candidate/objective 任一漂移 | 拒绝 |
| L24 | shard/result 正文被改但 summary 未改 | digest 校验拒绝 |
| L25 | aggregate 缺 fold、重复 fold或混入另一个 study lock | 拒绝 |
| L26 | 大批次 pooled micro 正增、unweighted macro 为负 | macro 必须报告负值 |
| L27 | worst delta 平局但 pass-to-fail 不同 | pass-to-fail 更高者为 worst |
| L28 | 3 正、3 零或负（6 primary） | 不满足“多数同向”；至少需要 4 正 |
| L29 | error/低置信/needReview 行被从 denominator 删除 | count/roster 校验拒绝 |
| L30 | catastrophic threshold 在运行后修改 | policy hash 不同，拒绝 resume/aggregate |
| L31 | outer 指标触发重新训练 callback | 拒绝；outer 只能否决/汇报 |
| L32 | 同 dataset contract 第二个不同 lock study 声称 primary | exposure ledger 拒绝 |
| L33 | 第二个 study 明确标为 post-outer diagnostic | 可运行，但 primary claim 固定 false |
| L34 | 六个 primary folds 完成，`new357` 仅 replay | 输出 macro/worst/positive + 单列六配置 replay |

## 10. 与现有代码的映射和已知缺口

- `build_rkb_rekordbox_dataset_splits.py` 已提供权威 outer/inner membership；runner 不应重算 split。
- parent membership 会把 diagnostic batch 留在 development 视图；primary runner 必须再按
  `batchEvidencePolicies.primaryEvaluationEligible` 过滤 effective train/tune，并锁定过滤前后 roster。
- `rkb_dataset_contract.py` 已能锁 truth、registry、feature/benchmark provenance；nested study/fold/result
  lock 可复用其 canonical hash 和 identity projection 口径。
- `run_parallel_rkb_rekordbox_benchmark.py` 已有 shard resume/provenance 校验；nested runner 必须额外绑定
  fold selection lock，不能只验证 benchmark CLI 参数。
- `rkb_phase_ranker_diagnostic.py::_score_config_for_tune` 的“先最差、再总收益、再少切换”可作为参考，
  但当前函数硬编码 current/blind，且没有 study-level outer exposure 防线，不能原样冒充 nested LOBO。
- `rkb_beatgrid_candidate_lab.py` 负责 audio candidate 构建，不应读取 outer truth 来缩小 candidate set；
  runner 必须使用全量、预注册 candidate set hash。
- 当前 split 未单独写每个 fold 的 membership hash，但 parent split 文件 SHA 已绑定正文；runner 应在
  study lock 中派生并写入 fold membership hash，无需为此修改 split builder。

## 11. 交付验收清单

runner 只有同时满足以下条件，才可以把输出称为 nested LOBO result：

- 六个 primary fold selection locks 在任何 outer exposure 或 diagnostic replay 前完成；
- objective/tie-break/candidate set/catastrophic thresholds 全部可重算且有 hash；
- outer 与 inner instance/isolation family 零 overlap；
- `new357` 没有进入 fit/train、tune selection、晋级门槛或 aggregate，只做锁后 replay；
- 6 个 primary folds 全部完成，macro/worst/positive count 可复算；
- resume、shard、result、aggregate provenance 全部 fail closed；
- outer 结果未触发同一 study 内任何参数或规则变化；
- exposure ledger 允许当前 evidence claim；
- 输出明确 `freshProofEligible=false`。

缺任一项，只能叫 diagnostic replay，禁止写“多数 LOBO 同向”“最差 fold 已通过”或“无过拟合证明”。
