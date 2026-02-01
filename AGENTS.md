# Repository Guidelines

## Project Structure & Module Organization
- `src/main/` Electron main process (app lifecycle, native bridges, IPC handlers).
- `src/preload/` contextBridge layer for safe renderer APIs.
- `src/renderer/` Vue 3 UI, Pinia stores, styles, i18n assets.
- `src/shared/` cross-process utilities; `src/types/` shared TS types.
- `rust_package/` Rust N-API module, with tests in `rust_package/__test__/`.
- `resources/` app assets, `build/` packaging assets, `vendor/` bundled ffmpeg/chromaprint binaries, `out/` build output, `docs/` VitePress documentation site.

## Build, Test, and Development Commands
- `pnpm install` installs root dependencies.
- `pnpm run dev` starts the Electron + Vite dev workflow.
- `pnpm run build` builds main/renderer into `out/`.
- `pnpm run build:win` (or `build:mac`, `build:linux`) packages installers via electron-builder.
- `pnpm run docs:dev` starts VitePress dev server for documentation site.
- `pnpm run docs:build` builds VitePress site into `docs/.vitepress/dist/`.
- `pnpm run docs:preview` previews the built documentation site locally.
- `pnpm run lint` and `pnpm run format` apply ESLint/Prettier rules.
- `cd rust_package` then `napi build --platform --release` builds the native module (requires `@napi-rs/cli`).
- `cd rust_package` then `yarn test` runs `ava` tests.

## Coding Style & Naming Conventions
- Indentation: 2 spaces; LF; trim trailing whitespace; end files with a newline.
- Prettier: single quotes, no semicolons, `printWidth: 100`.
- ESLint extends Vue 3 + Electron toolkit; component names may be single-word.

## Testing Guidelines
- Rust module tests live in `rust_package/__test__/` and follow `*.spec.mjs` naming.
- There is no root JS test runner yet; add new suites near the code they cover and document how to run them.

## Commit & Pull Request Guidelines
- Recent commits use Conventional Commit prefixes with optional scopes: `feat(ui): ...`, `fix(player): ...`, `refactor(...)`, `docs(...)`.
- 提交信息必须使用中文（保留 Conventional Commit 结构）。
- PRs should include a clear summary, testing notes, and screenshots for UI changes; link related issues and call out packaging or native-module impacts.

## Release Rules
- 如果我说“发布预发布版本”，默认执行：更新 `package.json` 版本号为 `X.Y.Z-rc.<当前时间>`（时间格式 `YYYYMMDDHHmm`），提交、打同名 tag，并仅 push tag 触发发布流程。
- 如果当前版本是正式版（不含 `-rc`）且我要求预发布版本，自动把版本号 **补丁位 +1**（`Z+1`，逢 10 进 1，例如 `1.1.9 -> 1.2.0`），再加 `-rc.<当前时间>` 并发布。
- 如果我说“发布正式版”，就把 `-rc.` 以及后面的时间后缀去掉，仅保留 `X.Y.Z`，提交、打同名 tag，并仅 push tag 触发发布流程。

## Documentation Updates
- Do not modify `README.md` or `readme/README_CN.md` without explicit maintainer approval.

## Configuration & Security Tips
- Copy `env.example` to `.env` for local config; never commit secrets.
- If updating `vendor/` binaries, ensure `electron-builder.yml` packaging paths stay in sync.
