# Chromaprint 自定义构建任务说明

## 目标
- 基于 Chromaprint 1.6.0 源码（fork 后仓库），自定义编译出 **Windows（x64）** 与 **macOS（Universal，arm64+x86_64）** 的 libchromaprint。
- 使用 FFmpeg 作为 FFT/解码依赖，确保性能最佳。
- 将生成的 `.dll/.lib`（Win）与 `.dylib/.a`（macOS）随我们的 Electron 应用发布，终端用户无需额外安装 FFmpeg。
- 通过 GitHub Actions 自动化构建，产出预编译包上传至 Release 供主项目下载。

## 必要改动清单

### 1. Fork 仓库
- Fork 官方仓库 [`acoustid/chromaprint`](https://github.com/acoustid/chromaprint) 到我们组织或个人账号下。
- 在 fork 中创建新的分支，例如 `build-with-ffmpeg`。

### 2. 引入 FFmpeg 依赖
- 将 FFmpeg SDK（Windows 与 macOS 对应版本）放置到仓库的 `third_party/ffmpeg/<platform>/`，建议结构：
  - `third_party/ffmpeg/win64/`
  - `third_party/ffmpeg/macos/`
- 包含头文件与库文件：
  - Windows：`include/`，`lib/avcodec.lib`、`avformat.lib`、`avutil.lib`、`swresample.lib` 等。
  - macOS：`include/`，`lib/libavcodec.dylib` 等。

### 3. 修改 CMake 配置
- 在顶层 `CMakeLists.txt` 或新增模块里：
  - 增加 `FFMPEG_ROOT` 默认值指向 `third_party/ffmpeg/<platform>`。
  - 默认 `FFT_LIB=ffmpeg`。
  - Windows：设置 `CMAKE_MSVC_RUNTIME_LIBRARY` 为 `MultiThreaded`（如果需要静态 CRT）。
  - macOS：允许 `CMAKE_OSX_ARCHITECTURES="arm64;x86_64"`。

### 4. 调整安装/产物输出
- 确保 `cmake --build` 完成后能在 `build/Release`（Win）或 `build/Release`（macOS）拿到 `chromaprint.dll/.lib`、`libchromaprint.dylib`。
- 可以新增 CMake 目标把可执行工具 `fpcalc` 关闭（`BUILD_TOOLS=OFF`）。

### 5. GitHub Actions 工作流
- 新建 `.github/workflows/build.yml`：
  - 触发条件：`workflow_dispatch` 或 push。
  - Matrix 平台：`windows-latest`、`macos-latest`。
  - 步骤（示例）：
    ```yaml
    - name: Checkout
      uses: actions/checkout@v4

    - name: Set up FFmpeg (Windows)
      if: runner.os == 'Windows'
      run: |
        echo FFMPEG_ROOT=%CD%\third_party\ffmpeg\win64 >> $GITHUB_ENV

    - name: Configure
      run: cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DFFT_LIB=ffmpeg

    - name: Build
      run: cmake --build build --config Release

    - name: Package
      run: |
        mkdir artifacts
        # 拷贝DLL/Lib或dylib到 artifacts/
    
    - name: Upload artifacts
      uses: actions/upload-artifact@v4
      with:
        name: chromaprint-${{ runner.os }}
        path: artifacts
    ```
  - macOS 额外步骤：`cmake -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64"`。

### 6. Release 发布
- 加入 workflow 步骤：在 tag 发布时自动 Attach 产物至 GitHub Release。
- 产物命名建议：
  - `chromaprint-1.6.0-custom-win64.zip`（内含 `chromaprint.dll`、`chromaprint.lib`）。
  - `chromaprint-1.6.0-custom-macos-universal.tar.gz`（内含 `libchromaprint.dylib` 等）。

### 7. 在主项目集成
- 下载上一步发布的压缩包，解压后分别放置：
  - `rust_package/libs/win32-x64-msvc/{chromaprint.dll, chromaprint.lib}`
  - `rust_package/libs/darwin-universal/{libchromaprint.dylib}`
- 更新 `rust_package/build.rs`：
  ```rust
  #[cfg(target_os = "windows")]
  println!("cargo:rustc-link-search=native=./libs/win32-x64-msvc");

  #[cfg(target_os = "macos")]
  println!("cargo:rustc-link-search=native=./libs/darwin-universal");
  ```
- 重新执行 `napi build --platform --release` 生成 `.node` 文件。

## 注意事项
- FFmpeg SDK 安装位置需在 Actions 中提前准备，可上传到仓库或外部下载。若考虑版权/体积，可换成 KissFFT。
- 如果需要把 FFmpeg 静态链接到 Chromaprint，需确保 Windows/macOS 平台都能提供对应静态库。
- macOS Universal 编译可能需要设置 `CMAKE_OSX_DEPLOYMENT_TARGET`（如 11.0），确保兼容性。

---

有了这份 md，fork 的仓库只需按步骤执行，即可自动产出我们需要的预编译包。“主项目” 后续只需同步更新 `libs/` 目录并编译即可。

