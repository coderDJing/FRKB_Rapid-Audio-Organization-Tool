# Intel Stem Acceleration Draft

## 背景

当前项目的自动混音 `stem` 分离基于 Demucs。Windows 侧代码已经预留了多种运行时和设备探测逻辑，目标顺序是：

- `cuda`
- `xpu`
- `directml`
- `cpu`

但预留入口不等于真的可用。本草案用于整理 2026 年 3 月 12 日在当前开发机上的实际验证结果，明确：

1. Intel Arc GPU 能不能用于 Demucs `stem` 分离。
2. Intel AI Boost NPU 能不能用于当前这套 Demucs 流程。
3. 项目后续应优先走哪条技术路线。

## 当前代码现状

### 1. 运行时候选顺序

`src/main/demucs.ts` 在 Windows 上会按下面顺序搜索运行时目录：

- `runtime-cuda`
- `runtime-xpu`
- `runtime-directml`
- `runtime-cpu`
- `runtime`

### 2. 当前设备探测方式

`src/main/services/mixtapeStemSeparationProbe.ts` 里目前的设备探测逻辑主要依赖：

- `torch.cuda.is_available()`
- `torch.backends.mps.is_available()`
- `torch.xpu.is_available()`
- `torch_directml.device()`

兼容性探测则在 `src/main/services/mixtapeStemSeparationCompat.ts` 中通过下面两类关键算子做快速验证：

- `torch.randn(...)`
- `torch.fft.rfft(...)`

这意味着：

- 现有代码对 `cuda/mps/xpu/directml` 都是 PyTorch 路线探测。
- `xpu` 和 `directml` 已经有单独的关键算子 smoke test。
- 现有代码没有任何 OpenVINO / Windows ML / ONNX NPU 推理链。
- 当前 `MixtapeStemComputeDevice` 和 probe snapshot 结构里还没有 `npu`。

### 3. 当前打包资源现状

当前仓库的 `vendor/demucs/win32-x64` 目录中存在：

- `runtime`
- `runtime-cpu`
- `runtime-cuda`
- `runtime-directml`

当前仓库中不存在：

- `runtime-xpu`

也就是说，代码里虽然写了 `xpu` 候选，但实际打包资源并没有把 Intel XPU 运行时带进来。

## 本机验证环境

### 系统与设备

本次验证机器系统信息：

- `DisplayVersion`: `25H2`
- `CurrentBuild`: `26200`
- `UBR`: `7840`

本机关键设备：

- `Intel(R) Arc(TM) 130T GPU (16GB)`
- `Intel(R) AI Boost`

本机驱动版本：

- `Intel(R) Arc(TM) 130T GPU (16GB)`: `32.0.101.8132`
- `Intel(R) AI Boost`: `32.0.100.4082`

### 验证原则

- 不修改项目正式代码。
- 所有验证均在临时隔离环境中完成。
- 验证完成后删除全部临时环境和输出目录。

本次验证结束后，以下临时目录均已清理：

- `tmp/xpu-verify`
- `tmp/npu-verify`
- `tmp/xpu-out`

## 结论摘要

### 结论 1

Intel Arc GPU 可以跑 Demucs 的核心 `stem` 推理链，但项目当前没有把这条路接进正式运行时。

### 结论 2

Intel AI Boost NPU 可以被 OpenVINO 正常识别并执行 ONNX 推理，但当前项目这套 PyTorch Demucs 流程不能直接吃到 NPU。

### 结论 3

项目当前的 `runtime-directml` 在本机上对 Demucs 关键算子不兼容，现状下没有实际价值，仍会退回 CPU。

### 结论 4

如果后续只考虑当前开发机尽快提升 `stem` 分离性能，优先级应该是：

1. Intel Arc GPU `xpu`
2. Intel AI Boost `npu` 研究
3. CPU fallback

而不是继续优先押注 `directml` 或直接硬上 NPU。

## Intel Arc GPU 验证结果

### 1. XPU 基础可用性

在临时环境中安装官方 XPU 轮子后，验证结果如下：

- `torch`: `2.10.0+xpu`
- `torch.xpu.is_available()`: `true`
- `device_count`: `1`
- `device_name`: `Intel(R) Arc(TM) 130T GPU (16GB)`

说明 Intel Arc GPU 的官方 PyTorch XPU 栈在本机是可用的。

### 2. 关键算子验证

在 `xpu:0` 上完成了以下运算：

- `torch.fft.rfft`
- `torch.nn.functional.interpolate`

这一步很重要，因为当前项目的 DirectML 兼容性探测恰恰就是死在 `torch.fft.rfft` 上。

### 3. Demucs 核心前向验证

使用本地现成模型：

- `vendor/demucs/models/htdemucs.yaml`
- 对应权重文件

以及项目自带测试音频：

- `vendor/demucs/test-input.wav`

在临时环境中完成了 Demucs 核心前向，结果：

- 输入形状：`[1, 2, 88200]`
- 输出形状：`[1, 4, 2, 88200]`
- 输出设备：`xpu:0`
- 输出类型：`torch.float32`
- 推理耗时：约 `8.46s`

这说明：

- Demucs 真正的分离前向已经在 Intel Arc GPU 上跑通。
- 这不是单个算子试跑，而是已经过了模型前向这道坎。

### 4. CPU 与 XPU 数值对比

对同一段超短测试音频做了 CPU 与 XPU 对比，结果：

- CPU 耗时：约 `2.429s`
- XPU 耗时：约 `6.049s`
- `max_abs_diff`: `0.09448`
- `mean_abs_diff`: `0.02369`
- CPU 与 XPU 输出均为有限值

说明：

- 小样本下 XPU 不一定比 CPU 快，启动和调度开销会吃掉收益。
- 但输出是正常的，没有出现 NaN / Inf。
- 对真实较长音频，XPU 才有更大概率拉开性能差距。

### 5. 当前 XPU 落地的实际障碍

虽然 Arc GPU 推理链已跑通，但直接拿现在的项目去跑，仍有以下障碍：

#### 5.1 项目没有 `runtime-xpu`

正式运行时资源里没有 `runtime-xpu`，所以现有代码压根找不到 Intel XPU Python 环境。

#### 5.2 Demucs 4.0.1 与新 PyTorch 的 `torch.load` 默认行为冲突

`torch 2.6+` 之后 `torch.load()` 默认 `weights_only=True`，而 `demucs 4.0.1` 仍按旧行为工作，直接加载权重会报错。

这不是 XPU 独有问题，而是 Demucs 与新 PyTorch 的通用兼容问题。

#### 5.3 `torchaudio` 新版本默认走 `torchcodec`

CLI 直接跑 `demucs.separate` 时，`torchaudio` 新版本会优先走 `torchcodec` 音频加载链。没有配套 FFmpeg 共享库时，CLI 会死在音频解码，而不是死在 Demucs 推理本身。

这同样不是 XPU 本身的问题，但会妨碍项目直接升级到新 XPU 轮子。

## Intel AI Boost NPU 验证结果

### 1. OpenVINO 设备枚举

在临时环境中安装 `openvino 2026.0.0` 后，`ov.Core().available_devices` 返回：

- `CPU`
- `GPU`
- `NPU`

同时，`FULL_DEVICE_NAME` 返回：

- `Intel(R) AI Boost`

这说明本机的 Intel NPU 不是任务管理器瞎显示，OpenVINO 运行时可以真实识别到它。

### 2. NPU 推理验证

本次使用一个最小 ONNX 模型完成了：

- `compile_model(..., "NPU")`
- `infer(...)`

结果：

- `EXECUTION_DEVICES`: `NPU`
- 输出全为有限值

这说明：

- 本机 NPU 对 OpenVINO 推理是通的。
- 至少基础图推理已经能正常下发到 `Intel AI Boost`。

### 3. 为什么当前 Demucs 还是吃不到 NPU

当前项目的 `stem` 分离流程本质上是：

1. Python
2. PyTorch
3. Demucs
4. 设备选择：`cuda/xpu/directml/cpu`

这里没有：

- ONNX 导出链
- OpenVINO IR/ONNX 加载链
- NPU 编译和执行链

所以即便机器上有 `Intel AI Boost`，当前项目也不会自动把 Demucs 扔到 NPU 上跑。

## DirectML 路线现状

当前仓库内 `runtime-directml` 的元数据已经显示：

- `xpu = false`
- `directml_demucs_compatible = false`

本机复测也复现了同样现象：

- `torch_directml.device()` 可以拿到 `privateuseone:0`
- 但一执行 `torch.fft.rfft` 就报：
  - `Invalid or unsupported data type ComplexFloat`

也就是说：

- DirectML 不是完全不可用。
- 但它至少在当前 Demucs 关键算子链上不可用。
- 在现阶段继续把主要希望放在 DirectML 上，性价比不高。

## 跨平台默认试探顺序草案

### 原则

跨平台调度不要使用“一条全球死顺序”直接盲试全部后端。

正确做法是：

1. 先识别操作系统。
2. 再识别机器上实际存在的 GPU / NPU 类型。
3. 只对可能存在的后端做探测和短基准。
4. 成功后缓存本机最优后端，避免每次启动都全量乱试。

### macOS

macOS 侧默认试探顺序建议为：

- `MPS`
- `CPU`

这里的 `MPS` 包括两类机器：

- Apple Silicon Mac
- 带 AMD GPU 的 Intel Mac

这点要特别写死，因为老 Mac 上的 AMD 显卡不属于 `DirectML`，而应该归到 `MPS` 桶。

前提条件：

- `torch.backends.mps.is_available() = true`
- 通常要求 `macOS 12.3+`

如果 `MPS` 不可用，则直接走 `CPU`，不需要再试 `CUDA`、`XPU`、`DirectML`、`NPU`。

### Windows

Windows 侧默认试探顺序建议为：

- `CUDA`
- `XPU`
- `NPU`
- `DirectML`
- `CPU`

设备归类建议：

- `NVIDIA GPU` -> `CUDA`
- `Intel GPU` -> `XPU`
- `Intel AI Boost` 或其他可用 Windows NPU -> `NPU`
- `AMD GPU` -> `DirectML`
- 其他情况 -> `CPU`

这里的关键点是：

- `AMD` 在 Windows 上算 `DirectML`
- `AMD` 在 macOS 上算 `MPS`

两边不能混。

### 默认调度策略

因此，当前产品如果同时支持 Windows 和 macOS，默认调度规则建议写成：

1. `macOS`: `MPS > CPU`
2. `Windows`: `CUDA > XPU > NPU > DirectML > CPU`

如果后续增加首轮自动 benchmark，则应改成：

1. 先按平台筛掉不可能存在的后端
2. 再按上述顺序探测
3. 对成功后端做短基准
4. 缓存本机最快结果作为长期默认值

### 为什么不把 NPU 排到 GPU 前面

虽然 `NPU` 在命名上看起来更“AI 专用”，但对 `stem` 分离这类长音频、高吞吐张量负载，不应默认排在原生 GPU 后端前面。

原因：

- `CUDA` 和 `XPU` 更接近当前 Demucs / PyTorch 的主力运行路径
- `NPU` 更依赖模型导出、图编译和算子覆盖
- 即便机器上存在 `NPU`，也不代表它对当前模型一定比 GPU 更快

所以跨平台默认顺序里，`NPU` 应放在原生 GPU 后端之后，而不是之前。

## 落地改造蓝图

这一节不是分析，而是后续真正改代码时应遵守的施工蓝图。

目标不是一次把所有后端全做完，而是分阶段把高收益、低风险的路径先接稳，再把研究性质的能力隔离出来。

### 总体改造目标

最终希望把 `stem` 分离链路拆成四层：

1. 运行时准备层
2. 设备探测与排序层
3. 推理执行层
4. benchmark 与回退层

每层职责必须清晰，不能再把：

- 运行时打包
- 设备探测
- 兼容性兜底
- 音频解码
- 模型执行

全部糊在一个 `demucs.separate` CLI 调用里。

### 最终希望达到的状态

#### Windows

- `NVIDIA GPU` 走 `CUDA`
- `Intel Arc / Xe` 走 `XPU`
- `Intel AI Boost` 走 `NPU`
- `AMD GPU` 走 `DirectML`
- 上述均失败时走 `CPU`

#### macOS

- Apple Silicon Mac 走 `MPS`
- Intel Mac + AMD GPU 目标上也归到 `MPS`
- `MPS` 不可用时走 `CPU`

#### 重要说明

当前仓库的 `darwin-x64` profile 只有 `cpu`，没有 `runtime-mps`。

这意味着：

- 文档里的 `Intel Mac + AMD GPU -> MPS` 目前是目标规则，不是现状能力。
- 真要支持老 Mac AMD，需要额外补 `darwin-x64` 的 `runtime-mps` 运行时，并做真机验证。

这一点必须在实施时单独当任务处理，不能误以为代码里已经支持。

## 当前代码职责地图

为了后续改造不乱拆，先把现在几个关键文件的职责写死。

| 文件 | 当前职责 | 改造后建议职责 |
| --- | --- | --- |
| `src/main/demucs.ts` | 解析打包运行时目录与 Python 路径 | 只负责“运行时资源定位”，不负责设备判断 |
| `scripts/demucs-runtime-profiles.json` | 定义平台运行时 profile | 定义各平台各后端的安装源、版本、探测标签 |
| `scripts/prepare-demucs-runtimes.mjs` | 复制/安装 profile 运行时并写入元数据 | 继续负责构建 profile，但要补齐 `xpu/mps` 并明确 NPU 非 Demucs 运行时 |
| `scripts/ensure-demucs-runtime.mjs` | 检查并修复基础运行时 | 补充对 `xpu/mps` 的依赖完备性校验 |
| `src/main/services/mixtapeStemSeparationShared.ts` | 共享常量、超时、优先级、进程环境 | 扩展为设备优先级、benchmark 缓存、后端策略中心 |
| `src/main/services/mixtapeStemSeparationProbe.ts` | 实际运行时探测与兼容性探测 | 负责平台分流、设备分类、后端可用性快照 |
| `src/main/services/mixtapeStemSeparationCompat.ts` | 各后端关键算子快速验证 | 保持“最小关键算子 smoke test”职责 |
| `src/main/services/mixtapeStemSeparationRun.ts` | 调用 Demucs CLI、处理重试与回退 | 改造成主执行编排器，尽量减少 CLI 黑盒依赖 |
| `src/main/services/mixtapeStemQueue.ts` | 队列、进度、状态汇总 | 不直接知道后端细节，只消费探测和执行结果 |

## 当前代码里已经暴露出来的结构问题

### 1. 平台优先级函数还不够最终态

`resolveStemDevicePriority()` 当前大致是：

- `darwin -> ['mps', 'cuda', 'cpu']`
- `win32 -> ['cuda', 'xpu', 'directml', 'cpu']`

这有两个问题：

1. `Windows` 没把 `npu` 纳入正式优先级。
2. `darwin` 里还挂着 `cuda`，对当前项目没有现实意义。

后续应改成更明确的目标状态：

- `darwin -> ['mps', 'cpu']`
- `win32 -> ['cuda', 'xpu', 'npu', 'directml', 'cpu']`

### 2. 运行时 profile 和设备优先级没有完全对齐

当前 profile 文件里：

- `win32-x64` 有 `xpu` 入口，但没安装参数
- `darwin-arm64` 有 `mps`
- `darwin-x64` 只有 `cpu`

这会导致：

- 文档目标和现有打包产物脱节
- 探测逻辑可能说支持，但运行时压根没资源

### 3. 执行层过度依赖 `demucs.separate` CLI

当前 `runDemucsSeparate()` 的核心还是：

- 普通设备直接 `python -m demucs.separate`
- `directml` 走一层 bootstrap 再 `run_module`

这会把下面这些不稳定因素全带进正式逻辑：

- `torchaudio` 音频加载策略变化
- `torchcodec` / FFmpeg 依赖变化
- `torch.load(weights_only)` 默认值变化
- CLI 参数兼容性变化

### 4. 设备探测和模型兼容性探测是对的，但还不够抽象

当前 `probe` 层已经做了两件好事：

- 先跑“设备是否可见”
- 再跑“Demucs 关键算子是否可用”

这是正确方向，后续不要推倒重来。

要改的是：

- 把 `npu` 也纳入统一快照结构
- 把平台分流逻辑写得更硬一点
- 把 `benchmark` 结果也纳入快照或缓存层

### 5. 设备类型定义重复，后续加 `npu` 容易失配

当前 `MixtapeStemComputeDevice` 至少在两个地方各写了一份：

- `src/main/services/mixtapeStemSeparationShared.ts`
- `src/main/services/mixtapeStemQueue.ts`

而且两边现在都还是：

- `cuda`
- `mps`
- `xpu`
- `directml`
- `cpu`

这会带来两个直接问题：

1. 后续一旦加入 `npu`，很容易出现 probe、queue、日志、IPC 类型不同步。
2. 平台优先级和状态上报即便改对了一半，也可能被另一份 union 类型卡死。

所以在真正把 `npu` 引入正式类型前，应该先把设备枚举收敛到单一来源。

## 分阶段实施方案

### Phase 0：先把文档目标冻结

这一阶段不改功能，只统一术语和目标。

必须冻结的定义：

- `CUDA`: Windows Nvidia GPU 原生后端
- `XPU`: Windows Intel GPU 原生 PyTorch 后端
- `NPU`: Windows NPU 推理后端，目标是 OpenVINO / WinML，不是 PyTorch 字符串设备
- `DirectML`: Windows 兼容层后端，主要覆盖 AMD 和部分 Intel/其他设备
- `MPS`: macOS Metal 后端，覆盖 Apple Silicon 和目标上的 AMD Mac
- `CPU`: 统一兜底

验收标准：

- 文档中所有地方都使用这套术语
- 代码中新增类型和枚举时也沿用这套命名

### Phase 1：先把 Windows `XPU` 正式接进来

这是第一优先级，因为收益最大，且已被本机验证能跑 Demucs 前向。

#### 要改的内容

1. `scripts/demucs-runtime-profiles.json`
2. `scripts/prepare-demucs-runtimes.mjs`
3. `scripts/ensure-demucs-runtime.mjs`
4. `src/main/demucs.ts`
5. `src/main/services/mixtapeStemSeparationProbe.ts`

#### 实施要点

##### 1.1 补齐 `runtime-xpu` 的安装参数

不能继续让 `xpu` profile 是空壳。

至少需要：

- 指定 XPU wheel index
- 明确 `torch / torchaudio / torchvision` 版本
- 明确是否需要额外 Intel runtime 包

建议文档层先接受这样一个现实：

- `torch 2.10.0+xpu` 已在本机验证可用
- 但 `demucs 4.0.1` 与新 torch 的兼容问题仍需 bootstrap 修补

所以 profile 设计要把“运行时可安装”和“Demucs 可稳定运行”分开对待。

##### 1.2 让运行时元数据明确写出 XPU 结果

`.frkb-runtime-meta.json` 里至少要保留：

- `torch_version`
- `xpu`
- `xpu_demucs_compatible`
- 安装参数
- 生成时间

这样后续 debug 才能知道用户机器到底是：

- 没装好
- 看不到设备
- 设备可见但 Demucs 关键算子不兼容

##### 1.3 保持 `probe -> compatibility -> fallback` 这条链

`XPU` 不能因为安装好了就直接参与正式分离。

必须满足：

1. `torch.xpu.is_available() = true`
2. 关键算子兼容性通过
3. 实际模型 bootstrap 能跑

只要其中一层失败，就应该回退下一候选，而不是硬炸整个队列。

#### Phase 1 验收标准

- Windows Intel Arc 机器会生成 `runtime-xpu`
- 设备探测结果里 `xpuAvailable = true`
- `deviceCandidates` 中 `xpu` 会排在 `directml` 前
- 一首本地测试音频可以在 `xpu` 上完成完整 stem 任务
- 失败时能够自动回退到 `cpu`

### Phase 2：重构执行层，摆脱对黑盒 CLI 的过度依赖

这是第二优先级，因为不做这一步，后面 `xpu/npu/mps` 都会反复踩版本坑。

#### 当前建议的稳定执行链

推荐把执行链改造成：

1. `ffmpeg` 解码输入音频
2. 转为统一 waveform tensor
3. 直接调用 Demucs 模型前向
4. 用稳定的 wav 写出方式落盘

而不是继续依赖：

- `python -m demucs.separate`
- `torchaudio.load`
- `torchaudio.save`

#### 推荐原因

这样做可以主动绕开：

- `torchaudio` 默认解码策略变化
- `torchcodec` 对 FFmpeg DLL 的依赖
- CLI 参数和内部实现变化

#### 要改的内容

1. `src/main/services/mixtapeStemSeparationRun.ts`
2. 可能新增一个专门的 Python bootstrap 构造器模块
3. 可能新增一个统一的 waveform I/O 辅助模块

#### 设计建议

##### 2.1 统一 bootstrap 入口

目前只有 `directml` 走 bootstrap。

后续建议把：

- `cuda`
- `xpu`
- `directml`

都改成统一 bootstrap 入口，只是传入不同的 device 和 feature flags。

这样可以统一处理：

- `torch.load(weights_only=False)` 修补
- 模型加载
- waveform 输入
- 输出写盘

##### 2.2 不建议把复杂 Python 脚本永久写成超长 `-c` 字符串

当前少量 bootstrap 还能忍。

但后续如果要承载：

- waveform 解码
- model load patch
- device route
- output write

就不应该继续堆在一个内联字符串里。

建议选择下面两种之一：

1. 在仓库内放一个正式的 Python bootstrap 模板文件
2. 在 TS 里维护一个结构化的 bootstrap 生成器，并拆成小函数

文档倾向于方案 1，因为可读性和调试性更强。

##### 2.3 输出写盘建议

为了减少再踩音频库版本坑，输出建议优先落：

- WAV

并优先考虑：

- `soundfile`
- 或项目自己已有 FFmpeg 输出链

不要在改造早期同时追求：

- 多格式输出
- 高级元数据写回
- 全自动编码器切换

先把 wav 稳定写出来。

#### Phase 2 验收标准

- `xpu` 分离不再依赖 `torchaudio.load`
- `torch.load(weights_only)` 兼容问题有统一解决点
- `directml`、`cuda`、`xpu` 共用同一套执行主干
- 日志能明确打印：运行时、设备、模型、耗时、失败原因

### Phase 3：补齐跨平台优先级和 benchmark 缓存

这一阶段的目标是让“默认选哪个后端”不再只靠写死顺序。

#### 要改的内容

1. `src/main/services/mixtapeStemSeparationShared.ts`
2. `src/main/services/mixtapeStemSeparationProbe.ts`
3. `src/main/services/mixtapeStemQueue.ts`
4. 可能新增 benchmark cache 存储模块

#### 设计目标

首次运行时：

1. 先按平台筛候选
2. 再做可用性探测
3. 对前 2 到 3 个候选做短 benchmark
4. 缓存最快后端

后续运行时：

1. 先读取缓存
2. 再快速验证缓存后端是否仍可用
3. 不可用时再触发重新 benchmark

#### benchmark 至少记录的指标

- backend
- runtimeKey
- 音频时长
- 冷启动耗时
- 热启动耗时
- 总分离耗时
- 是否发生 fallback
- 是否失败

#### benchmark 样本建议

至少准备三档：

- `30s`
- `3min`
- `8min~10min`

因为：

- 太短的音频只会放大启动开销
- 太长的音频才更接近真实混音工作负载

#### Phase 3 验收标准

- 同一台机器第二次运行时不会无脑全量试探
- benchmark 结果可缓存并可失效
- 用户日志中能看到最终选中的后端与原因

### Phase 4：NPU 作为独立研发分支推进

这一步不要混进前面 XPU 落地的主线里。

#### 研发目标

验证下面这件事是否成立：

- 某个可导出的 stem 分离模型
- 在 OpenVINO / Windows ML 上
- 跑在 `Intel AI Boost`
- 在真实长音频上具有可接受的吞吐和音质

#### 不建议直接做的事

- 直接把现有 PyTorch Demucs 代码塞到 NPU 路由里
- 在没有 ONNX 导出与算子覆盖验证前，把 `npu` 放入正式自动路径

#### 建议先做的子任务

1. 选模型
2. 导出 ONNX
3. 做 OpenVINO 编译与基础推理
4. 跑长音频 benchmark
5. 再决定是否纳入正式 `auto` 策略

#### NPU 最终进入正式自动路径的前提

必须同时满足：

1. 模型导出稳定
2. 编译稳定
3. 真实音频性能优于 CPU
4. 音质偏差在可接受范围
5. fallback 逻辑清晰

否则 NPU 只能保留为：

- 实验开关
- 指定模型专用能力
- 或研究分支

## 推荐改动清单

这一节直接按“后面真开始改造时的任务拆单”来写。

### 必改文件

- `src/main/demucs.ts`
- `src/main/services/mixtapeStemSeparationShared.ts`
- `src/main/services/mixtapeStemQueue.ts`
- `src/main/services/mixtapeStemSeparationProbe.ts`
- `src/main/services/mixtapeStemSeparationCompat.ts`
- `src/main/services/mixtapeStemSeparationRun.ts`
- `scripts/demucs-runtime-profiles.json`
- `scripts/prepare-demucs-runtimes.mjs`
- `scripts/ensure-demucs-runtime.mjs`

### 高概率会新增的文件

- `src/main/services/mixtapeStemBenchmarkCache.ts`
- `src/main/services/mixtapeStemBackendPolicy.ts`
- 一个正式的 Python bootstrap 模板文件

### 低优先级再考虑的文件

- 与设置页相关的后端强制选择 UI
- 与日志展示相关的 renderer 提示

这些可以晚于主干能力落地。

## 建议的实施顺序与提交边界

后续真正开始写代码时，建议不要一个大改造全塞一起，而是按下面边界拆提交。

### 提交 1

只做运行时 profile 和 `xpu` 打包准备，不改正式执行链。

目标：

- 用户安装包里能带上 `runtime-xpu`
- probe 元数据可见

### 提交 2

只改 probe 和优先级，不改输出链。

目标：

- `Windows` 能排出 `cuda > xpu > npu > directml > cpu`
- `macOS` 能排出 `mps > cpu`

### 提交 3

重构执行链，统一 bootstrap，解决 `weights_only` 和 `torchaudio/torchcodec` 问题。

目标：

- `xpu` 真能跑完整 stem 分离

### 提交 4

补 benchmark cache 和策略缓存。

目标：

- 避免每次启动都重新乱试

### 提交 5

单独做 NPU 实验链。

目标：

- 不影响主线稳定性

## 第一轮开工单（XPU）

如果现在就开始改代码，第一轮建议只做 `Windows Intel Arc -> XPU` 正式接入，不要把 `NPU` 和 waveform-first 重构混进来。

### 范围

- 做 `runtime-xpu` 打包与自检
- 做 `xpu` probe、兼容性判定、元数据写回
- 保持现有 `cpu` fallback
- 暂不改 `NPU` 自动路径
- 暂不重构 `runDemucsSeparate()` 为 waveform-first

### 具体施工项

1. `scripts/demucs-runtime-profiles.json`
   - 给 `xpu` 补完整安装参数，而不是继续留空壳。
2. `scripts/prepare-demucs-runtimes.mjs`
   - 让 `runtime-xpu` 真正可构建，并把 `xpu/xpu_demucs_compatible` 写进元数据。
3. `scripts/ensure-demucs-runtime.mjs`
   - 把 `xpu` 依赖完备性纳入校验与自动修复路径。
4. `src/main/services/mixtapeStemSeparationProbe.ts`
   - 继续保留 `probe -> compatibility -> fallback` 链，但让 `runtime-xpu` 能被正式选中。
5. `src/main/services/mixtapeStemSeparationShared.ts`
   - 作为设备枚举与优先级的唯一来源，避免后面加 `npu` 时类型乱飞。
6. `src/main/services/mixtapeStemQueue.ts`
   - 清掉重复设备 union，改为消费共享类型。

### 第一轮验收观察点

- `vendor/demucs/win32-x64` 实际出现 `runtime-xpu`
- `.frkb-runtime-meta.json` 能看到 `torch_version`、`xpu`、`xpu_demucs_compatible`
- probe 日志里 `runtimeKey` 不再只会落到 `runtime-cpu` / `runtime-directml`
- Intel Arc 机器上 `deviceCandidates` 中 `xpu` 会排在 `directml` 前
- 一段本地测试音频失败时仍能回退到 `cpu`

## 验收清单

这份清单是后面每轮改造结束都要回头核对的。

### 功能层

- Windows Nvidia 机器能稳定走 `CUDA`
- Windows Intel Arc 机器能稳定走 `XPU`
- Windows AMD 机器能稳定走 `DirectML` 或明确回退 `CPU`
- macOS Apple Silicon 机器能稳定走 `MPS`
- 目标上的 Intel Mac + AMD 机器若支持，则走 `MPS`
- 所有平台失败时都能稳定回退 `CPU`

### 质量层

- 后端切换失败不会卡死队列
- 所有 fallback 都有可读原因
- 日志能追踪 runtime、device、model、duration、error
- benchmark 结果可持久化

### 性能层

- `xpu` 在真实长音频上至少不低于 CPU
- `cuda` 仍保持最高优先级
- `directml` 不因误判把用户锁死在慢路径

### 发布层

- 安装包实际包含目标运行时
- `ensure-demucs-runtime` 不会误删或漏装 profile
- profile 元数据能反映真实安装状态

## 目前仍然存在的开放问题

这些问题在正式开工前就应该知道，不要做到一半才骂娘。

### 1. Intel Mac + AMD 的 `MPS` 支持需要真机补证

文档目标上把它归到 `MPS`，但当前仓库并没有 `darwin-x64 runtime-mps`。

所以这件事在工程上仍然是：

- 目标规则明确
- 运行时打包未完成
- 真机验证未完成

### 2. `Demucs 4.0.1` 是否继续作为长期主模型

如果后面为了 `NPU` 或新 `XPU` 版本要付出大量 bootstrap 兼容成本，就要重新评估：

- 是继续围绕 `demucs 4.0.1` 修
- 还是选更易导出的模型

### 3. `DirectML` 是否保留为自动候选

从当前验证看，它更像兼容层而不是主力性能路线。

后续可以考虑两个策略：

1. 保留在 `auto` 中，但排在很后
2. 改成实验开关，不默认参与

这个取决于后续在 AMD Windows 真机上的实测结果。

## 技术判断

### 路线 A：把 Intel Arc GPU `xpu` 接进现有项目

这是最近、最现实、改造成本最低的方向。

建议目标：

1. 为 Windows 增加真正可用的 `runtime-xpu`
2. 让设备探测优先选择 `xpu`
3. 保留 `cuda` 和 `cpu`
4. 将 `directml` 降级为实验性备胎，甚至可以先不自动启用

必要工作：

1. 调整 `scripts/demucs-runtime-profiles.json`
2. 增加 `runtime-xpu` 准备脚本
3. 解决 `demucs 4.0.1` 与新 `torch.load` 的兼容问题
4. 解决 `torchaudio/torchcodec` 音频加载链问题

其中第 4 点最稳妥的做法不是继续赌 `torchaudio` CLI，而是：

- 由项目自己先用现有 FFmpeg 解码为 waveform
- 再把 waveform 喂给 Demucs

这样可以绕开一大坨版本兼容烂账。

### 路线 B：让 Intel AI Boost NPU 参与 `stem` 分离

这条路在技术上不是不可能，但已经不属于“小修小补”，而是独立研发项。

必要前提：

1. 选定可导出的分离模型
2. 建立 PyTorch -> ONNX 的稳定导出链
3. 验证 OpenVINO/NPU 的算子覆盖与性能
4. 重写现有设备探测和推理调度逻辑

风险点：

- Demucs 这类模型对复杂音频算子和张量操作依赖较重
- 即便能导出 ONNX，也不代表 NPU 有完整算子支持
- 最终可能只能部分子图上 NPU，剩余仍落 CPU/GPU

因此，NPU 路线不适合作为现有项目的第一优先级性能方案。

## 非目标

本草案阶段不建议：

- 继续优先押注 `runtime-directml`
- 把 NPU 接入当成当前版本的短平快任务
- 仅靠修改设备字符串就尝试“启用 NPU”

这些做法大概率只会把项目带回 CPU fallback，或者引入更多不可控兼容问题。

## 需要保留的事实结论

1. 当前项目现状吃不到 `Intel(R) AI Boost` NPU。
2. 当前项目现状也吃不到 Intel Arc GPU，因为没有正式的 `runtime-xpu`。
3. Intel Arc GPU 的 XPU 路线已经被本机验证为可行。
4. Intel AI Boost 的 OpenVINO NPU 路线已经被本机验证为可用。
5. DirectML 在当前 Demucs 关键算子链上不兼容。
6. 老 Mac 上的 AMD 显卡在设备归类上应视为 `MPS`，不应误归到 `DirectML`。

## 参考资料

- PyTorch XPU:
  - https://intel.github.io/intel-extension-for-pytorch/xpu/2.8.10+xpu/tutorials/getting_started.html
- Apple PyTorch Metal:
  - https://developer.apple.com/metal/pytorch/
- PyTorch MPS backend:
  - https://docs.pytorch.org/docs/stable/notes/mps
- OpenVINO NPU:
  - https://docs.openvino.ai/2025/openvino-workflow/running-inference/inference-devices-and-modes/npu-device.html
- OpenVINO 系统与硬件支持:
  - https://docs.openvino.ai/2025/about-openvino/release-notes-openvino/system-requirements.html
- ONNX Runtime WinML Execution Provider:
  - https://onnxruntime.ai/docs/execution-providers/WinML-ExecutionProvider.html
- Windows ML Overview:
  - https://learn.microsoft.com/en-us/windows/ai/windows-ml/overview

## 下一步草案

如果后续继续推进，建议直接产出两份后续文档：

1. `Intel Arc XPU 接入实施草案`
2. `Intel AI Boost NPU OpenVINO 研究草案`

前者面向短期落地，后者面向中期研发，不要混在一份实施文档里。
