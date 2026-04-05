# 双轨横推 MASTER / SYNC 交互机制草案

更新时间：2026-04-05

## 0. 当前拍板

这份草案只解决双轨横推模式里的 `MASTER / SYNC` 交互，不碰下面这些东西：

- 不做硬件兼容逻辑
- 不做 `Master Tempo / Key Lock / 变速不变调`
- 不做多于两轨的同步
- 不做复杂的 BPM 范围失败提示

本期只拍板一件事：

- 把横推双轨做成接近 rekordbox Export 双播放器的 `MASTER + SYNC` 机制

## 1. 目标

用户在横推双轨模式里应该能得到下面这套行为：

1. 两个 deck 都可以单独开启或关闭 `SYNC`
2. 同一时刻只允许一个 `MASTER`
3. `MASTER` 决定同步基准
4. 非 `MASTER` 且 `SYNC=ON` 的 deck 自动跟随 `MASTER`
5. `MASTER` 切换后，不强制改动两个 deck 的 `SYNC` 开关状态，跟随方向自动翻转

一句话说透：

- `MASTER` 回答“现在跟谁跑”
- `SYNC` 回答“这条 deck 要不要加入同步体系”

## 2. 名词定义

### 2.1 Deck

横推双轨固定只有两条：

- `top`
- `bottom`

### 2.2 MASTER

`MASTER` 是当前同步基准 deck。

规则：

- 全局唯一
- 可为空
- 不等于音频主输出
- 不等于 `Master Tempo`

### 2.3 SYNC

`SYNC` 是 deck 自己的持续开关态，不是一次性按钮。

每条 deck 都有自己的：

- `syncEnabled = true | false`

两个 deck 可以同时是 `syncEnabled = true`。

### 2.4 SYNC 锁定状态

为便于 UI 表达，额外定义：

- `off`：未开启同步
- `full`：BPM + 拍位都锁住
- `tempo-only`：只锁 BPM，不锁拍位

推荐 UI 映射：

- `off`：按钮灭
- `full`：按钮常亮
- `tempo-only`：按钮闪烁

## 3. 最小状态模型

运行时建议只维护下面这组状态：

```ts
type DeckKey = 'top' | 'bottom'

type DeckSyncLockState = 'off' | 'full' | 'tempo-only'

type HorizontalBrowseSyncState = {
  masterDeck: DeckKey | null
  syncEnabled: Record<DeckKey, boolean>
  syncLock: Record<DeckKey, DeckSyncLockState>
}
```

再加每条 deck 现有已经有的网格数据：

- `bpm`
- `firstBeatMs`
- `barBeatOffset`

这三个字段就是拍位同步的基础，当前仓库已经有，不用另起炉灶。

## 4. MASTER 机制

### 4.1 初始状态

进入横推双轨页面后：

- `masterDeck = null`
- 两边 `syncEnabled` 默认都保留上次会话值或默认 `false`
- 只要还没有 `MASTER`，`SYNC` 可以先处于开启态，但不会产生跟随效果

### 4.2 自动选主

当没有 `MASTER` 时：

1. 哪条 deck 先开始播放
2. 哪条 deck 就自动成为 `MASTER`

这是默认主规则。

### 4.3 手动切主

点击某条 deck 的 `MASTER`：

- 直接把该 deck 设为新的 `MASTER`
- 另一条 deck 立即失去 `MASTER`
- 不自动改动两边的 `syncEnabled`

如果点击的就是当前 `MASTER`：

- 不做 toggle
- 状态保持不变

别做成“点一下取消 MASTER”，那玩意很蠢，实际只会把状态机搞乱。

### 4.4 MASTER 失效转移

当前 `MASTER` 遇到下面任一情况，视为失去主控资格：

- deck 被清空
- deck 重新加载了新歌
- deck 主动停止到不可作为参考的状态

处理规则：

1. 如果另一条 deck 仍然有效，则把 `MASTER` 转给另一条
2. 如果另一条也无效，则 `masterDeck = null`

“有效”在本期先按最简单口径处理：

- 已加载歌曲

是否要求“必须正在播放”可以后续微调，但第一版不必过度复杂化。

## 5. SYNC 机制

### 5.1 基本规则

点击某条 deck 的 `SYNC`：

- 如果当前为 `OFF`，切到 `ON`
- 如果当前为 `ON`，切到 `OFF`

这只是加入或退出同步体系，不直接决定谁是 `MASTER`。

### 5.2 MASTER 上点 SYNC

当前 `MASTER` deck 也允许 `SYNC=ON`。

此时含义不是“跟随别人”，而是：

- 这条 deck 仍处于同步体系内
- 一旦它后续不再是 `MASTER`，就可以无缝变成跟随方

所以：

- `MASTER` 和 `SYNC=ON` 不冲突
- 两个 deck 都 `SYNC=ON` 是合法状态

### 5.3 非 MASTER 上点 SYNC

如果某条非 `MASTER` deck 开启 `SYNC`，且当前存在有效 `MASTER`：

1. 立即按 `MASTER` 当前拍位做一次相位对齐
2. 进入 `full` 状态
3. 后续持续跟随 `MASTER`

跟随内容包括：

- BPM 对齐
- 拍位对齐

### 5.4 没有 MASTER 时点 SYNC

如果当前 `masterDeck = null`，用户依然可以开启任意 deck 的 `SYNC`。

此时规则是：

- 只记录 `syncEnabled = true`
- 不做速度修正
- 不做拍位修正
- 等 `MASTER` 出现后再决定是否进入跟随

也就是说，`SYNC` 可以先 armed 着，不必强绑 `MASTER`。

## 6. 两轨组合状态

### 6.1 两边都 SYNC 关闭

- 只有 `MASTER` 概念，没有自动跟随
- 两条 deck 都按自己的播放状态独立运行

### 6.2 一边 SYNC 开启，一边关闭

分两种情况：

1. 开启 `SYNC` 的是非 `MASTER`
   - 这条跟随 `MASTER`
2. 开启 `SYNC` 的是 `MASTER`
   - 当前没有 deck 跟随
   - 但它仍属于同步体系

### 6.3 两边都 SYNC 开启

这是允许的，而且应当作为常见状态支持。

规则：

- 当前 `MASTER` 继续当基准
- 另一条 deck 跟随它
- 如果 `MASTER` 改变，不改 `SYNC` 开关，只自动翻转跟随方向

举例：

- 初始：`top = MASTER`，`top.sync = on`，`bottom.sync = on`
- 后来用户点了 `bottom MASTER`
- 结果：
  - `bottom` 成为新 `MASTER`
  - `top.sync` 仍然保持 `on`
  - `bottom.sync` 仍然保持 `on`
  - 此时由 `top` 跟随 `bottom`

## 7. 播放与按钮交互规则

### 7.1 PLAY

点击某条 deck 的 `PLAY`：

1. 如果当前没有 `MASTER`
   - 该 deck 自动成为 `MASTER`
2. 如果该 deck 不是 `MASTER` 且 `SYNC=ON`
   - 开播前先做一次拍位对齐
   - 然后按同步速率启动
3. 如果该 deck 不是 `MASTER` 且 `SYNC=OFF`
   - 正常独立播放

### 7.2 PAUSE / CUE / 手动停下

如果非 `MASTER` deck 暂停：

- 不影响 `MASTER`
- 保留自己的 `SYNC` 开关状态

如果当前 `MASTER` 暂停或回到 `CUE`：

- 若另一条 deck 仍有效，则把 `MASTER` 转过去
- 否则清空 `MASTER`

### 7.3 LOAD SONG

向某条 deck 加载新歌：

- 该 deck 的 `syncLock` 立即重置
- `syncEnabled` 建议保留
- 如果该 deck 原来是 `MASTER`，按“MASTER 失效转移”规则处理

建议保留 `syncEnabled` 的原因很简单：

- 这更像 rekordbox 的持续开关语义
- 新歌加载完成后，如果它不是 `MASTER`，可以继续自动加入同步体系

### 7.4 SEEK / 拖动播放头

如果在非 `MASTER` 且 `SYNC=ON` 的 deck 上发生用户主动 seek：

- 先把该 deck 降级到 `tempo-only`
- 保留 `syncEnabled = true`
- 只继续做 BPM 跟随，不再强行拍位锁定

恢复 `full` 的方式：

1. 用户手动把 `SYNC` 关掉再打开
2. 或后续补一个“重新拍位对齐”按钮

第一版建议先只支持第 1 种，够用了。

## 8. 同步计算规则

本期不做 `Master Tempo`，只做最朴素的同步：

### 8.1 tempo sync

非 `MASTER` 且 `SYNC=ON` 的 deck：

- 先按 `masterBpm / targetBpm` 算速率

### 8.2 phase sync

如果 deck 处于 `full`：

- 根据 `firstBeatMs + barBeatOffset + bpm` 算出拍位锚点
- 按当前时间轴上的拍位误差做小幅回拉

### 8.3 tempo-only

如果 deck 处于 `tempo-only`：

- 只继续做 BPM 跟随
- 不再做拍位误差回拉

## 9. 推荐的按钮可视规则

### 9.1 MASTER 按钮

- 当前 deck 是 `MASTER`：高亮常亮
- 否则：普通态

### 9.2 SYNC 按钮

- `syncLock = off`：普通态
- `syncLock = full`：高亮常亮
- `syncLock = tempo-only`：高亮闪烁

### 9.3 同时亮起

允许一个 deck 同时出现：

- `MASTER` 亮
- `SYNC` 也亮

这不是冲突，是合法状态。

## 10. 推荐事件流

### 10.1 先播上轨

1. `top play`
2. `top -> MASTER`
3. `top.sync` 如果之前是 `on`，保持 `on`
4. `bottom` 暂无变化

### 10.2 下轨开启 SYNC 后播放

1. 当前 `top = MASTER`
2. 用户点 `bottom SYNC`
3. `bottom.syncEnabled = true`
4. `bottom` 立即按 `top` 做拍位对齐
5. `bottom.syncLock = full`
6. `bottom play`
7. `bottom` 持续跟随 `top`

### 10.3 两边都开 SYNC 后切主

1. `top = MASTER`
2. `top.sync = on`
3. `bottom.sync = on`
4. 用户点 `bottom MASTER`
5. `bottom = MASTER`
6. `top.sync` 保持 `on`
7. `bottom.sync` 保持 `on`
8. 跟随方向改为 `top -> bottom`

### 10.4 跟随中的下轨被手动拖动播放头

1. `top = MASTER`
2. `bottom.sync = on`
3. `bottom.syncLock = full`
4. 用户拖动 `bottom` 播放头
5. `bottom.syncLock -> tempo-only`
6. `bottom` 继续跟 `top` 的 BPM
7. 不再强制拍位锁定

## 11. 第一版实现建议

第一版别上来就写成八爪鱼，按下面顺序做：

1. 补横推双轨独立的同步状态 store
2. 把 `MASTER` 从布尔值改成唯一 `masterDeck`
3. 把 `SYNC` 从假按钮改成每条 deck 的持续开关
4. 补播放器 `playbackRate` 控制接口
5. 接入现有 `mixxxSyncModel.ts` 的 tempo sync + phase sync 算法
6. 先支持 `full` 和 `tempo-only` 两种亮灯逻辑

## 12. 明确不做

本草案当前明确不做：

- `Master Tempo / Key Lock`
- 半拍 / 双拍识别
- 超大 BPM 漂移容错
- 自动报错文案如 `SYNC FAILED`
- 跨设备 / 硬件控制器一致性

这些后面再加，别现在把横推双轨写成一坨屎山。

## 13. 参考依据

本草案的交互语义主要参考：

- rekordbox Export 双播放器里的 `MASTER / BEAT SYNC` 机制
- AlphaTheta 官方关于 `Sync Master` 切换和 `SYNC` 常亮 / 闪烁的 FAQ

落到 FRKB 时做了两点收敛：

1. 只保留双轨软件内交互
2. 暂时忽略 `Master Tempo`
