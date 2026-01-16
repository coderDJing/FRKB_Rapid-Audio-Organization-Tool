# 截图文件说明

## 当前状态

网站已配置为根据日间/夜间主题显示不同的截图。目前所有截图都是夜间模式的，日间模式的截图会显示占位符。

## 需要补充的日间模式截图

### 1. 主界面截图

| 语言 | 夜间模式（已有） | 日间模式（待补充） |
|------|-----------------|-------------------|
| 中文 | `softwareScreenshot_cn.webp` | `softwareScreenshot_cn_light.webp` |
| 英文 | `softwareScreenshot.webp` | `softwareScreenshot_light.webp` |

**位置**: Hero 区域的主要软件界面截图

---

### 2. 功能截图

#### 中文版

| 功能 | 夜间模式（已有） | 日间模式（待补充） |
|------|-----------------|-------------------|
| 键盘优先的人机工学 | `shortcutKey_cn.webp` | `shortcutKey_cn_light.webp` |
| 内容感知去重 | `import_cn.webp` | `import_cn_light.webp` |
| 所见即所得的映射 | `mappingRelation_cn.webp` | `mappingRelation_cn_light.webp` |

#### 英文版

| 功能 | 夜间模式（已有） | 日间模式（待补充） |
|------|-----------------|-------------------|
| Keyboard-First Ergonomics | `shortcutKey.webp` | `shortcutKey_light.webp` |
| Content-Aware Dedup | `import.webp` | `import_light.webp` |
| WYSIWYG Mapping | `mappingRelation.webp` | `mappingRelation_light.webp` |

**位置**: Features 区域的特性卡片

---

## 截图要求

### 文件格式
- **格式**: WebP（推荐）或 PNG
- **命名规则**: 原文件名 + `_light` 后缀
- **存放路径**: `docs/public/assets/`

### 尺寸建议
- **主界面截图**: 1200x750 像素左右（16:10 比例）
- **功能截图**: 800x500 像素左右（16:10 比例）

### 拍摄要求
1. 使用应用的日间/亮色主题模式
2. 确保界面清晰、无个人信息
3. 背景干净，避免杂乱
4. 窗口大小适中，不要太大或太小

---

## 上传步骤

1. 将截图文件命名为上述文件名
2. 放入 `docs/public/assets/` 目录
3. 提交并推送代码：
   ```bash
   git add docs/public/assets/
   git commit -m "feat(docs): add light mode screenshots"
   git push
   ```
4. GitHub Actions 会自动部署更新

---

## 当前显示效果

- **夜间模式**: 显示现有的夜间模式截图 ✅
- **日间模式**: 
  - 主界面截图：如果文件不存在，会尝试加载（显示损坏图标）
  - 功能截图：显示占位符，提示"日间模式截图即将上传..." ✅

---

## 查看占位符效果

1. 访问本地开发服务器：`pnpm run docs:dev`
2. 点击导航栏的太阳图标切换到日间模式
3. 可以看到占位符显示位置

---

## 注意事项

- 截图文件名必须完全匹配，包括大小写
- WebP 格式可以减小文件大小，加快加载速度
- 建议使用图片压缩工具优化文件大小（保持质量的同时减小体积）
- 所有截图都应该在同一个软件版本中拍摄，保持界面一致性
