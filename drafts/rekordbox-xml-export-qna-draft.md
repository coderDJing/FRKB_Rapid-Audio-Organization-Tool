# Rekordbox XML 一次性交付导出需求草案

更新时间：2026-04-19

## 1. 文档目标

用问答方式收敛 `FRKB -> Rekordbox XML` 一次性交付导出需求。

这份草案只保留：

- 已确认结论
- 必要前提
- 可直接落地的流程

这份草案不再保留：

- 已过期的候选项
- 每轮建议数字
- 冗长历史过程

## 2. 当前范围

当前包含：

- `rekordbox xml` 一次性交付导出
- 用户选择导出目录
- 用户选择 `复制 / 移动`

当前不包含：

- 直接写 `rekordbox master.db`
- 交付后的持续同步
- 交付后的自动修复路径

## 3. 关键前提

- 这次能力的核心语义是 `一次性交付`，不是 `持续托管`
- 文件交付给 Rekordbox 后，默认不再由 FRKB 持续维护其后续路径变化
- 第一版默认用户已开启 Rekordbox 的 `Auto Analysis`
- Rekordbox 是否自动分析，关键取决于轨道是否加入 `Collection`，以及 `Auto Analysis` 是否开启
- 支持标签的音频文件加入 `Collection` 后，Rekordbox 会自行读取并显示标签
- `WAVE` 文件存在标签显示例外
- 第一版不以 FRKB 自己的分析数据覆盖 Rekordbox 的分析结果

## 4. 已确认问答

### Q1 操作对象

- A：第一版同时支持 `选中歌曲` 和 `整个播放列表`

### Q2 移动后 FRKB 处理

- A：`移动` 导出完成后，直接从 FRKB 库中移除这批歌曲

### Q3 导出完成后的动作

- A：无论 `复制` 还是 `移动`，导出完成后都自动打开 XML 所在目录

### Q4 选中歌曲导出时的 XML 组织

- A：同时写入 `Collection` 和一个自动创建的播放列表

### Q5 选中歌曲导出的播放列表名

- A：默认自动生成，但允许用户在导出前修改

### Q6 整个播放列表导出的播放列表名

- A：默认沿用当前播放列表名称，但允许用户在导出前修改

### Q7 导出目录下的落盘结构

- A：在用户选择的导出目录下，自动创建一个本次导出子目录，并将音频文件和 XML 都放进去

### Q8 导出子目录名

- A：默认自动生成，但允许用户在导出前修改

说明：

- `Q5` 讨论的是 XML 内的播放列表名
- `Q8` 讨论的是磁盘上的导出子目录名
- 两者第一版不要求同名

### Q9 音频文件名

- A：默认保留原文件名；如重名则自动追加序号

### Q10 目标目录已有同名文件

- A：自动追加序号，继续导出

### Q11 导出中途有文件失败

- A：整批失败
- A：已处理文件尽量回滚
- A：不生成最终 XML
- A：不修改 FRKB 库

### Q12 第一版 XML 导出内容

- A：只导出 `文件路径 + 播放列表结构`
- A：基础元数据默认交给 Rekordbox 从音频文件标签中自行读取
- A：分析结果默认交给 Rekordbox 基于 `Auto Analysis` 自行生成

### Q13 功能入口

- A：`选中歌曲` 走歌曲右键菜单
- A：`整个播放列表` 走播放列表右键菜单

### Q14 导出前交互方式

- A：使用单个导出对话框，一次性确认全部关键参数

### Q15 导出对话框展示字段

- A：展示 `导出目录`
- A：展示 `复制 / 移动`
- A：展示 `导出子目录名`
- A：展示 `XML 播放列表名`（有需要时）

### Q16 XML 文件名

- A：默认自动生成，但允许用户在导出前修改

### Q17 移动模式的额外确认

- A：不追加额外二次确认
- A：用户在主导出对话框中明确选择 `移动`，即视为已确认

### Q18 是否记住上次导出设置

- A：记住稳定设置：`导出目录`、`复制 / 移动`
- A：名称类字段每次重新自动生成默认值，不直接复用上次输入

### Q19 导出成功后的反馈

- A：展示结果摘要
- A：摘要至少包含 `导出模式`、`成功歌曲数`、`导出目录`、`XML 路径`
- A：同时自动打开导出目录

### Q20 导出失败后的反馈

- A：展示失败摘要
- A：摘要至少说明 `失败原因`、`是否已回滚`、`FRKB 库未被修改`
- A：提示用户可查看日志继续排查

### Q21 导出执行中的反馈

- A：显示整体进度
- A：允许用户取消
- A：取消后按失败流程处理，并尽量回滚

### Q22 选中歌曲导出时的曲目顺序

- A：按当前歌曲列表界面的显示顺序

### Q23 整个播放列表导出时的曲目顺序

- A：按该播放列表当前保存的原始顺序

### Q24 第一版支持的来源

- A：只支持 FRKB 正常库中的歌曲和播放列表
- A：以下来源第一版不支持：`回收站`、`外部列表`、`Rekordbox 外部源`

### Q25 不支持来源的 UI 表现

- A：直接不显示 `导出到 Rekordbox XML` 菜单项

### Q26 导出对象里存在丢失文件

- A：导出前先做整批校验
- A：发现任意 `源文件已丢失 / 路径无效` 的曲目，就直接阻止导出，并提示用户先修复

## 5. 汇总流程

### 5.1 入口

- 歌曲右键菜单：导出当前选中歌曲
- 播放列表右键菜单：导出整个播放列表

### 5.2 导出对话框

第一版对话框包含：

- 导出目录
- `复制 / 移动`
- 导出子目录名
- XML 文件名
- XML 播放列表名（按对象类型决定是否展示或默认填充）

默认值规则：

- 记住导出目录
- 记住 `复制 / 移动`
- 名称类字段每次自动重新生成默认值

### 5.3 导出前校验

- 校验来源是否属于支持范围
- 校验所有待导出歌曲的源文件路径有效
- 任意歌曲缺失则阻止整批导出

### 5.4 执行阶段

- 创建本次导出子目录
- 按规则复制或移动音频文件
- 生成 XML
- 导出期间展示整体进度
- 允许用户取消

### 5.5 失败语义

- 任意文件处理失败则整批失败
- 已处理文件尽量回滚
- 不生成最终 XML
- 不修改 FRKB 库
- 用户取消也走同一套失败语义

### 5.6 成功语义

- `复制`：FRKB 保留原曲目
- `移动`：FRKB 从库中移除这批曲目
- 成功后展示摘要并自动打开导出目录

## 6. 当前实现上下文

仓库里已存在相关 UI 入口基础：

- 歌曲右键菜单：
  [useSongItemContextMenu.ts](D:/playground/FRKB_Rapid-Audio-Organization-Tool-3/src/renderer/src/pages/modules/songsArea/composables/useSongItemContextMenu.ts)
- 播放列表右键菜单：
  [useLibraryContextMenu.ts](D:/playground/FRKB_Rapid-Audio-Organization-Tool-3/src/renderer/src/components/libraryItem/useLibraryContextMenu.ts)

这意味着第一版优先在现有右键菜单上加入口，不需要单独造新的全局页面。

## 7. 当前状态

- 已确认到 `Q26`
- 当前草案已压缩为结论版
- 已补充第一版 `实现方案拆分`

## 8. 实现方案拆分

### 8.1 总体策略

- 第一版不要把逻辑继续硬塞进现有通用导出代码里
- 建议新建独立的 `Rekordbox XML 导出` 模块，避免把普通导出和 XML 一次性交付揉成一坨
- 现有通用能力可以复用：
  - 文件复制/移动并发执行
  - 进度事件
  - 中断处理
  - 现有导出对话框的交互风格

### 8.2 Renderer 拆分

#### A. 新导出对话框

- 新建独立对话框组件，例如：
  - `src/renderer/src/components/rekordboxXmlExportDialog.vue`
  - `src/renderer/src/components/rekordboxXmlExportDialog.ts`
- 不直接复用老的 [exportDialog.vue](D:/playground/FRKB_Rapid-Audio-Organization-Tool-3/src/renderer/src/components/exportDialog.vue)
- 原因：
  - 老对话框只覆盖 `目录 + 删除后导出`
  - 新需求还需要 `导出子目录名`、`XML 文件名`、`XML 播放列表名`
  - 强塞扩展会把老对话框搞脏

#### B. 右键菜单入口

- 歌曲右键菜单加入口：
  [useSongItemContextMenu.ts](D:/playground/FRKB_Rapid-Audio-Organization-Tool-3/src/renderer/src/pages/modules/songsArea/composables/useSongItemContextMenu.ts)
- 播放列表右键菜单加入口：
  [useLibraryContextMenu.ts](D:/playground/FRKB_Rapid-Audio-Organization-Tool-3/src/renderer/src/components/libraryItem/useLibraryContextMenu.ts)
- 不支持来源直接不显示菜单项

#### C. 前端参数拼装

- 歌曲导出时：
  - 取当前选中歌曲
  - 取当前歌曲区显示顺序
- 播放列表导出时：
  - 取播放列表 UUID
  - 由主进程按播放列表原始顺序加载曲目

#### D. 默认值持久化

- 第一版建议沿用现有导出对话框做法，使用 renderer 侧本地存储
- 只保存：
  - 导出目录
  - `复制 / 移动`
- 不把这类一次性交付偏好塞进全局设置文件，先缩小影响面

### 8.3 Main 拆分

#### A. 新 IPC 入口

- 建议新增独立 IPC 文件，例如：
  - `src/main/ipc/rekordboxXmlExportHandlers.ts`
- 在 [index.ts](D:/playground/FRKB_Rapid-Audio-Organization-Tool-3/src/main/index.ts) 注册

#### B. 新服务目录

- 建议新增：
  - `src/main/services/rekordboxXmlExport/types.ts`
  - `src/main/services/rekordboxXmlExport/validate.ts`
  - `src/main/services/rekordboxXmlExport/fileStage.ts`
  - `src/main/services/rekordboxXmlExport/xmlBuilder.ts`
  - `src/main/services/rekordboxXmlExport/execute.ts`

职责建议：

- `types.ts`
  - 定义请求参数、结果摘要、失败摘要、进度事件类型
- `validate.ts`
  - 校验来源是否合法
  - 校验源文件是否存在
  - 校验播放列表对象是否可导出
- `fileStage.ts`
  - 创建导出子目录
  - 执行复制/移动
  - 处理重名自动追加序号
  - 记录已成功处理文件，供回滚使用
- `xmlBuilder.ts`
  - 生成符合 `rekordbox xml` 的 XML 文本
  - 第一版只写 `Collection + Playlist structure + Location`
- `execute.ts`
  - 串起校验、文件处理、XML 生成、回滚、结果摘要

#### C. 曲目来源解析

- 歌曲导出：
  - renderer 直接传曲目清单和显示顺序
- 播放列表导出：
  - main 根据播放列表 UUID 重新取曲目
  - 确保顺序使用播放列表原始顺序，而不是临时 UI 排序

#### D. 成功后的 FRKB 库处理

- `复制`：
  - 不改 FRKB 库
- `移动`：
  - 复用现有删除/移除链路，把这批歌从 FRKB 库移除
- 这一段必须放在：
  - 文件移动成功
  - XML 成功落盘
  - 整批确认成功
 之后再执行

#### E. 日志

- 关键日志必须写入 `log.txt` 链路
- 至少记录：
  - 导出开始参数摘要
  - 校验失败原因
  - 文件处理失败原因
  - 回滚结果
  - XML 输出路径
  - 最终成功/失败摘要

### 8.4 复用与隔离边界

- 可复用：
  [exportHandlers.ts](D:/playground/FRKB_Rapid-Audio-Organization-Tool-3/src/main/ipc/exportHandlers.ts) 里的并发文件处理思路和进度事件模型
- 不建议直接复用：
  [exportHandlers.ts](D:/playground/FRKB_Rapid-Audio-Organization-Tool-3/src/main/ipc/exportHandlers.ts) 现有 `exportSongsToDir/exportSongListToDir`
- 原因：
  - 现有实现默认不是“整批失败 + XML 事务式交付”语义
  - 现有实现也没有 XML 生成、整批预校验、回滚摘要这些边界

### 8.5 实现顺序

#### 第一阶段

- 落类型定义
- 落 XML builder
- 落导出前校验

#### 第二阶段

- 落主进程执行链路
- 落复制/移动与回滚
- 落进度和取消

#### 第三阶段

- 落 renderer 对话框
- 接入歌曲右键菜单
- 接入播放列表右键菜单

#### 第四阶段

- 补 i18n 文案
- 补成功/失败摘要
- 补日志验证

### 8.6 验证清单

- `选中歌曲 + 复制` 成功
- `选中歌曲 + 移动` 成功，且 FRKB 库中曲目被移除
- `整个播放列表 + 复制` 成功，顺序正确
- `整个播放列表 + 移动` 成功，顺序正确
- 目标目录已有重名文件时自动追加序号
- 任意源文件缺失时，导出前即被阻止
- 导出中途失败时：
  - 已处理文件尽量回滚
  - 不生成最终 XML
  - FRKB 库未修改
- 用户取消时走同一套失败语义

### 8.7 当前建议

- 下一步不要继续加需求题
- 直接按上面的模块拆分进入实现
- 实现时优先做 `复制` 路径跑通，再接 `移动`
