# Horizontal Browse pending-play 偶发慢启动

## 当前状态

候选修复待验收。

现象是歌曲加载后立即点击播放时，播放按钮偶发持续忙碌数秒才真正出声。该问题只能以现场
`log.txt` 和实际听感验收，不能仅凭静态检查宣布解决。

## 已确认的边界

- `playheadLoaded` 是真实播放就绪门槛，不能为了隐藏忙碌态而放宽。
- 慢路径可能发生在播放头附近 PCM 尚未覆盖时的 `preparePlayhead`，也可能是 FFmpeg 启动、首字节
  或 decode/apply 阶段本身过慢。
- pending startup decode、播放头位置和 `timeBasisOffset` 的关系必须按真实音频时间线判断，不能以
  UI 时间或固定偏移猜测覆盖范围。
- 当前 native transport 已有针对 pending startup decode 的覆盖范围和播放头移动的回归测试；候选修复
  是否消除真实环境中的慢启动，仍待现场确认。

## 当前可用日志

以下标签已经存在于现有落盘日志链路；本手册不要求新增日志。

| 标签 | 用途 |
| --- | --- |
| `[HB-TRANSPORT-SLOW]` | 主进程 transport 操作超阈值，包含操作名、耗时及 deck 前后快照。 |
| `[HB-TRANSPORT-DECODE-SLOW]` | native decode 阶段的慢指标，包含 FFmpeg spawn、首字节及 decode/apply 等信息。 |
| `[HB-TRANSPORT-DECODE] prepare-playhead-slow` | `preparePlayhead` 本身超阈值，包含同一 deck 的操作前后状态。 |

旧的 `[HB-PENDING-PLAY]` 标签已不存在，不能再把它当作现场证据或检索条件。

## 复现后的判读顺序

1. 确认复现的实例和对应 `log.txt`；其他安装包或其他 checkout 的日志不能与当前工作区混读。
2. 按时间和 deck 对齐三类标签，先看 `prepare-playhead` 是否慢，以及操作前后 `playheadLoaded` 是否变化。
3. 如果 `ffmpegSpawnMs` 或 `ffmpegFirstByteMs` 接近秒级，优先排查 FFmpeg 冷启动、输入探测或解码后端，
   不要只改 renderer pending 状态。
4. 如果 decode 指标正常但 `preparePlayhead` 很慢，检查 pending decode 是否被取消/替换，以及播放头和
   已覆盖 PCM 范围是否一致。
5. 如果没有任何慢 transport/decode 标签但 UI 仍长时间忙碌，再检查 snapshot 广播与 renderer 恢复逻辑；
   不能先假定是同一个 native decode 问题。

## 后续约束

- 不要用延迟隐藏按钮、伪造 `playheadLoaded` 或固定时间等待掩盖问题。
- 诊断标签只在该偶发问题未完成真实验收期间保留；修复确认后按 Debug Logging 规则删除或收窄。
- 如再次复现，应先保存完整现场日志和版本/实例信息，再决定是否改代码。
