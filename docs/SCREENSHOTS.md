# 截图文件说明

## 当前状态

网站已配置为根据日间/夜间主题显示不同的截图。部分截图已有，部分需要补充。

## 截图清单

### 1. 主界面截图

| 语言 | 夜间模式 | 日间模式 |
|------|---------|---------|
| 中文 | ✅ `softwareScreenshot_cn.webp` | ⏳ `softwareScreenshot_cn_light.webp` |
| 英文 | ⏳ `softwareScreenshot.webp` | ⏳ `softwareScreenshot_light.webp` |

**位置**: Hero 区域的主要软件界面截图

---

### 2. 功能截图

#### 中文版

| 功能 | 夜间模式 | 日间模式 |
|------|---------|---------|
| 键盘优先的人机工学 | ✅ `shortcutKey_cn.webp` | ⏳ `shortcutKey_cn_light.webp` |
| 内容感知去重 | ✅ `import_cn.webp` | ⏳ `import_cn_light.webp` |
| 所见即所得的映射 | ✅ `mappingRelation_cn.webp` | ⏳ `mappingRelation_cn_light.webp` |

#### 英文版

| 功能 | 夜间模式 | 日间模式 |
|------|---------|---------|
| Keyboard-First Ergonomics | ⏳ `shortcutKey.webp` | ⏳ `shortcutKey_light.webp` |
| Content-Aware Dedup | ⏳ `import.webp` | ⏳ `import_light.webp` |
| WYSIWYG Mapping | ⏳ `mappingRelation.webp` | ⏳ `mappingRelation_light.webp` |

**位置**: Features 区域的特性卡片

---

## 截图要求

### 文件格式
- **格式**: WebP（推荐）或 PNG
- **命名规则**: 
  - 夜间模式：`功能名.webp` 或 `功能名_cn.webp`
  - 日间模式：`功能名_light.webp` 或 `功能名_cn_light.webp`
- **存放路径**: `docs/public/assets/`

### 尺寸要求
- **宽高比例**: 保持 **16:10** 比例（推荐）
- **不要求固定尺寸**：可以根据实际界面大小调整
- **建议范围**：
  - 主界面截图：宽度 1000-1600px
  - 功能截图：宽度 600-1000px
- **重要**：确保同一功能的中英文、日间夜间截图比例一致

### 拍摄要求
1. **夜间模式**：使用应用的夜间/暗色主题
2. **日间模式**：使用应用的日间/亮色主题
3. 确保界面清晰、无个人信息
4. 背景干净，避免杂乱
5. 窗口大小适中，不要太大或太小
6. 同一功能的不同语言版本保持相同的界面状态和视角

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

## 📊 截图统计

### 总计
- **中文**: 8 张（4 夜间 + 4 日间）
  - ✅ 已有: 3 张夜间截图
  - ⏳ 待补: 1 张夜间 + 4 张日间 = 5 张
- **英文**: 8 张（4 夜间 + 4 日间）
  - ⏳ 待补: 8 张全部

### 待补充截图列表

#### 优先级 1：中文日间模式（4 张）
```
docs/public/assets/
├── softwareScreenshot_cn_light.webp
├── shortcutKey_cn_light.webp
├── import_cn_light.webp
└── mappingRelation_cn_light.webp
```

#### 优先级 2：英文夜间模式（4 张）
```
docs/public/assets/
├── softwareScreenshot.webp
├── shortcutKey.webp
├── import.webp
└── mappingRelation.webp
```

#### 优先级 3：英文日间模式（4 张）
```
docs/public/assets/
├── softwareScreenshot_light.webp
├── shortcutKey_light.webp
├── import_light.webp
└── mappingRelation_light.webp
```

---

## 当前显示效果

- **夜间模式**: 
  - 中文：显示现有的 3 张截图 ✅，1 张显示占位符
  - 英文：全部显示占位符
- **日间模式**: 
  - 全部显示占位符，提示"日间模式截图即将上传..." ✅

---

## 查看占位符效果

1. 访问本地开发服务器：`pnpm run docs:dev`
2. 点击导航栏的太阳图标切换到日间模式
3. 可以看到占位符显示位置

---

## ⚠️ 注意事项

### 文件命名
- 截图文件名必须**完全匹配**，包括大小写
- 中文版截图必须带 `_cn` 后缀
- 日间模式必须带 `_light` 后缀

### 图片质量
- **宽高比例**：保持 16:10 最佳（适合网页显示）
- **文件大小**：建议单张不超过 500KB
- **压缩工具**：推荐使用 [TinyPNG](https://tinypng.com/) 或 [Squoosh](https://squoosh.app/)
- **格式选择**：WebP > PNG > JPG

### 内容一致性
- 所有截图应在**同一软件版本**中拍摄
- 同一功能的中英文版本应该展示**相同的界面状态**
- 窗口大小和视角保持一致
- 避免出现个人信息、测试数据等敏感内容
