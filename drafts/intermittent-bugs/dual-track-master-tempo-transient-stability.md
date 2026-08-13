# 双轨 Master Tempo 瞬态稳定与 Keylock 算法长期维护手册

状态：SoundTouch 周期性瞬态漂移已确认；免费泛化方案待验证

首次记录：2026-08-13

最近更新：2026-08-13

影响范围：FRKB 双轨模式中 Master Tempo/Keylock 的实时变速、处理器时间契约、双 Deck 相对瞬态、离线评估器和后续通用算法选型。

## 这份文档的用途

这是一个独立的算法质量问题，不负责维护联结起播、Rekordbox 网格、PCM 时间基或 transport 状态机。以后遇到“逻辑拍点没漂、但人耳听到轻微周期性跑马”的问题，先读本文件；不要把 SoundTouch、Signalsmith 或 Rubber Band 的质量问题混入双轨时间基修复。

本文件记录已验证的现象、评估器陷阱、成熟开源路线、许可边界和下一步实验约束。任何候选算法都必须以真实输出 PCM 和通用样本集验收，不能只看游标、输出帧数或 UI 网格。

## 已确认现象与根因边界

### 1. 新现场不是网格、联结或逻辑播放头重新漂移

2026-08-13，用户继续用 `CODER Device Library/未完Set/abyss` 第二、第三首叠歌：上轨 `Push (Original Mix)` 为 134 BPM，下轨 `Rollende Technodingen (Original Mix)` 从 131 BPM 变速到 134 BPM。两轨联结、逻辑网格和 Master Tempo 都开启时，听感表现为非常轻微、周期性的“先稳一段、跑马几下、又恢复”。

决定性 A/B 是：只关闭变速轨 Bottom 的 Master Tempo 后，跑马感消失；重新开启后恢复。后续日志和离线真实 PCM 测量支持以下结论：

| 证据 | 观测 |
| --- | --- |
| 两轨逻辑网格相位 | 约 `-1.25ms ～ +0.21ms`，没有相同幅度的周期漂移 |
| SoundTouch 输出内容对应的源时间误差 | 约 `-10.11ms ～ +5.88ms` |
| 源时间误差与 SoundTouch overlap offset | 相关系数约 `0.997` |
| 关闭 Bottom Master Tempo | 用户确认不再跑马 |
| SoundTouch 真实低频瞬态相邻跳变 P95 | 约 `7.48ms` |

因此，本轮确认的不是 BeatSync 数学错误，也不是 Pioneer 网格错误，而是 SoundTouch/WSOLA 在保持音高变速时会选择不同的波形重叠位置。总输出时长和逻辑游标可以完全正确，实际听到的 kick 瞬态仍可能在目标时间两侧移动数毫秒。两轨独立处理后，这种内容级时间移动会变成相对瞬态误差，听起来就是轻微且周期性的跑马。

这里必须长期区分三种“时间正确”：

1. **网格时间正确**：BeatSync 和联结的逻辑相位正确；
2. **处理器游标正确**：输入/输出帧数和累计播放位置正确；
3. **实际瞬态正确**：处理后 kick 的声学起音仍落在目标时刻。

前两项正确不能推出第三项正确。以后不能再用 `currentSec`、累计输出帧数或 UI 网格自洽证明 Master Tempo 听感已经通过。

### 2. QuickSeek 修复有效，但不能根治

FRKB 已将双轨实时 Master Tempo 的 SoundTouch QuickSeek 关闭。该修改提高了搜索精度，真实 30 秒样本的处理成本增加约 `15.7%～16.6%`，仍有约 `15.6x～15.8x` 实时吞吐；它修复了一个真实质量问题。

但 QuickSeek 只是 SoundTouch 内部的速度/搜索精度选项。关闭后，WSOLA 仍需要在候选重叠区选择波形位置，无法保证两个独立 Deck 的每个声学瞬态都严格映射到同一目标时刻。因此：

- 禁止把 QuickSeek 修复回退；
- 也禁止把“QuickSeek 已关闭”写成“SoundTouch 瞬态漂移已根治”；
- 新的周期跑马现场必须继续测实际输出内容，不只查配置是否生效。

## Signalsmith 实验结论

### 3. 固定延迟不是根因，瞬态稳定性才是指标

Signalsmith Stretch 是 MIT 许可、可免费集成的高质量保音高变速库。它明确报告 `inputLatency()` 与 `outputLatency()`，固定且可查询的延迟可以由宿主播放器通过预读、预滚和统一输出时间补偿；**固定延迟本身不是双轨跑马的根因**。真正需要验证的是处理后瞬态相对目标时间是否稳定。

对本次真实 Bottom 音频进行了 403 组参数搜索，Signalsmith 的最佳真实瞬态跳变 P95 约为 `5.17ms`，优于 SoundTouch 的约 `7.48ms`，但单纯换参数仍不能稳定达到目标 `2～3ms`。将动态误差校正直接送回 Signalsmith 的保音高变速接口也失败：正负方向、半幅和多种学习率的闭环渲染均变差，库会重新选择频谱相位路径并制造新的约 `6～10ms` 瞬态移动。这条控制方式已淘汰。

### 4. 离散时间补偿原型只能作为上限和对照组

随后完成的“Signalsmith + 离散时间补偿”原型使用了：

- 这首 Bottom 的理想时间参考；
- 固定 134 BPM 网格的主鼓/副层事件；
- 针对此样本选择的 DP 权重、`0.25ms` 状态、最大 `4.5ms` 切换和 3ms 交叉淡化。

在这对样本的 60 秒离线渲染中，五组事件的跳变 P95 达到约 `1.00～2.57ms`；123 次接缝只覆盖全曲约 `0.614%`，未见点击型一阶/二阶导数尖峰。这证明“主变速器 + 宿主瞬态稳定层”在机制上可行，但它不是生产方案：目标事件和参考时间来自这首歌，不能泛化到任意曲目，更不能直接搬入实时 transport。

长期约束：

- 禁止把该试听 WAV 或其参数称为“FRKB 泛化算法”；
- 禁止在正式源码中硬编码 134 BPM、固定主/副拍相位、歌曲时间点或本次 DP 参数；
- 禁止依赖“无 Master Tempo 理想参考音频”作为生产运行时输入；
- 该原型只作为客观上限、评估器校准和后续通用算法的对照组。

### 5. 评估器已经确认的陷阱

旧匹配器用“局部最大峰的 50%”筛选候选，在双峰事件中可能过滤掉离参考时刻最近的正确峰，再误选数毫秒外的更强峰，制造假的大跳变。已确认的例子中，正确峰位于约 `-0.79ms`、强度为参考的 `34.97%`；40% 门槛把它拒绝后误报约 `-8.37ms`，继而制造 `9.37ms` 假跳变。

后续固定规则：

- 事件身份必须由同一份参考事件列表锁定；
- 在合理相对强度门槛内，选择离参考时刻最近的峰；
- 至少并列报告 10%、20%、25%、30% 门槛；40% 只可作为错峰敏感性观察，不能单独否决候选；
- 改变事件最小间距后若整列事件身份发生变化，不能再把结果当作同一事件集的参数稳定性比较；
- 报告必须分别列出原始事件、原主鼓/副层、网格播种主鼓/副层，不能只给一个汇总 P95。

## Mixxx 的免费成熟路线调查

### 6. Mixxx 没有“修好 SoundTouch”，而是默认使用 Rubber Band

2026-08-13 核对 Mixxx `main` 源码（`9e670c1120cc82304c4d5dcaa11a36367c5d50c3`）：

- `EngineBuffer::KeylockEngine` 提供 `SoundTouch`、`RubberBandFaster`、`RubberBandFiner`、`RubberBandR3ShortWindow`；
- 编译时具备 Rubber Band 后，默认 Keylock 引擎是 `RubberBandFaster`；否则才回到 SoundTouch；
- Mixxx UI 直接把 SoundTouch 标为 “fastest, low quality”，Rubber Band Faster 标为 “fast, medium quality”，R3 MW/SW 分别标为最高/高质量；
- SoundTouch 路径仍开启 QuickSeek，源码还保留了音高变化可能带来约 `±2000 frames` 时移且待补偿的 TODO；这不是“SoundTouch 已被 Mixxx 根治”的证据。

复核入口：

- [`enginebuffer.h`](https://github.com/mixxxdj/mixxx/blob/main/src/engine/enginebuffer.h)：引擎枚举、质量标签和默认选择；
- [`enginebuffer.cpp`](https://github.com/mixxxdj/mixxx/blob/main/src/engine/enginebuffer.cpp)：运行时引擎切换；
- [`enginebufferscalerubberband.cpp`](https://github.com/mixxxdj/mixxx/blob/main/src/engine/bufferscalers/enginebufferscalerubberband.cpp)：Rubber Band 配置、start pad、start delay 和流式读写；
- [`enginebufferscalest.cpp`](https://github.com/mixxxdj/mixxx/blob/main/src/engine/bufferscalers/enginebufferscalest.cpp)：SoundTouch 路径与尚未补偿的时移 TODO。

Rubber Band 路径的关键不是隐藏的逐 kick 修补，而是完整遵守处理器时间契约：

1. 使用 `OptionProcessRealTime`；
2. R3 Finer 模式使用 `OptionEngineFiner | OptionChannelsTogether`，短窗口模式再加 `OptionWindowShort`；
3. reset 后先送入 `getPreferredStartPad()` 指定数量的静音，避免首个瞬态被淡入破坏；
4. 从输出中丢弃 `getStartDelay()` 指定的启动 padding；
5. 按 `getSamplesRequired()` 拉取输入，并按实际 retrieve 数量更新消耗位置。

当前源码中没有发现 Mixxx 对每个 kick 做类似本次离线 DP 的内容级时间纠偏。Mixxx 的可复用经验是：选择更合适的通用 Keylock 引擎，并正确处理其预读、启动 padding、固定延迟、变速参数生效边界和实际输入消耗量。

### 7. Rubber Band 是当前第一条源码可得的泛化候选，但许可尚未闭合

Rubber Band 源码是 GPL-2.0-or-later。Mixxx 自身也是 GPL 项目，因此可以自然地链接和分发 Rubber Band。FRKB 的情况不同：仓库根 `LICENSE` 和 `package.json` 当前声明 PolyForm Noncommercial 1.0.0，而 README 又写项目代码为 MIT；现有安装包虽包含 GPL 的 FFmpeg/Demucs 等组件，但独立程序/聚合分发与把 GPL 库直接链接进 FRKB native 模块不是同一个许可问题。

因此“不开商业授权、直接使用 GPL Rubber Band”目前只能列为待法律/许可审计的技术候选，不能写成已经可发布。前置问题至少包括：

- FRKB 自有代码的实际权威许可证到底是 PolyForm Noncommercial 还是 README 所写 MIT；
- Rubber Band 与 native 模块的链接方式是否要求相应组合工作按 GPL 提供完整对应源码；
- PolyForm 的非商业限制是否会与 GPL 的无附加限制原则冲突；
- 安装包、源码提供方式、构建脚本和 `THIRD_PARTY_NOTICES.md` 应如何更新。

这不是正式法律意见。下一轮可以先在不分发的本地隔离 benchmark 中验证技术效果；只有结果值得继续，才投入许可闭合工作。不能因为“商业授权要钱”直接排除技术评估，也不能因为“仓库已有 GPL 组件”跳过发布合规。

Rubber Band 是否解决本次听感仍未经过 FRKB 数据验证。Mixxx 使用它和官方提供 `OptionTransientsCrisp` 等能力，只能证明它是成熟候选，不能替代下述真实 benchmark。

## 免费泛化方案的长期执行路线

### 8. 第一阶段：复刻 Mixxx 的 Rubber Band 时间契约，不改正式播放链

下一次对话优先建立隔离 benchmark/桥接原型，正式 transport 保持不变。至少测试：

- Rubber Band Faster（Mixxx 默认）；
- Rubber Band R3 MW / `OptionEngineFiner`；
- Rubber Band R3 SW / `OptionEngineFiner + OptionWindowShort`；
- 立体声必须 `OptionChannelsTogether`；
- 严格实现 `getPreferredStartPad()`、`getStartDelay()`、`getSamplesRequired()` 和实际 retrieve/consume 记账；
- 记录固定输入延迟、输出延迟、CPU、内存分配、首个瞬态、连续变速参数更新、seek/reset/loop 后行为。

不要先把 Rubber Band 接入 FRKB UI，也不要先删 SoundTouch。先让同一输入、同一裁剪、同一时间参考的离线/流式输出可重复测量。

### 9. 第二阶段：用通用样本集证明泛化，不再围绕两首歌调参

当前 `Push / Rollende` 只能作为回归样本之一。样本集必须覆盖：

- 两个变速方向及不同 BPM 差；
- 稳定四拍 kick、切分鼓、break、弱低频、强人声、复音密集段；
- MP3/AAC/FLAC/WAV 和不同 encoder delay/time basis；
- paired-start、join-playing-deck、暂停恢复、切 master、seek、loop；
- 单轨 Master Tempo 音色与双轨相对瞬态两类指标。

每个候选至少报告：固定事件身份下的瞬态误差、相邻跳变 P95/Max、瞬态强度、声道相干性、输出长度、处理器延迟、实时倍率和 underrun。目标暂定为主要事件集 `jump P95 <= 3ms`、`jump Max <= 5ms`，同时不得以明显金属感、瞬态软化或高 CPU 换取数字通过。门槛可以在扩大样本集后修订，但修订必须写明数据依据，禁止为某个候选临时放宽。

### 10. 第三阶段分支

1. **Rubber Band 泛化通过**：再设计 FRKB 正式引擎抽象、双 Deck 统一延迟补偿、热切换、seek/reset 和回归测试；SoundTouch 暂保留为兼容模式，完成真实试听后再决定默认值。
2. **R3 质量通过但成本过高**：先优化 block、线程和短/中窗口策略，不回退到针对歌曲调参。
3. **Rubber Band 仍达不到门槛**：继续自研“通用瞬态稳定层”，但事件只能由当前输入和现有 beat grid 自动提取，不能使用理想参考音频；设计必须满足因果性、有限预读、固定可声明延迟和 seek/loop 可重置。
4. **免费方案均失败**：保留 SoundTouch QuickSeek-off 版本和明确质量边界，不用显示层、固定常数或自动关闭 Master Tempo 掩盖问题。

### 11. 当前明确禁止的捷径

- 不把本次两首歌的离线试听文件集成进正式代码；
- 不把 Signalsmith 的固定参数搜索结果泛化为所有歌曲默认值；
- 不靠连续微重采样追踪瞬态误差，否则会制造局部音高摆动；
- 不把两个 Deck 的逻辑相位强行抖动去追处理器内部的内容漂移；
- 不把固定算法延迟误判成不适合 DJ：可查询的固定延迟应由宿主补偿；
- 不在未完成 GPL 合规审计前提交 Rubber Band 二进制或源码；
- 不因 Mixxx 默认使用 Rubber Band 就跳过 FRKB 自己的真实 PCM 和双轨试听验收。

## 下一次对话的接手指令

1. 在隔离环境复刻 Mixxx 的 Rubber Band Faster、R3 MW、R3 SW 三种实时 Keylock 配置及其 start pad/start delay 契约；
2. 用通用样本集和校准后的瞬态评估器做数据对比，至少报告 P95/Max、延迟、实时倍率、underrun 和听感副作用；
3. 在客观通过前不改 FRKB 正式播放链，不删除 SoundTouch；
4. 若候选值得集成，再单独完成许可证、链接方式、源码提供方式和第三方声明审计。

## 维护规则

- 本文只维护 Master Tempo/Keylock 处理后的实际瞬态稳定性，不记录联结起播或时间基修复细节；相关内容见 [双轨混音对拍与听感错位长期维护手册](./dual-track-mix-alignment-long-term-maintenance.md)。
- 每次新实验必须标明样本、算法版本、参数、时间参考、评估器版本和是否为真实试听；不能把单曲结果写成泛化结论。
- 临时诊断日志默认只保留到现场验收结束，提交前清理普通 info/trace 日志；若用户明确要求长期保留，必须同时写明触发条件、字段含义和清理条件。
