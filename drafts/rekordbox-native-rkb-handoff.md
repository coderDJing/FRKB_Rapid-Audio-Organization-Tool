# Rekordbox-Native `rkb` 交接文档

## 1. 当前目标

当前要做的不是继续优化 `FRKB-native`，而是在 `rkb` 歌单上验证一条独立的 `Rekordbox-native` 路线。

用户需求必须严格按下面理解：

- 目标只有两个：
  - `bpm` 绝对正确
  - 第一根网格线绝对正确
- “绝对正确”的含义：
  - 以 `Rekordbox` 编辑器里当前看到并确认无误的结果为准
  - 不是“在 FRKB 里听起来差不多”
  - 不是“靠 FRKB 自己修正后更顺耳”
- 需要的是一条 **普适规则**
  - 不能按歌名特判
  - 不能维护逐曲目偏移表
  - 不能接受“大部分歌对，少数歌再补”
  - 必须是一条统一、可批量应用、未来能推广到全局的规则

最终预期是：

- `rkb` 先作为 `Rekordbox-native` 试验场
- `sample` 继续走 `FRKB-native`
- 等用户确认两套模式谁更好，最后只保留一套推广到全局

## 2. 当前范围与硬边界

- 只允许影响 `rkb`
- `sample` 不能被污染
- 当前所有实验都以 `FRKB_database-B/library/FilterLibrary/rkb` 为唯一试验歌单
- `Rekordbox` 侧基准歌单是 `abc`
- `rkb` 与 `abc` 当前应是同一批 33 首歌

不要做的事：

- 不要为了让 `rkb` 听起来对，去改 `sample` 真值
- 不要把人工真值重新注入运行时
- 不要写逐曲目硬编码
- 不要把当前实验直接推广到全局

## 3. 当前工程状态

### 3.1 已拉取远端

- 已执行：`git pull --rebase --autostash origin main`
- 当前本地基线在远端最新 `5d4f12d`
- 没有 Git 冲突

### 3.2 已编译原生模块

- 已执行：`napi build --platform --release`
- `rust_package` 已重编成功

### 3.3 已通过类型检查

- 已执行：`npx vue-tsc --noEmit`
- 最近一次通过

## 4. 当前相关文件

### 4.1 `rkb` 实验入口

- `resources/rkbRekordboxAbcGridSnapshot.json`
  - Rekordbox `abc` 当前 33 首歌的原始 `bpm / firstBeatMs / barBeatOffset` 快照
- `resources/rkbRekordboxAbcWaveformVisibleOnsets.json`
  - Rekordbox `EXT/PWV5` 细节波形首个可见非零点快照
  - 这是实验资源，不代表最终规则已成立
- `src/main/services/keyAnalysis/rkbRekordboxGrid.ts`
  - `rkb` 特殊逻辑核心文件
  - 当前版本又被改回 **仅使用格式级元数据偏移**：
    - `timeBasisOffsetMs = ffprobe start_time`
  - 这版已经被 `Developer` 重新证伪，不是终局方案

### 4.2 已打通的基础设施

这些改动本身是有价值的，即使后续规则要重写，也尽量复用，不要白白推翻：

- `src/main/services/keyAnalysis/persistence.ts`
  - `rkb` 命中快照后直接注入 `bpm / firstBeatMs / barBeatOffset / timeBasisOffsetMs`
- `src/main/services/sharedSongGrid.ts`
  - `timeBasisOffsetMs` 已进入 shared grid 持久化
- `src/main/services/songGridEvents.ts`
  - `song-grid-updated` 已带 `timeBasisOffsetMs`
- `src/shared/horizontalBrowseTransport.ts`
  - transport 输入已带 `timeBasisOffsetMs`
- `rust_package/src/horizontal_browse_transport*.rs`
  - transport/节拍器链已接入 `timeBasisOffsetMs`
- `src/renderer/src/components/horizontalBrowseNativeTransport.ts`
  - 送 deck/native transport 时已带 `timeBasisOffsetMs`
- `src/renderer/src/components/HorizontalBrowseRawWaveformDetail.vue`
  - 预览态已纳入 `timeBasisOffsetMs`
- `src/renderer/src/components/mixtapeBeatAlignWaveform.ts`
  - 波形绘制已开始吃 `timeBasisOffsetMs`

### 4.3 临时追踪日志

当前 `log.txt` 里已加好的关键词：

- `[rkb-snapshot] hit`
- `[rkb-snapshot] inject grid from snapshot`
- `[rkb-snapshot] inject grid done`
- `[rkb-snapshot] skip worker after snapshot inject`
- `[renderer-debug:rkb-native-transport]`

这些日志已经足够证明：

- `rkb` 当前确实吃到了快照
- deck/native transport 也确实收到了实验链生成的值

## 5. 已确认的事实

### 5.1 不是“没走 Rekordbox 值”

这一点已经被排除。

证据：

- `song_cache` 里 `rkb` 的值与快照文件一致
- `beatThisEstimatedDrift128Ms / beatThisWindowCount` 在 `rkb` 上通常为 `null`
- `log.txt` 明确出现：
  - `hit`
  - `inject grid from snapshot`
  - `skip worker after snapshot inject`

### 5.2 文件不是“不同副本”

以下文件已核过 SHA256，一致：

- Rekordbox 原始导入源
- `FRKB rkb` 拷贝
- `FRKB sample` 拷贝

所以问题不是“复制后文件变了”。

### 5.3 公开资料只逆向到了部分文件结构

已查过：

- `pyrekordbox`
- `Deep Symmetry / crate-digger / DJL Analysis`

现状：

- `PQTZ` 基础网格结构可读
- `PQT2` 扩展网格主 `entries` 语义不完整
- 没有现成公开资料完整说明：
  - Rekordbox 编辑器里“第一根线”最终为何在该位置
  - Rekordbox 运行时如何统一网格/波形/播放时间线

结论：

- 没有现成答案可以直接抄
- 最后一段语义必须靠本地验证补出来

## 6. 当前四首代表歌

这四首歌是当前判断“规则是否普适”的最小集。后续任何新规则至少要同时在这四首上通过，否则不要宣布成功。

### 6.1 `Developer - Have It All (Original Mix).mp3`

- Rekordbox 原始：
  - `bpm = 141`
  - `firstBeatMs = 61`
  - `barBeatOffset = 0`
- `ffprobe start_time = 25.057ms`
- 现象：
  - 用 `start_time` 规则时会重新变错
  - 用某些内容相关规则时反而更接近
- 作用：
  - 证伪“格式级偏移就够”的想法

### 6.2 `len faki - gamma (glaskin remix) (1).mp3`

- Rekordbox 原始：
  - `bpm = 145`
  - `firstBeatMs = 26`
  - `barBeatOffset = 0`
- `ffprobe start_time = 0`
- 现象：
  - 多套规则下都容易正确
- 作用：
  - 说明不能拿“简单歌”当全局样本自我安慰

### 6.3 `lewis fautzi - diversity of known substances (original mix) (1).mp3`

- Rekordbox 原始：
  - `bpm = 138`
  - `firstBeatMs = 225`
  - `barBeatOffset = 0`
- `ffprobe start_time = 25.057ms`
- 现象：
  - 用内容相关规则时会提前一点
  - 用格式级偏移时反而更接近
- 作用：
  - 证伪“内容级起音提取规则普适”

### 6.4 `enrico sangiuliano - the techno code (charlotte de witte's acid code) (1).mp3`

- Rekordbox 原始：
  - `bpm = 140`
  - `firstBeatMs = 274`
  - `barBeatOffset = 2`
- `ffprobe start_time = 25.057ms`
- 现象：
  - 在某些对 `Developer/Gamma/Lewis` 都更好的规则下，它仍会错
- 作用：
  - 证明“单点偏移规则”整体上不成立

## 7. 已经被证伪的规则

下面这些都已经被代表歌明确打脸，不要继续绕圈子。

### 7.1 规则 A：直接用 `PQTZ[0]`

做法：

- 直接把 `PQTZ` 第一条当成 `FRKB firstBeatMs`

结果：

- `Gamma` 看起来能对
- `Developer` 会明显偏后

结论：

- 仅搬 `PQTZ[0]` 不够

### 7.2 规则 B：只用 `ffprobe start_time`

做法：

- `timeBasisOffsetMs = ffprobe start_time`

结果：

- `Gamma / Lewis / Enrico` 可以更接近
- `Developer` 会重新变错

结论：

- 纯格式元数据偏移，不是普适规则

### 7.3 规则 C：音频起音阈值偏移

做法：

- 解码音频
- 找第一个超过阈值的起音点
- 用它反推偏移

结果：

- `Developer / Gamma` 可能变好
- `Lewis / Enrico` 会被证伪

结论：

- 内容级阈值规则天然不普适

### 7.4 规则 D：Rekordbox 细节波形起点 vs FRKB 可见起点

做法：

- 读 `PWV5`
- 取 Rekordbox 第一个可见非零点
- 再减 FRKB 这边的可见起点

结果：

- `Developer / Gamma / Lewis` 可更接近
- `Enrico` 仍然会错

结论：

- “对齐可见起点”也不是普适规则
- 单点规则仍然不够

## 8. 当前真正困难

问题已经不是：

- 有没有命中 `rkb`
- 有没有把 Rekordbox 值写进缓存
- deck/native transport 有没有拿到实验值

这些都已经证明是通的。

当前真正困难是：

- **简单单点偏移规则不普适**

也就是说，不管这个单点来自：

- `PQTZ[0]`
- `start_time`
- 音频起音点
- Rekordbox 波形起点

都已经被反例证伪。

## 9. 对新会话最重要的判断

### 9.1 现在还没有找到用户要的普适规则

如果新会话继续试：

- 新的固定毫秒偏移
- 新的单阈值起音规则
- 新的单点波形对齐规则

那大概率只是在重复踩坑。

### 9.2 当前最可能的正确方向

如果继续坚持“必须普适”，后续要走的方向不应再是单点偏移，而应是：

- **多点约束**
- 或者进一步：
  - 真正复刻 Rekordbox 时间线/波形/编辑器语义

也就是说：

- 不只看一根线
- 不只看第一个起点
- 要看前若干个拍点/网格位置之间的整体关系

## 10. 新会话建议怎么开干

### 第一步：不要再折腾旧规则

先接受下面这个事实：

- 目前所有单点规则都不满足用户定义的“普适”

### 第二步：只围绕四首歌做最小验证

继续只盯：

- `Developer`
- `Gamma`
- `Lewis`
- `Enrico`

任何新规则必须同时在这四首上成立。

### 第三步：优先做“多点对齐”离线验证

建议新会话先不要急着改运行时代码，而是：

- 写离线脚本
- 只对这四首歌
- 用多个拍点/前几根网格线做一致性评分

先证明是否存在一条统一规则，再决定是否进运行时代码。

### 第四步：继续只作用于 `rkb`

在没有通过四首歌验证前：

- 不要碰 `sample`
- 不要碰全局默认模式
- 不要宣布 `Rekordbox-native` 已经可推广

## 11. 建议复现命令

### 11.1 拉取远端

```powershell
git pull --rebase --autostash origin main
```

### 11.2 重新编译 Rust 模块

```powershell
cd rust_package
napi build --platform --release
```

### 11.3 类型检查

```powershell
cd ..
npx vue-tsc --noEmit
```

### 11.4 重点看日志

日志文件：

- `log.txt`

重点关键字：

- `rkb-snapshot`
- `rkb-native-transport`

## 12. 当前文档关系

如果新会话只关心本轮 `Rekordbox-native` 普适规则，请先看这份：

- `drafts/rekordbox-native-rkb-handoff.md`

再看这份更聚焦的证伪记录：

- `drafts/rekordbox-native-grid-universal-rule-draft.md`

这两份文档的定位不同：

- `rekordbox-native-rkb-handoff.md`
  - 面向“接手就开干”的完整上下文
- `rekordbox-native-grid-universal-rule-draft.md`
  - 面向“这几套规则为什么已经被证伪”的结论压缩版
