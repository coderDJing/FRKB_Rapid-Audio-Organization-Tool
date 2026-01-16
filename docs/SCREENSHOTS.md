# 截图文件说明

## 当前状态

网站已配置为根据日间/夜间主题显示不同的截图。部分截图已有，部分需要补充。

## 截图清单

> **说明**: ✅ = 当前已有（将被替换），⏳ = 需要新增

### 1. 主界面截图

| 语言 | 夜间模式 | 日间模式 |
|------|---------|---------|
| 中文 | ✅ `softwareScreenshot_cn.webp` | ⏳ `softwareScreenshot_cn_light.webp` |
| 英文 | ✅ `softwareScreenshot.webp` | ⏳ `softwareScreenshot_light.webp` |

**位置**: Hero 区域的主要软件界面截图  
**用途**: 网站首页顶部展示

---

### 2. 功能截图（网站使用）

#### 中文版

| 功能 | 夜间模式 | 日间模式 |
|------|---------|---------|
| 键盘优先的人机工学 | ✅ `shortcutKey_cn.webp` | ⏳ `shortcutKey_cn_light.webp` |
| 内容感知去重 | ✅ `import_cn.webp` | ⏳ `import_cn_light.webp` |
| 所见即所得的映射 | ✅ `mappingRelation_cn.webp` | ⏳ `mappingRelation_cn_light.webp` |

#### 英文版

| 功能 | 夜间模式 | 日间模式 |
|------|---------|---------|
| Keyboard-First Ergonomics | ✅ `shortcutKey.webp` | ⏳ `shortcutKey_light.webp` |
| Content-Aware Dedup | ✅ `import.webp` | ⏳ `import_light.webp` |
| WYSIWYG Mapping | ✅ `mappingRelation.webp` | ⏳ `mappingRelation_light.webp` |

**位置**: Features 区域的特性卡片  
**用途**: 展示核心功能

---

### 3. 其他功能截图（备用）

这些截图当前在 `docs/public/assets/` 目录中，可用于将来扩展功能展示。

#### 中文版

| 功能 | 夜间模式 | 日间模式 |
|------|---------|---------|
| 元数据编辑 | ✅ `metadata_cn.png` | ⏳ `metadata_cn_light.png` |
| 开源信息 | ✅ `openSource _cn.webp` | ⏳ `openSource _cn_light.webp` |
| 翻译功能 | ✅ `trans_cn.png` | ⏳ `trans_cn_light.png` |

#### 英文版

| 功能 | 夜间模式 | 日间模式 |
|------|---------|---------|
| Metadata Editor | ✅ `metadata.png` | ⏳ `metadata_light.png` |
| Open Source Info | ✅ `openSource.webp` | ⏳ `openSource_light.webp` |
| Translation | ✅ `trans.png` | ⏳ `trans_light.png` |

**用途**: 预留备用，可用于未来添加更多功能展示

---

### 4. 其他资源

| 文件 | 说明 |
|------|------|
| ✅ `icon.webp` | 网站图标 |

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

### 网站使用的截图（核心）
- **中文**: 8 张（4 夜间 + 4 日间）
  - ✅ 已有夜间: 4 张（将全部替换）
  - ⏳ 待补日间: 4 张
- **英文**: 8 张（4 夜间 + 4 日间）
  - ✅ 已有夜间: 4 张（将全部替换）
  - ⏳ 待补日间: 4 张

### 备用功能截图
- **中文**: 6 张（3 夜间 + 3 日间）
  - ✅ 已有夜间: 3 张（将全部替换）
  - ⏳ 待补日间: 3 张
- **英文**: 6 张（3 夜间 + 3 日间）
  - ✅ 已有夜间: 3 张（将全部替换）
  - ⏳ 待补日间: 3 张

### **总计**
- ✅ **现有**: 14 张夜间截图（全部待替换）
- ⏳ **需补**: 14 张日间截图
- 📦 **合计**: 28 张截图

---

## 📝 待补充截图完整清单

### 核心截图（优先）

#### 中文日间模式（4 张）
```
docs/public/assets/
├── softwareScreenshot_cn_light.webp     # 主界面
├── shortcutKey_cn_light.webp            # 快捷键
├── import_cn_light.webp                 # 去重
└── mappingRelation_cn_light.webp        # 映射
```

#### 英文日间模式（4 张）
```
docs/public/assets/
├── softwareScreenshot_light.webp        # 主界面
├── shortcutKey_light.webp               # 快捷键
├── import_light.webp                    # 去重
└── mappingRelation_light.webp           # 映射
```

### 备用截图（次要）

#### 中文日间模式（3 张）
```
docs/public/assets/
├── metadata_cn_light.png                # 元数据
├── openSource _cn_light.webp            # 开源（注意文件名有空格）
└── trans_cn_light.png                   # 翻译
```

#### 英文日间模式（3 张）
```
docs/public/assets/
├── metadata_light.png                   # 元数据
├── openSource_light.webp                # 开源
└── trans_light.png                      # 翻译
```

---

## 当前显示效果

### 网站展示区域
- **夜间模式**: 
  - 中文：显示现有的 4 张截图 ✅（待替换为新版本）
  - 英文：显示现有的 4 张截图 ✅（待替换为新版本）
- **日间模式**: 
  - 中文：4 张全部显示占位符，提示"日间模式截图即将上传..." 
  - 英文：4 张全部显示占位符，提示"日间模式截图即将上传..."

### 备用截图资源
- 额外的 6 张功能截图（中英文各 3 张）已存在于 `assets/` 目录
- 可用于将来扩展功能展示或文档说明
- 同样需要日间模式版本

---

## 查看占位符效果

1. 访问本地开发服务器：`pnpm run docs:dev`
2. 点击导航栏的太阳图标切换到日间模式
3. 可以看到占位符显示位置

---

## 🔄 替换截图流程

### 方案一：逐步替换（推荐）

适合分批截图、逐步更新的情况。

**步骤：**

1. **拍摄新截图**
   - 夜间模式：替换现有的 14 张
   - 日间模式：新增 14 张

2. **替换和添加文件**
   ```bash
   # 将新截图直接放入目录，覆盖同名文件
   docs/public/assets/
   ├── softwareScreenshot_cn.webp           # 覆盖
   ├── softwareScreenshot_cn_light.webp     # 新增
   ├── shortcutKey_cn.webp                  # 覆盖
   ├── shortcutKey_cn_light.webp            # 新增
   └── ... （其他文件同理）
   ```

3. **提交并推送**
   ```bash
   git add docs/public/assets/
   git commit -m "feat(docs): update screenshots with new version
   
   - Replace all 14 dark mode screenshots
   - Add 14 light mode screenshots for theme support"
   git push
   ```

### 方案二：一次性完成

适合准备好所有 28 张截图后一次性提交。

```bash
# 1. 将所有新截图放入目录
docs/public/assets/

# 2. 一次性提交
git add docs/public/assets/
git commit -m "feat(docs): complete screenshot overhaul

- Replace all 14 dark mode screenshots with latest version
- Add 14 light mode screenshots for theme toggle  
- Cover core features and additional screenshots
- Support both Chinese and English languages"
git push
```

### 自动部署

- GitHub Actions 会自动检测更改
- 约 2-3 分钟后完成构建和部署
- 新截图将自动显示在网站上

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
