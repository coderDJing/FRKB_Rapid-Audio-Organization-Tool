# 歌单树排序 Icon 待替换说明（交接）

> 用途：新开对话时直接读本文，即可知道**有哪些 icon 需要换**、在哪换、规格是什么。  
> 状态：功能已实现，**图标为临时占位 SVG**，需替换为正式素材。

---

## 1. 一句话结论

库标题栏「排序规则」按钮会按**当前生效的排序规则**切换显示 **5 个不同 icon**。  
目前这 5 个都是写在 `libraryArea.vue` 里的**临时内联 SVG**，需要换成正式设计稿。

**需要替换的数量：5 个。**

---

## 2. 位置（UI）

- 区域：左侧库区域标题栏（`libraryTitle` 右侧工具区）
- 相对位置：在「折叠文件夹」按钮的**左边**
- 行为：
  - 点击 → 右键菜单式列表，选规则
  - 悬停 → `bubbleBox` 显示当前规则文案
  - 非「手动」时按钮带 `isActive`（`color: var(--accent)`）

---

## 3. 需要替换的 5 个 Icon

| # | 规则 key | 含义 | 当前临时图示 | 建议语义 |
|---|----------|------|--------------|----------|
| 1 | `manual` | 手动排序（可拖拽） | 三条横线（列表/手柄感） | 手动 / 自定义顺序 |
| 2 | `nameAsc` | 名称 A→Z | 粗略 “A/Z” 形路径 | 名称升序 |
| 3 | `nameDesc` | 名称 Z→A | 粗略 “Z/A” 形路径 | 名称降序 |
| 4 | `countAsc` | 曲目数 少→多 | 三根递增柱 | 数量升序 |
| 5 | `countDesc` | 曲目数 多→少 | 三根递减柱 | 数量降序 |

### 对应中文 bubble 文案（悬停）

| 规则 key | i18n key | 中文 |
|----------|----------|------|
| `manual` | `playlist.sortRuleManual` | 排序：手动 |
| `nameAsc` | `playlist.sortRuleNameAsc` | 排序：名称 A→Z |
| `nameDesc` | `playlist.sortRuleNameDesc` | 排序：名称 Z→A |
| `countAsc` | `playlist.sortRuleCountAsc` | 排序：曲目数少→多 |
| `countDesc` | `playlist.sortRuleCountDesc` | 排序：曲目数多→少 |

菜单项文案：`playlist.sortMenu*`（无「排序：」前缀）。

---

## 4. 代码接入点（换图时改这里）

### 主文件

`src/renderer/src/pages/modules/libraryArea.vue`

模板中排序按钮内按 `currentSortRule` 分支渲染 5 段内联 `<svg>`：

- `currentSortRule === 'manual'`
- `currentSortRule === 'nameAsc'`
- `currentSortRule === 'nameDesc'`
- `currentSortRule === 'countAsc'`
- `v-else`（`countDesc`）

按钮容器 class：`titleActionButton`（非手动时加 `isActive`）。

### 相关逻辑（一般不用为换 icon 改）

| 文件 | 职责 |
|------|------|
| `src/renderer/src/utils/libraryTreeSort.ts` | 规则类型、localStorage 持久化、显示层排序、曲目数缓存 |
| `src/renderer/src/utils/nearMouseTip.ts` | 自动排序时禁止拖拽的鼠标旁提示 |
| `src/renderer/src/components/libraryItem/index.vue` | 子树显示排序 + 禁止拖拽 |
| `src/renderer/src/components/libraryItem/useLibraryDragAndDrop.ts` | 非手动时禁止树节点重排拖放 |
| `src/renderer/src/i18n/locales/zh-CN/playlist.json` | 中文文案 |
| `src/renderer/src/i18n/locales/en-US/playlist.json` | 英文文案 |

---

## 5. 推荐替换方式

### 规格

- 显示尺寸：**16×16**（按钮容器 20×20，与折叠按钮一致）
- 颜色：优先 **`currentColor`** 单色图标，以便跟随主题 / `isActive` 强调色
- 主题：必须同时适配 `theme-light` / `theme-dark`（走 `currentColor` + CSS 变量即可）
- 格式：SVG 优先（与项目 `src/renderer/src/assets/*.svg` 一致）

### 建议文件名（放到 `src/renderer/src/assets/`）

```
librarySortManual.svg
librarySortNameAsc.svg
librarySortNameDesc.svg
librarySortCountAsc.svg
librarySortCountDesc.svg
```

### 接入模式（与现有 `listIcon` 一致）

```ts
import sortManualIcon from '@renderer/assets/librarySortManual.svg?asset'
// mask 或 <img> / 内联组件，按项目现有 icon 习惯
```

不要用原生 DOM `title` 做悬停提示；继续用现有 `bubbleBox`。

---

## 6. 产品行为备忘（换 icon 时勿破坏）

| 项 | 结论 |
|----|------|
| 排序对象 | 左侧树节点（文件夹/歌单），**不是**曲目列表 |
| 范围 | **整库统一**一套规则 |
| 规则 | 手动 / 名称 A→Z / 名称 Z→A / 曲目数少→多 / 曲目数多→少 |
| 拖拽 | 仅「手动」可拖；自动时禁止 + 鼠标旁提示 |
| 持久化 | **只记规则**（localStorage key: `libraryTreeSortRules`），不写 `library_nodes.sort_order` |
| 文件夹曲目数 | 子树歌单曲目合计 |
| 回收站 | 不显示排序按钮；保持原 reverse 显示 |

---

## 7. 验收清单（换完 icon 后）

- [ ] 5 种规则切换时，标题栏 icon 各不相同且语义清晰
- [ ] 亮/暗主题下 icon 都清晰（`currentColor` 或主题变量）
- [ ] 非手动时 `isActive` 高亮正常
- [ ] 悬停 bubble 仍显示当前规则文案
- [ ] 点击菜单切换规则后 icon 立刻跟着变
- [ ] 折叠按钮样式/位置未回归

---

## 8. 给新对话的最短指令模板

```
请替换歌单树排序的 5 个临时 icon。
说明文档：drafts/library-tree-sort-icons-handoff.md
接入文件：src/renderer/src/pages/modules/libraryArea.vue
规则：manual / nameAsc / nameDesc / countAsc / countDesc
规格：16×16，currentColor，亮暗主题都要适配，继续用 bubbleBox。
```
