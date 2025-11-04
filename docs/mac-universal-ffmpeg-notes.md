## macOS 通用（Universal）构建 + FFmpeg 集成：踩坑与最佳实践

### 目标
- 应用“零安装”：FFmpeg 二进制随应用打包，用户无需额外安装。
- 支持 mac 通用（universal）构建：一个 `.app` 同时原生支持 x64 与 arm64。

### electron-builder 25.1.8 的关键点
- 仅支持以下（与当前问题相关）的字段：
  - `mac.x64ArchFiles`: string | null
  - `mac.singleArchFiles`: string | null
- 不支持：`mac.arm64ArchFiles`（此前尝试会触发“未知属性”报错）。
- 通用合并规则（核心）：
  - electron-builder 会先分别打出 x64 与 arm64 两个 `.app`，随后逐文件对比并在相同路径的 Mach-O 上做“胖二进制”合并。
  - 若两个 `.app` 的 Mach-O 文件集合（路径+数量）不一致，会报：
    - “While trying to merge mach-o files across your apps we found a mismatch, the number of mach-o files is not the same …”。
  - 若同一路径存在完全相同的文件，但未被 `x64ArchFiles`（或 `singleArchFiles`）覆盖，会报：
    - “Detected file "…" that's the same in both x64 and arm64 builds and not covered by the x64ArchFiles rule: "…"”。

### 典型失败模式与现象（请避免）
- 在 CI 上“用 arm64 二进制回填 x64 路径”（fallback 复制）：
  - 结果两个 `.app` 里出现“相同文件”，且未声明覆盖规则 → 报“not covered by x64ArchFiles”。
- x64 包仅包含 `Contents/Resources/ffmpeg/darwin-x64/ffmpeg`，arm64 包仅包含 `…/darwin-arm64/ffmpeg`：
  - 两个 `.app` 的 Mach-O 路径不一致 → 报“mismatch, the number of mach-o files is not the same”。
- 依赖 Rosetta + x64 Homebrew 获取 x64 FFmpeg：
  - 在 GitHub Actions（arm64 runner）上不稳定，容易失败；即使成功，也易与 arm64 副本“相同/不同路径”造成上述两类错误。
- 配置了 `mac.arm64ArchFiles`：
  - 该字段在 25.1.8 不被支持，构建会直接校验失败。

### 推荐的稳定方案（实践有效）
1) 在 CI 中“先拿齐两个架构的 ffmpeg”，再用 `lipo` 合成通用二进制：
   - arm64：`brew install ffmpeg` 获取 `arm64`。
   - x64：优先从稳定源获取（如 ffbinaries 或 `ffmpeg-static` NPM 包解包），用 `file` 检查应为 `x86_64`。
   - 用 `lipo` 创建通用胖二进制，输出到固定路径，例如：`vendor/ffmpeg/darwin/ffmpeg`；并 `chmod +x`。
   - 清理 `darwin-arm64/`、`darwin-x64/` 单架构副本，避免被打包。

2) 打包配置（electron-builder）：
   - 使用 `extraResources` 将 `vendor/ffmpeg` 整体带入应用：
     ```json
     {
       "build": {
         "extraResources": [
           { "from": "vendor/ffmpeg", "to": "ffmpeg" }
         ],
         "mac": {
           "x64ArchFiles": "Contents/Resources/ffmpeg/darwin/ffmpeg"
           // 说明：也可用 singleArchFiles 指向同一路径，两者二选一；
           // 重点是：当同一路径的文件在两个包中一致时，需通过其中一个字段声明覆盖规则。
         }
       }
     }
     ```
   - 可选 `afterPack`（仅做日志观测，不做删除）：确保两个架构包都存在同一路径的通用二进制，便于合并。

3) 运行时路径解析（主进程）：优先查找通用路径，其次回退历史路径，保证开发/发行一致性。
   ```ts
   // 要点：优先 darwin/ffmpeg（通用），不存在再回退到旧目录
   const candidateOrder = [
     join(ffmpegRoot, 'darwin', exe),
     join(ffmpegRoot, 'darwin-universal', exe),
     join(ffmpegRoot, 'darwin-arm64', exe),
     join(ffmpegRoot, 'darwin-x64', exe)
   ]
   ```

### 日志与排查清单（强烈建议保留）
- 在“准备 FFmpeg”步骤打印：
  - `uname -a`、`sw_vers`（确认 runner 架构）。
  - `file`、`ls -lh`、`lipo -archs`、`shasum -a 256`（确认二进制真实架构与内容）。
  - `cmp` 对比两端二进制是否完全一致（用于检测误复制/错误来源）。
- 在打包阶段：
  - 任务前设置 `DEBUG=electron-builder`，获取更详细的合并决策日志。
  - 观察 electron-builder 打印的 `{ uniqueToX64, uniqueToArm64 }` 列表：
    - 若出现某路径仅在一侧 → 说明两侧 Mach-O 集合不一致，需要统一路径或删改多余。
    - 若出现“相同文件未覆盖” → 在 `mac.x64ArchFiles`（或 `singleArchFiles`）加入该路径。

### 常见问题解答（FAQ）
- Q：为什么两个架构要“同一路径”放置 FFmpeg？
  - A：通用合并按“同路径匹配”做胖二进制合并。路径集合不一致或未声明覆盖规则就会失败。
- Q：为什么要先合成通用 FFmpeg 再打包？
  - A：这样两个 `.app` 自然拥有“同一路径、同一文件”，合并逻辑最简单、最稳定。
- Q：是否可以不做通用，分别发 x64 与 arm64？
  - A：可以。那就不需要这些规则与 `lipo`，分别构建与发布两个包即可。

### 反模式清单（不要再试）
- 用 arm64 副本回填 x64 路径（或反之），导致两个包中“相同文件”出现，但没有覆盖声明。
- 让两个包的 FFmpeg 处于不同路径（`darwin-x64/ffmpeg` vs `darwin-arm64/ffmpeg`），导致 Mach-O 集合不一致。
- 依赖 `mac.arm64ArchFiles`（该字段在 25.1.8 不支持）。
- 在 afterPack 中删除任一包里的 FFmpeg，导致两包集合差异。

### 最终建议（TL;DR）
1) CI 拉下两个架构的 FFmpeg → 用 `lipo` 合成通用二进制 → 仅保留 `vendor/ffmpeg/darwin/ffmpeg`。
2) `extraResources` 打包进应用；配置 `mac.x64ArchFiles`（或 `singleArchFiles`）指向 `Contents/Resources/ffmpeg/darwin/ffmpeg`。
3) 运行时优先使用 `darwin/ffmpeg`；保留多级回退，兼容老包与开发态。
4) 打开 `DEBUG=electron-builder` 并打印 `file/lipo/shasum/cmp`，一眼看出问题所在。


### Windows 覆盖安装与自动更新命名（electron-builder 25.1.8）

- 保持安装覆盖的关键：
  - `build.appId` 与 `build.productName` 必须稳定且不要随版本变化；
  - `win.executableName` 固定（例如 `FRKB`），避免安装目录或可执行文件名随版本改变；
  - 卸载显示名请配置在 `nsis.uninstallDisplayName`，不要写在 `win` 下。

- 命名与 latest.yml 对齐，避免 404：
  - 统一用连字符（`-`）而非空格或点号拼接文件名；
  - 根级 `artifactName` 及平台级 `win.artifactName`/`mac.artifactName` 要与预期下载 URL 完全一致；
  - 否则旧客户端根据 `latest.yml` 指向 `frkb-Setup-...exe`，而仓库里实际文件若是 `frkb.Setup...exe` 或带空格，会导致 404。

- 版本 25.1.8 的配置限制（容易踩坑）：
  - 不支持 `productFilename`（顶层字段）：配置后会直接校验失败；
  - 不支持 `win.uninstallDisplayName`：应当写在 `nsis.uninstallDisplayName`；
  - `mac.arm64ArchFiles` 不存在，仅有 `mac.x64ArchFiles | mac.singleArchFiles` 二选一；
  - 可使用 `mac.singleArchFiles: "Contents/Resources/ffmpeg/darwin/ffmpeg"` 标记“两个架构相同文件”的合并规则。

- 推荐最小可行配置示例：
  ```json
  {
    "build": {
      "appId": "com.electron.frkb",
      "productName": "FRKB",
      "artifactName": "${productName}-${version}-${os}-${arch}.${ext}",
      "win": {
        "artifactName": "${productName}-Setup-${version}.${ext}",
        "executableName": "FRKB"
      },
      "nsis": {
        "uninstallDisplayName": "FRKB"
      },
      "mac": {
        "singleArchFiles": "Contents/Resources/ffmpeg/darwin/ffmpeg",
        "artifactName": "${productName}-${version}-universal.${ext}"
      }
    }
  }
  ```


