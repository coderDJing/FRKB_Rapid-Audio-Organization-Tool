# Rekordbox-Native 普适规则排查草案

最后更新：`2026-04-24`

## 1. 目标

目标是找到一套可推广的 `Rekordbox-native` 时间轴解释规则，让 Rekordbox 中确认正确的：

- `bpm`
- 第一根网格线

进入 FRKB 后仍然正确。

### 1.1 初衷

这个排查的核心初衷是：用同一份 FRKB/FFmpeg 解码波形承载不同分析结果，干净比较 FRKB 与 Rekordbox 的差异。

也就是说：

- FRKB 的大波形仍然代表 FRKB 对音频文件本身的解码和绘制
- Rekordbox 只作为分析真值来源，不作为默认波形视觉来源
- `rkb` 路线用于验证 Rekordbox 的 `bpm / firstBeatMs / barBeatOffset / PQTZ` 放到 FRKB 音频轴后是否成立
- 对比成立后，再用这些差异反推和优化 FRKB 自己的 BPM、首拍、网格线分析逻辑
- 不能用 Rekordbox `PWV5` 波形、逐曲 offset、歌名特判等方式把问题“看起来修好”

判断某个修复是否正确，先问一句：它有没有保持“同一音频波形基准，只替换分析结果”这个前提。没有就别合，艹，肯定跑偏。

普适规则的定义：

- 不按歌名特判
- 不维护逐曲目 offset 表
- 不拿 `PWV5` 可见起点做运行时补偿
- 不把 Rekordbox `PWV5` 波形作为运行时默认波形源
- 不因为 2-3 首歌对齐就宣布成功
- 不污染 `sample` 和其他非 `rkb` 路径

## 2. 当前实验范围

- `FRKB`：`D:/FRKB_database-B/library/FilterLibrary/rkb`
- `Rekordbox`：`abc`
- 样本数：`33` 首

当前实现只对 `rkb` 快照命中路径生效。

## 3. 当前实现规则

### 3.1 网格真值

从 `resources/rkbRekordboxAbcGridSnapshot.json` 注入：

- `bpm`
- `firstBeatMs`
- `barBeatOffset`

`firstBeatMs` 不做修正。它保持 Rekordbox/PQTZ 的网格时间戳语义。

### 3.2 时间基准

命中 `rkb` 快照后：

- 用 bundled `ffprobe`
- 读取 `stream.start_time`、`sample_rate`、encoder tag、第一包 `Skip Samples`
- 默认写入 `timeBasisOffsetMs = stream.start_time`
- 若是“大写 `LAME` + 第一包 `Skip Samples`”，写入 `timeBasisOffsetMs = start_time + skip_samples / sample_rate`

这个字段用于映射：

- FFmpeg audio sec → timeline sec：`audio + offset`
- timeline sec → FFmpeg audio sec：`timeline - offset`

### 3.3 当前已补齐的使用点

已处理：

- Horizontal Browse live raw waveform
- Horizontal Browse tile worker waveform
- tile cache key
- raw coverage / dirty range 判定
- native transport 播放轴
- mixtape track snapshot
- mixtape song mapper
- 调网格弹窗预览波形
- 调网格弹窗概览波形

这一步的核心不是“再加一个偏移”，而是让同一个时间基准字段在所有路径里一致使用。

## 4. 已确认事实

### 4.1 快照值本身没错

可精确对上的 USB/PQTZ 样本中：

- `snapshot.firstBeatMs == PQTZ[0].timeMs`
- `snapshot.bpm == PQTZ[0].bpm`
- `snapshot.firstBeatLabel == PQTZ[0].beat`

### 4.2 PQTZ 不是当前大漂移解释

USB 探测结果：

- 33 首全部有 `PQTZ`
- `PQTZ` 是逐拍记录
- 这批歌没有多 BPM 段
- 大多数逐拍时间偏差 `< 1ms`
- 最差样本也只是整数毫秒量化级别，不是几十毫秒级结构漂移

结论：

- 当前不支持“FRKB 只读第一拍而 Rekordbox 用多锚点大幅修正”的假设。

### 4.3 `ffprobe start_time` / `Skip Samples` / encoder 是真实格式信号

代表样本：

- `Developer`：`25.057ms`
- `len faki - zig zag`：`25.057ms`
- `Enrico`：`25.057ms`
- `Gamma`：`0ms`
- `Leviws`：`0ms`

其中 `25.057ms` 对应：

- `skip_samples = 1105`
- `1105 / 44100 = 25.057ms`

`2026-04-25` 继续确认：

- `Developer` / `len faki - zig zag`：`encoder = LAME3.100`
- `Enrico`：`encoder = Lavc59.37`
- 这三首都有 `start_time = 25.057ms` 和第一包 `skip_samples = 1105`
- 因此“是否再追加一层 gapless skip”不能只看 `start_time`，还要看 encoder tag

结论：

- 它不是拍脑袋常数
- 它也不是逐曲补偿表
- 当前运行时规则只在“大写 `LAME` + 第一包 `Skip Samples`”组合下追加 `skip_samples / sample_rate`
- `Lavc` 文件保持只用 `stream.start_time`

## 5. 已证伪或禁用的方向

### 5.1 只搬 `PQTZ[0]`

只把 `PQTZ[0]` 当 `firstBeatMs` 搬过来，不处理 FRKB/FFmpeg 时间轴，会出现同值不同显示的问题。

结论：

- PQTZ 是网格真值来源
- 但不是完整播放/波形时间轴语义

### 5.2 只靠 `ffprobe start_time` 且不全链路传播

旧问题不是 `start_time` 这个字段完全无效，而是：

- 有的路径吃到了
- 有的路径没吃到
- 有的路径把 audio sec 和 timeline sec 混用

因此旧说法“`start_time` 方案失败，不要再用”是误导。

更准确的结论：

- `start_time` 是当前候选时间基准的一部分
- 必须统一进入所有 raw waveform / playback / grid 路径
- 用户已复测：只靠 `start_time` 时，`Developer` / `len faki - zig zag` 仍然偏后，`Gamma` / `Leviws` / `Enrico` 当前看起来已对齐
- `2026-04-25` 已改为 `start_time + 条件化 LAME gapless skip`，尚待用户复测
- 同日补了 `scanSongs.ts` 的 rkb 覆盖，避免旧 `song_cache` 的 `timeBasisOffsetMs` 在重启后继续生效

### 5.3 内容级起音阈值

做法：

- 解码音频
- 找第一个超过阈值的起音点
- 用它反推偏移

问题：

- 对鼓头形态、噪声底、前导弱能量非常敏感
- 容易让几首歌变好、另几首歌反向变坏

结论：

- 不能当普适规则

### 5.4 `PWV5` 可见起点补偿

做法：

- 读 Rekordbox 细节波形
- 取首个可见非零点
- 和 FRKB 可见起点做差

问题：

- 这是显示层可见起点，不等于网格时间基准
- 容易变成逐曲补偿
- 用户已明确指出过拟合风险

结论：

- 只能作为排查资料
- 禁止进入运行时修正逻辑
- 禁止把 `PWV5` 作为 Horizontal Browse 默认波形源

### 5.5 离线最大能量峰当真值

离线能量峰只能帮助判断时间轴差异，不能替代 Rekordbox 编辑器确认的网格。

原因：

- 鼓头视觉位置不一定是最大能量点
- 聚合窗口会改变峰值位置
- 频段/声道/采样率处理会影响结果

结论：

- 不能用能量峰覆盖 `firstBeatMs`

### 5.6 当前新增探针：`-20ms` 族群

继续排查时新增了一类只读探针：用当前 deck live raw 路径的关键参数重新测 FRKB raw 波形开头。

探针设置：

- bundled `FFmpeg`
- `2ch / 44100Hz`
- raw 视觉聚合率 `4800Hz`
- 在 Rekordbox `PWV5 visibleOnset` 附近找 FRKB raw first-cross

代表结果：

| file | current raw first-cross vs Rekordbox visible onset |
| --- | ---: |
| `Developer - Have It All (Original Mix).mp3` | `-23.8ms` |
| `len faki - zig zag (original mix) (1).mp3` | `-21.0ms` |
| `len faki - gamma (glaskin remix) (1).mp3` | `+0.8ms` |
| `leviws - foul play (1).mp3` | `+5.3ms` |
| `enrico sangiuliano - the techno code (...) (1).mp3` | `+5.7ms` |

批量结果说明：

- 仍偏后的样本不是随机单曲，而是一类“文件开头立即有强音频”的 MP3
- 这类文件常见 `stream.start_time ≈ 25ms`，但当前 `timeBasisOffsetMs` 只能消掉一部分差异
- 同样有 `start_time≈25ms` 的歌，如果开头不是立即强音频，可能已经对齐

当前禁止结论：

- 禁止推出“所有 `start_time≈25ms` 再额外加 `20ms`”
- 禁止推出“按 first-cross 反推逐曲 offset”
- 禁止把 `PWV5 visibleOnset` 变成运行时补偿表

更合理的下一步：

- 查 MP3 首帧、`Skip Samples`、LAME delay 与 FFmpeg pipe 输出之间的实际时间语义
- 查 FRKB raw 波形绘制是否把文件头部强音频画得过早/过重
- 只接受能解释整类文件、且不破坏已对齐样本的规则

解码路径补充：

- Horizontal Browse `rkb` live raw 现在强制 FFmpeg stream，避免读到旧 raw cache
- 静态 raw / shared decode 可走 Rust/Symphonia
- 对 `start_time≈25ms` 的样本，Symphonia first-cross 往往比 FFmpeg pipe 晚约 `25ms`
- 继续查 ffprobe 元数据后，`Developer` / `Zig Zag` 是 `LAME3.100`，`Enrico` 是 `Lavc59.37`
- 当前修复不是“统一用 Symphonia”或“统一再加一个 start_time”，而是条件化：
  - 大写 `LAME` + 第一包 `Skip Samples`：`timeBasisOffsetMs = start_time + skip_samples / sample_rate`
  - 其他 encoder：保持 `timeBasisOffsetMs = start_time`
- 这条规则必须通过用户复测确认，尤其是 `Developer` / `Zig Zag` 是否回正，以及 `Enrico` 是否没被误伤

## 6. 当前踩坑清单

### 6.1 字段存在不等于全链路生效

`timeBasisOffsetMs` 已经进入 song 对象，但曾经漏掉：

- tile worker 请求
- tile cache key
- 调网格弹窗 props
- mixtape snapshot parse/map
- raw stream coverage/dirty range

这会导致用户在某个视图里仍看到偏移。

### 6.2 audio sec 和 timeline sec 必须明确命名

容易写错的地方：

- FFmpeg `-ss`
- raw stream `startSec`
- loaded range
- dirty range
- visible range
- grid range

规则：

- 发给 FFmpeg：audio sec
- UI/grid/overlay/coverage：timeline sec
- 两者之间用 `timeBasisOffsetMs` 转换

### 6.3 不要改 `firstBeatMs` 去追视觉

`firstBeatMs` 是 Rekordbox/PQTZ 真值。

如果视觉不贴，优先查：

- 时间轴映射
- 波形路径是否漏字段
- cache key 是否包含 offset
- 当前走 live stream 还是 tile/fallback

不要直接把 `firstBeatMs` 改早几毫秒。

### 6.4 文档必须写“待验证”，不要写“已解决”

截至当前文档更新时间：

- `npx vue-tsc --noEmit` 已通过
- 字段传播/轴转换补丁已完成
- 用户已复测并确认仍有部分歌曲偏后

所以只能写：

- “已修复已知漏传/混轴问题”
- “部分歌曲仍需继续排查同音频波形轴差异”

不能写：

- “Developer 已经好了”
- “Zig Zag 已经好了”
- “普适规则已找到”

## 7. 当前代表样本

### `Developer - Have It All (Original Mix).mp3`

- `bpm = 141`
- `firstBeatMs = 61`
- `timeBasisOffsetMs = 50.114`
- 当前关键复测样本

### `len faki - zig zag (original mix) (1).mp3`

- `bpm = 137`
- `firstBeatMs = 52`
- `timeBasisOffsetMs = 50.114`
- 当前关键复测样本

### `len faki - gamma (glaskin remix) (1).mp3`

- `bpm = 145`
- `firstBeatMs = 26`
- `timeBasisOffsetMs = 0`
- 用户反馈已对齐

### `leviws - foul play (1).mp3`

- `bpm = 138`
- `firstBeatMs = 28`
- `timeBasisOffsetMs = 0`
- 用户反馈已对齐

### `enrico sangiuliano - the techno code (...) (1).mp3`

- `bpm = 140`
- `firstBeatMs = 274`
- `barBeatOffset = 2`
- `timeBasisOffsetMs = 25.057`
- `encoder = Lavc59.37`，不追加 LAME skip
- 用户反馈已对齐

### `lewis fautzi - diversity of known substances (...) (1).mp3`

- `bpm = 138`
- `firstBeatMs = 225`
- 用于防止只围绕 Developer 调参

## 8. 下一步验证策略

复测顺序：

1. 重启应用
2. 打开 `rkb`
3. 看 `Developer`
4. 看 `len faki - zig zag`
5. 分别确认：
   - Horizontal Browse 详情波形
   - 调网格弹窗
   - 播放/节拍器听感

如果仍然偏后：

1. 临时把相关字段写入 `log.txt`
2. 记录当前视图拿到的：
   - `filePath`
   - `firstBeatMs`
   - `bpm`
   - `barBeatOffset`
   - `timeBasisOffsetMs`
   - raw stream `startSec`
   - 当前渲染路径：live / tile / fallback
3. 交付前删除临时日志

重要方向修正：

- 不能通过默认改用 Rekordbox `PWV5` 波形让视觉“看起来对”
- 正确对比基准必须保持为 FRKB/FFmpeg 从同一音频文件解码得到的波形
- Rekordbox 只提供分析真值：`bpm / firstBeatMs / barBeatOffset / PQTZ`
- 当前要查的是为什么只有部分歌曲在这条共同波形轴上仍然偏后

## 9. 已删除的误导性结论

不要再恢复这些旧说法：

- “当前 `rkb` 已回到 `timeBasisOffsetMs = 0`”
- “已经移除 `ffprobe start_time`”
- “`ffprobe start_time` 已被完全证伪”
- “直接对齐 `PWV5` 可见起点是下一步修法”
- “PQTZ 多 entry 是当前大漂移主因”
- “Developer 偏后说明 Rekordbox 快照错了”

当前更准确的表述：

- Rekordbox/PQTZ 网格值本身基本可信
- `timeBasisOffsetMs` 是当前时间轴映射字段：基础为 `stream.start_time`，大写 `LAME` + 第一包 `Skip Samples` 时追加 `skip_samples / sample_rate`
- 关键风险在字段传播不完整、audio/timeline 混轴和渲染路径不一致
- 最新补丁修的是一致性问题，不是逐曲过拟合
