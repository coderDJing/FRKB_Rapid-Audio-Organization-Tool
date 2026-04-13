# Demucs Runtime Assets Release

## 目的

这套流程用于发布 `demucs-runtime-assets` GitHub Release 资产。

当前资产除了 Stem runtime 之外，还承载 Beat This 运行时依赖与本地 `final0.ckpt` checkpoint。
Windows / macOS GPU runtime 现在必须使用新资产，旧资产会被客户端识别为需要迁移重下。

## RC 与正式版通道

客户端现在按版本默认切换 runtime manifest：

- 正式版：`demucs-runtime-assets`
- 预发布版 / `-rc`：`demucs-runtime-assets-rc`

这意味着：

- `-rc` 客户端不会再读取正式版 runtime manifest
- 正式版客户端不会再读取 RC runtime manifest

如果要临时覆盖，可使用：

- 环境变量 `FRKB_DEMUCS_RUNTIME_RELEASE_TAG`
- 或环境变量 `FRKB_DEMUCS_RUNTIME_MANIFEST_URL`

## 推荐做法

优先使用 GitHub Actions 工作流：

- 工作流：`Demucs Runtime Assets`
- 文件：`.github/workflows/demucs-runtime-assets.yml`

### 首次发布或大版本迁移

首次发布某个 `release_tag`，必须一次性构建全部平台：

- `build_win = true`
- `build_mac_arm64 = true`
- `build_mac_x64 = true`

否则合并阶段拿不到旧 manifest，会直接失败。

### 这次 Beat This 迁移的建议输入

RC 运行时建议先发到：

- `release_tag`: `demucs-runtime-assets-rc`

正式版确认稳定后，再发到：

- `release_tag`: `demucs-runtime-assets`
- `win_profiles`: `cpu,cuda,directml,xpu`
- `mac_arm64_profiles`: `cpu,mps`
- `mac_x64_profiles`: `cpu`
- `build_win = true`
- `build_mac_arm64 = true`
- `build_mac_x64 = true`

如果想强制区分资产版本，可以填写 `asset_version`。
如果想让 RC / 正式版 manifest 明确记录当前应用版本，可以额外填写 `app_version`。

### 正式版优先做 RC 提升

如果正式版发布前最后一个 RC 与正式版之间只有版本号变化，没有其他代码变化，
优先不要重新构建正式版 runtime，而是直接把 RC runtime 提升到正式通道：

- 工作流：`Promote Demucs Runtime Assets`
- 文件：`.github/workflows/promote-demucs-runtime-assets.yml`

输入建议：

- `app_version`: 例如 `1.2.3`
- `source_release_tag`: `demucs-runtime-assets-rc`
- `target_release_tag`: `demucs-runtime-assets`

这会：

- 下载 RC runtime release 当前 manifest 和资产
- 重写 manifest 中的 `releaseTag/archiveUrl/channel/appVersion/appBaseVersion`
- 把同一份资产上传到正式通道

这样正式版 runtime 与最后验过的 RC runtime 保持一致，避免“正式版再次重建出另一份内容”。

## 本地命令

只做本地构建时，可用这些脚本：

```bash
pnpm run demucs:runtime:ensure:win -- --ci --profiles "cpu,cuda,directml,xpu"
pnpm run demucs:runtime:package:win -- --profiles "cpu,cuda,directml,xpu" --release-tag "demucs-runtime-assets"
```

```bash
pnpm run demucs:runtime:ensure:mac-arm64 -- --ci --profiles "cpu,mps"
pnpm run demucs:runtime:package:mac-arm64 -- --profiles "cpu,mps" --release-tag "demucs-runtime-assets"
```

```bash
pnpm run demucs:runtime:ensure:mac-x64 -- --ci --profiles "cpu"
pnpm run demucs:runtime:package:mac-x64 -- --profiles "cpu" --release-tag "demucs-runtime-assets"
```

多平台产物合并：

```bash
pnpm run demucs:runtime:merge -- --input-roots "dist/demucs-runtime-assets-win32-x64,dist/demucs-runtime-assets-darwin-arm64,dist/demucs-runtime-assets-darwin-x64" --output-root "dist/demucs-runtime-assets" --release-tag "demucs-runtime-assets"
```

## 发布后检查

至少检查下面几件事：

1. `demucs-runtime-manifest.json` 中对应资产的 `contentHash` 已更新。
2. manifest 中的 `channel/appVersion/appBaseVersion` 与当前发布通道一致。
3. 新 runtime 解压后存在 `.frkb-runtime-meta.json`，且其中包含：
   - `beatThisInstalled`
   - `beatThisVersion`
   - `beatThisCheckpointRelativePath`
   - `beatThisCheckpointSha256`
4. runtime 目录下存在 `beat-this-checkpoints/final0.ckpt`。
5. Windows 新装或清空 `userData/demucs-runtimes` 后，首次分析会下载 GPU runtime，且 BPM 不再报 `Beat This! Python runtime not available`。
6. 已安装旧 runtime 的环境里，客户端会把旧资产判定为不可用并触发迁移重下。

## 风险说明

这次变更会让 GPU runtime 资产体积上涨，因为 `beat_this` 依赖和 `final0.ckpt` 被直接打进 GPU runtime。

这是当前阶段的有意取舍：

- 优点：用户只需下载一个目标 GPU runtime，体验简单。
- 代价：单个 GPU runtime 资产会比之前更大。

等后续用户规模上来，再评估是否拆成单独的 analysis support 资产。
