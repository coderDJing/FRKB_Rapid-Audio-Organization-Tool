# Rekordbox RGB 大波形接手文档

更新时间：2026-05-31

## 目标

把 FRKB 横向浏览 / 编辑模式的大波形调到视觉上尽量接近 Rekordbox 的 RGB 大波形。

核心要求：

- 不依赖用户本机安装 Rekordbox，也不能直接读取 Rekordbox 分析结果作为运行时数据源。
- 可以参考本机 Rekordbox 作为研究真值，但 FRKB 必须能独立分析用户歌曲并渲染。
- RGB 颜色不要求和 Rekordbox 像素级一致，但要符合 Rekordbox RGB 波形的大体语义。
- 波形形状优先级高于颜色：听起来相近的鼓点 / 简单节奏，在 FRKB 里也应该呈现相近的大体形状。
- 鼓点音头要清楚：攻击起点应像 Rekordbox 一样保留明确竖直边缘，后半段可以平滑，以减少毛刺。
- 当前目标不是做 3-band 小波形，也不是直接复用 Rekordbox 数据，而是让 FRKB 自己的 RGB 大波形尽量接近 Rekordbox 的视觉结果。

## 参考真值和研究资产

本机 Rekordbox 数据库：

- `D:/PIONEER/Master/master.db`

本仓研究脚本：

- `scripts/export_rekordbox_waveform_reference.py`
- `scripts/compare_rekordbox_waveform_reference.py`
- `scripts/render_rekordbox_waveform_contact.py`
- `scripts/search_rekordbox_like_rgb_detail.py`

关键产物：

- `out/research/rekordbox-like-rgb-detail-search-summary.json`
- `out/research/rekordbox-frkb-waveform-contact-simple-top16-current.json`
- `out/research/rekordbox-frkb-waveform-contact-simple-top16-current.bmp`
- `out/research/rekordbox-frkb-waveform-contact-sampler-loops-current.json`
- `out/research/rekordbox-frkb-waveform-contact-sampler-loops-current.bmp`
- `out/research/rekordbox-like-rgb-detail-search-cache.npz`

当前 Python 运行时：

- `vendor/rekordbox-desktop-runtime/win32-x64/python/python.exe`

## 当前已经做了什么

### 数据链路

- raw waveform 已从只保留 min/max 扩展为携带 `meanLeft/meanRight/rmsLeft/rmsRight`。
- 主进程、缓存库、解码 worker、raw stream、renderer、canvas worker、mixtape 渲染链都已经贯通 mean/rms 字段。
- raw cache 也已扩展到保存 mean/rms，避免每次重新分析。

涉及重点文件：

- `src/main/workers/audioDecodeWorker.ts`
- `src/main/workers/mixtapeRawWaveformWorker.ts`
- `src/main/libraryCacheDb/mixtapeRawWaveformCache.ts`
- `src/main/ipc/mixtapeRawWaveformHandlers.ts`
- `src/renderer/src/components/horizontalBrowseRawWaveformStreamTypes.ts`
- `src/renderer/src/components/useHorizontalBrowseRawWaveformStream.ts`
- `src/renderer/src/workers/horizontalBrowseDetailLiveCanvasRawStore.ts`
- `src/renderer/src/composables/mixtape/types.ts`

### RGB 波形渲染

- 已拆出 Rekordbox-like RGB 波形相关模块：
  - `src/renderer/src/components/beatGridRawWaveformColor.ts`
  - `src/renderer/src/components/beatGridRawWaveformEnvelope.ts`
  - `src/renderer/src/components/beatGridRawWaveformShape.ts`
- 大波形 detail rate 目前按 Rekordbox 参考设为 `150`。
- 当前高度模型使用能量包络 + 颜色频段比例修正。
- 当前平滑策略保留攻击音头：识别 attack 时不做前序平滑，非 attack 柱使用 `prev2=0.04 / prev1=0.16 / current=0.8`。
- 当前主要视觉参数：
  - `RAW_ENERGY_SCALE_PERCENTILE = 0.9999`
  - `RAW_ENERGY_FULL_TRACK_PEAK_BLEND_WEIGHT = 1`
  - `RAW_ENERGY_FULL_TRACK_OUTPUT_GAMMA = 1.5`
  - `RAW_ENERGY_FULL_TRACK_ATTACK_WEIGHT = 0`
  - `REKORDBOX_RGB_HEIGHT_BLEND = 0.7`
  - `REKORDBOX_RGB_DETAIL_RATE = 150`

### 性能修复

用户反馈点击概览 seek 后，大波形出来偏慢。已做一轮 stream 首屏优化：

- seek bootstrap 从更大的预读窗口降到更贴近可视区：
  - `HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_LEAD_FACTOR = 0.55`
  - `HORIZONTAL_BROWSE_RAW_SEEK_BOOTSTRAP_OVERSCAN_FACTOR = 1.25`
- seek 后首屏 draw 使用当前 seek 锚点的可视窗口，不再先灌左侧预读区。
- stream 新数据不再一上来按整首歌扩容 raw 数组。
- raw stream 第一包不再固定 32768 帧；缓存路径和 live ffmpeg 路径都改成先吐当前 bootstrap 所需的小首包，后续再继续大块补全。

最新已跑过：

- `npx vue-tsc --noEmit` 通过。
- 针对刚改的 stream 文件跑过 `git diff --check`，只有 CRLF 提示。

## 当前对比结果

来自 `out/research/rekordbox-like-rgb-detail-search-summary.json`：

- sampler loops：
  - `heightActiveMae ~= 0.05882`
  - `heightCorr ~= 0.94876`
- simple top16：
  - `heightActiveMae ~= 0.14018`
  - `heightCorr ~= 0.80488`

来自 `out/research/rekordbox-frkb-waveform-contact-simple-top16-current.json`：

- `avgHeightActiveMae = 0.13996124961026787`
- `avgBestShiftHeightActiveMae = 0.0761862573690638`
- `avgShiftActiveMaeImprovement = 0.06377499224120407`
- `bestShiftDistribution = {-3: 6, 0: 6, 2: 2, 3: 2}`
- `avgActiveColorMae = 0.16740354320082013`

来自 `out/research/rekordbox-frkb-waveform-contact-sampler-loops-current.json`：

- `avgHeightActiveMae = 0.05882451339788794`
- `avgBestShiftHeightActiveMae = 0.05882451339788794`
- `bestShiftDistribution = {0: 8}`
- `avgActiveColorMae = 0.0996100579692207`

结论：

- sampler loops 已经很接近，说明整体 envelope / color 方向不是错的。
- simple top16 仍不够好，但 best-shift 后能明显改善，说明主要剩余差异更像局部相位 / 时间对齐问题，而不是单纯高度参数或颜色矩阵问题。

当前 simple top16 最差样本：

- `Cosmic Beat (Extended Mix)` / VIDIT：active `0.263774`，bestShift `3` 后 `0.088915`
- `Feel Your Soul (Extended)` / Tom Westy, Dansyn：active `0.261961`，bestShift `-3` 后 `0.116377`
- `I Choose You (Extended Mix)` / CHANEY (UK)：active `0.201732`，bestShift `-3` 后 `0.080277`
- `A Song You Love (Original Mix)` / Jou Nielsen, SFH：active `0.198279`，bestShift `3` 后 `0.069204`
- `De Jo (Extended Mix)` / Legit Trip：active `0.180525`，bestShift `-3` 后 `0.077317`

## 踩过的坑

- 不要把这个问题理解成“直接用 Rekordbox”。用户明确要求 FRKB 自己分析用户歌曲；用户可能没有分析过歌曲，也可能没有安装 Rekordbox。
- 不要把 RGB 大波形误解成 3-band 小波形。这里要对齐的是 Rekordbox RGB 大波形的视觉风格和形状。
- 不要只调颜色矩阵。simple top16 的主要差距经 best-shift 大幅收敛，颜色不是当前最大瓶颈。
- 不要盲目套全局时间偏移。测试过 ffmpeg time-basis offset：能改善部分 `-3` shift 样本，但会显著伤害 `+2/+3` 样本，整体变差。
- 不要用单一全局 shift。当前 best shift 分布同时有 `-3 / 0 / +2 / +3`，说明不是一个常数偏移能解决。
- 不要用屏幕空间模糊把问题盖掉。用户要看到鼓点准确起点；attack 音头必须保留清晰竖边。
- 不要用复杂歌曲做主观判断。用户明确要求找波形简单明了的歌曲；复杂音乐干扰太多。
- 不要只看平均值。sampler loops 平均好不代表目标完成，simple top16 仍有明显失败样本。
- 不要把当前“看起来不错”当完成。用户接受先看效果，但主目标仍是高度相似。
- 不要保留临时非错误日志。运行时诊断应走 `log.txt` 链路，用完清理。
- 不要忘记性能。视觉算法改好后，seek 首屏也必须足够快；首包过大已经踩过一次。

## 还需要做什么

优先级从高到低：

1. 继续研究 simple top16 的相位 / 时间对齐差异。
   - 重点样本：`Cosmic Beat`、`Feel Your Soul`、`I Choose You`、`A Song You Love`、`De Jo`。
   - 需要判断 shift 是整段稳定、窗口内漂移，还是和 MP3 encoder delay / Rekordbox 解码策略有关。

2. 做 peak-position 诊断脚本。
   - 对同一窗口内的 Rekordbox reference 和 FRKB candidate 提取峰位置。
   - 输出每个窗口的局部最佳 shift、峰分布、是否随位置变化。
   - 如果 shift 仅在 MP3 上明显，继续查 encoder delay / padding / start time。

3. 研究不依赖 Rekordbox 的运行时修正策略。
   - 如果能从音频 metadata 或解码信息推导 per-file offset，可以尝试。
   - 如果不能稳定推导，考虑在柱采样窗口里做小范围 attack-preserving peak alignment。
   - 注意不能把 attack 音头抹平。

4. 改进 color active MAE。
   - 只有在形状 / 相位进一步改善后再调颜色。
   - 当前 simple color MAE 受相位影响较大，过早拟合颜色容易误判。

5. 继续优化 seek 性能。
   - 当前已减少首包大小，但需要用户实测。
   - 若仍慢，再加最小落盘诊断，记录 stream start、first chunk、first draw、coverage draw 时间。

6. 最终收敛后清理研究代码边界。
   - 确认哪些 `scripts/` 需要保留。
   - 确认研究产物是否只留在 `out/research/`，不要误提交大缓存。
   - 检查所有新增/修改文件行数，避免超过项目 1100 行规则。

## 建议的下一步命令

重新生成当前 contact sheet：

```powershell
& "vendor/rekordbox-desktop-runtime/win32-x64/python/python.exe" "scripts/render_rekordbox_waveform_contact.py" --db "D:/PIONEER/Master/master.db" --selection "out/research/rekordbox-simple-window-candidates.json" --output "out/research/rekordbox-frkb-waveform-contact-simple-top16-current.bmp" --json-output "out/research/rekordbox-frkb-waveform-contact-simple-top16-current.json" --shift-radius 3
```

重新跑参数搜索：

```powershell
& "vendor/rekordbox-desktop-runtime/win32-x64/python/python.exe" "scripts/search_rekordbox_like_rgb_detail.py" --db "D:/PIONEER/Master/master.db" --output "out/research/rekordbox-like-rgb-detail-search-summary.json"
```

修改代码后必须跑：

```powershell
npx vue-tsc --noEmit
```

## 验收标准

视觉验收：

- 在横向浏览 / 编辑模式的大波形中，RGB 形状与 Rekordbox 同一歌曲、同一位置的 RGB 大波形高度接近。
- 简单鼓点、kick、snare、短 loop 的起点清晰，不因平滑产生提前、拖尾或糊边。
- 听起来类似的鼓点，在 FRKB 中不应出现比 Rekordbox 明显更大的形状差异。
- 暗色 / 亮色主题下都能看清 RGB 波形，日间模式不能白底刺眼。
- 概览 seek 后大波形首屏出现速度可接受，不应明显卡住等待整首或大段数据。

量化验收建议：

- sampler loops：`avgHeightActiveMae <= 0.065`，`avgHeightCorr >= 0.94`。
- simple top16：目标先做到 `avgHeightActiveMae <= 0.09`，`avgHeightCorr >= 0.88`。
- simple top16 的 best-shift 改善空间应明显缩小：理想是多数样本 `bestShiftEntries = 0`，或 best-shift 前后差距不再肉眼显著。
- `avgActiveColorMae` 应在形状达标后继续下降；sampler loops 当前约 `0.10` 可以作为短期参考，simple top16 不应长期停在 `0.16+`。

工程验收：

- 不依赖 Rekordbox 运行时数据。
- 不引入全局固定 offset 这种会让部分歌曲变好的硬编码。
- 不保留临时 debug 日志。
- `npx vue-tsc --noEmit` 通过。
- 如果改动 renderer UI / canvas 主题颜色，需要检查 `theme-light` 和 `theme-dark`。
- 如果触碰超过 1100 行的文件，必须先拆分或避免继续膨胀。

## 当前状态判断

当前方向是对的，但目标未完成。

已接近的部分：

- sampler loops 的形状相关指标已达到可用水平。
- attack-preserving smoothing 方向符合用户需求。
- RGB 大波形整体观感已经比早期明显接近 Rekordbox。

仍未完成的部分：

- simple top16 仍有多个样本形状差异明显。
- 主要差异高度疑似相位 / 时间对齐问题，不能再靠单纯调色或全局平滑解决。
- 需要继续做局部 peak/phase 诊断，并实现不依赖 Rekordbox 的修正策略。
