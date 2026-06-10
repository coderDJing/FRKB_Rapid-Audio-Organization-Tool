# Rekordbox-Native 普适规则排查草案

## 目的

这份草案专门记录 `rkb` 歌单上的 `Rekordbox-native` 排查结果，目标只有一个：

- 找到一套 **普适规则**，把 `Rekordbox` 里已经确认绝对正确的
  - `bpm`
  - 第一根网格线
  稳定带到 `FRKB`

这里的“普适”含义必须钉死：

- 不能按歌名特判
- 不能维护白名单/黑名单
- 不能做逐曲目偏移表
- 不能接受“大部分歌对，少数再补”
- 必须是一条统一、可批量应用、可推广到全局的规则

## 当前试验范围

- `FRKB`：
  - `rkb` 歌单：仅用于 `Rekordbox-native` 试验
  - `sample` 歌单：继续保留 `FRKB-native`
- `Rekordbox`：
  - `abc` 歌单：与 `rkb` 当前是同样的 33 首歌

当前所有实验都只允许影响 `rkb`，不允许污染 `sample` 和其他代码路径的默认行为。

## 用户真实需求

当前需求不是：

- 让 `FRKB` “听起来差不多”
- 让 `FRKB` 用自己的规则把 `Rekordbox` 结果“修正到更顺耳”
- 用逐曲目补丁把几首问题歌凑到能用

当前需求是：

- 在 `Rekordbox` 中已经确认绝对正确的 `bpm`
- 在 `Rekordbox` 中已经确认绝对正确的第一根网格线
- 进入 `FRKB` 后也必须保持绝对正确

如果同样的数据在 `Rekordbox` 正确、在 `FRKB` 错误，那优先结论不是 `Rekordbox` 值错了，而是：

- 我们拿到的不是 `Rekordbox` 真正最终使用的完整语义
- 或者 `FRKB` 后续播放/波形/时间基准把这组值用坏了

## 已确认的事实

### 1. 当前 `rkb` 已经能稳定命中 `Rekordbox` 快照

已确认：

- `rkb` 歌单命中的是本地快照，不再实时读库
- `song_cache` 落进去的 `bpm / firstBeatMs / barBeatOffset` 与快照一致
- `log.txt` 可见：
  - `hit`
  - `inject grid from snapshot`
  - `skip worker after snapshot inject`

结论：

- “没走 `Rekordbox` 值”这一条已经被排除

### 2. `Rekordbox` 文件结构已有部分公开逆向，但没有现成的完整最终规则

现有公开资料：

- `pyrekordbox`
- `Deep Symmetry / crate-digger / DJL Analysis`

已确认：

- `PQTZ` 基础网格结构可读
- `PQT2` 扩展网格结构可读，但主 `entries` 语义仍不完整
- 没看到任何公开资料完整说明：
  - `Rekordbox` 编辑器里“第一根线为什么在这里”
  - `Rekordbox` 最终播放/波形时间基准如何与网格结合

结论：

- 现在没有现成公开答案可以直接抄
- 最后一段规则必须靠本地验证补出来

### 3. 同一个 `bpm / firstBeatMs`，在 `Rekordbox` 与 `FRKB` 中不一定表现一致

已确认：

- 同一音频文件 SHA256 完全一致
- 同一份 `Rekordbox` 网格值进入 `FRKB` 后，仍可能出现：
  - 视觉上不贴拍头
  - 节拍器听起来跑马

结论：

- 问题不在“文件不是同一份”
- 问题也不在“根本没吃到 `Rekordbox` 值”
- 问题在于：`FRKB` 的时间基准/波形语义与 `Rekordbox` 不一致

## 已验证失败的规则

下面这些规则都已经被代表歌曲证伪，不能再当成终局方案继续自我安慰。

### 规则 1：直接使用 `Rekordbox PQTZ[0]` 作为第一根网格线

做法：

- 直接读取 `PQTZ` 第一条
- 直接把它当成 `FRKB` 的 `firstBeatMs`

结果：

- `Gamma` 这类歌可以对
- `Developer` 会明显偏后

结论：

- 单纯把 `PQTZ[0]` 搬过来，不足以复刻 `Rekordbox` 最终效果

### 规则 2：用 `ffprobe start_time` 作为统一偏移

做法：

- `timeBasisOffsetMs = ffprobe start_time`

结果：

- `Developer` 又不对
- 其他部分歌可能对

关键反例：

- `Developer - Have It All (Original Mix).mp3`
  - `ffprobe start_time = 25.057ms`
  - 仅用这条统一格式级偏移，不足以让它回到 `Rekordbox` 一致状态

结论：

- “只认文件格式元数据偏移”不是普适规则

### 规则 3：用 `FRKB/FFmpeg` 音频起音阈值提偏移

做法：

- 解码音频
- 找第一个超过阈值的起音点
- 用它反推时间基准偏移

结果：

- `Developer`、`Gamma` 可能看起来更接近
- `Lewis Fautzi`、`Enrico` 会被证伪

结论：

- 内容级起音阈值天然不普适
- 不同歌的前导弱能量、鼓头形态、噪声底完全不同

### 规则 4：用 `Rekordbox` 细节波形的首个可见非零点对齐 `FRKB` 可见起点

做法：

- 读 `PWV5` / 细节波形
- 取 `Rekordbox` 第一个可见非零点
- 再减 `FRKB/FFmpeg` 这边推导出来的可见起点

结果：

- `Developer`
- `Gamma`
- `Lewis Fautzi`
  这几首可能同时变好
- `Enrico` 又会翻车

结论：

- “对齐可见起点”也不等于“对齐第一根正确网格线”
- 依然只是单点规则，还是不普适

## 四首代表歌

### 1. `Developer - Have It All (Original Mix).mp3`

现象：

- `Rekordbox` 里绝对正确
- `FRKB` 用某些规则会比 `Rekordbox` 晚

意义：

- 能证伪“只用 `start_time` 就够”的想法

### 2. `len faki - gamma (glaskin remix) (1).mp3`

现象：

- 多套规则下都容易接近正确

意义：

- 说明有些歌的时间基准差确实较简单
- 不能拿它当全局样本自我欺骗

### 3. `lewis fautzi - diversity of known substances (original mix) (1).mp3`

现象：

- 某些规则会让它比 `Rekordbox` 稍微提前
- 听感上节拍器能明显分辨不同

意义：

- 证伪“内容级起音规则普适”

### 4. `enrico sangiuliano - the techno code (charlotte de witte's acid code) (1).mp3`

现象：

- 在 `Developer / Gamma / Lewis` 都好的规则下，它依然会错

意义：

- 说明“单点偏移”这条思路整体上不成立

## 当前最重要的结论

### 结论 1：我们还没有找到普适规则

无论是：

- `PQTZ[0]`
- `start_time`
- 音频起音阈值
- 细节波形首个可见点

都已经被反例证伪。

### 结论 2：问题不是“链路没走通”

已确认：

- `rkb` 确实吃到了 `Rekordbox` 值
- deck / transport 也确实拿到了我们注入后的值

所以问题不在“有没有走到”
而在“这组值在 `FRKB` 当前时间基准下如何被解释”

### 结论 3：简单规则这条路已经接近走到头

如果还坚持：

- 不特判
- 不按歌名
- 不逐曲目补偿

那下一步就不能再靠更换“另一个单点偏移规则”了。

## 后续方向

如果继续追求“普适规则”，正确方向只剩一条：

- 真正复刻 `Rekordbox` 最终时间线/波形语义

这里的“复刻”不是再读两个值，而是要统一以下几层：

- `Rekordbox` 网格语义
- `Rekordbox` 波形语义
- `Rekordbox` 播放时间基准
- 编辑器里“第一根线”的最终解释方式

也就是说，后续应停止继续试：

- 新的固定全局偏移
- 新的起音阈值
- 新的单点波形对齐规则

因为这些方向已经连续被代表歌曲证伪。

## 当前交付边界

当前 `rkb` 仍然只能视为：

- `Rekordbox-native` 试验场

不能视为：

- 已经找到可推广到全局的终局规则

如果后续有新规则，必须至少同时在这 4 首上通过：

- `Developer`
- `Gamma`
- `Lewis Fautzi`
- `Enrico`

否则一律不得宣布“已经找到普适规则”。
