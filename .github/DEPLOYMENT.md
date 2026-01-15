# 部署 VitePress 文档站点到 GitHub Pages

## 配置步骤

### 1. 在 GitHub 仓库设置中启用 GitHub Pages

1. 打开仓库页面：https://github.com/coderDJing/FRKB_Rapid-Audio-Organization-Tool
2. 点击 **Settings**（设置）
3. 在左侧菜单中找到 **Pages**
4. 在 **Source** 部分，选择：
   - Source: **GitHub Actions**

### 2. 推送代码触发部署

当您将包含 `docs/` 目录变更的代码推送到 `main` 分支时，GitHub Actions 会自动：
1. 安装依赖（`pnpm install`）
2. 构建 VitePress 站点（`pnpm run docs:build`）
3. 将构建产物部署到 GitHub Pages

### 3. 访问您的网站

部署成功后，您的网站将在以下地址可用：
- **中文版**：https://coderdjing.github.io/FRKB_Rapid-Audio-Organization-Tool/
- **英文版**：https://coderdjing.github.io/FRKB_Rapid-Audio-Organization-Tool/en/

### 4. 手动触发部署（可选）

如果需要手动触发部署：
1. 进入仓库的 **Actions** 标签页
2. 选择左侧的 **Deploy Docs** 工作流
3. 点击右上角的 **Run workflow** 按钮

## 工作流说明

### 触发条件
- 推送到 `main` 分支，且修改了以下文件：
  - `docs/**` - VitePress 文档源文件
  - `package.json` - 依赖配置
  - `pnpm-lock.yaml` - 锁定文件
  - `.github/workflows/deploy-docs.yml` - 工作流配置
- 也可以手动触发（workflow_dispatch）

### 构建产物
- 源代码位置：`docs/`
- 构建输出位置：`docs/.vitepress/dist/`
- 这个输出目录已经在 `.gitignore` 中被忽略，不会提交到仓库

### 环境要求
- Node.js 20
- pnpm 9

## 常见问题

### Q: 部署后访问显示 404
**A**: 确保在 GitHub 仓库设置中将 Pages 的 Source 设置为 **GitHub Actions**，而不是 Deploy from a branch。

### Q: 样式或资源加载失败
**A**: 检查 `docs/.vitepress/config.mts` 中的 `base` 配置是否为 `/FRKB_Rapid-Audio-Organization-Tool/`（仓库名称）。

### Q: 如何查看部署日志
**A**: 进入仓库的 **Actions** 标签页，点击对应的工作流运行记录即可查看详细日志。

### Q: 想要保留原来的 website/ 目录
**A**: 可以保留！`website/` 目录不会被部署，只有 VitePress 构建的 `docs/.vitepress/dist/` 会被部署到 GitHub Pages。

## 本地预览

部署前可以本地预览：

```bash
# 开发模式（实时预览）
pnpm run docs:dev

# 构建并预览生产版本
pnpm run docs:build
pnpm run docs:preview
```

## 迁移说明

### 从旧版 website/ 迁移到 VitePress

旧版静态网站文件仍然保留在 `website/` 目录中，但不再被部署。新的 VitePress 网站提供：
- ✅ 更好的 SEO
- ✅ 更快的页面加载速度
- ✅ 自动生成的静态 HTML
- ✅ 更易于维护的内容结构

如果需要回滚到旧版本，可以创建一个新的工作流来部署 `website/` 目录。
