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
- FRKB 不做 Linux 平台；`build:linux` 仅视为历史残留脚本，禁止将 Linux 作为正式支持、发布、验收或修复目标继续扩展。
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
- 禁止编写非必要的 `any` / `as any`；优先使用明确类型，其次使用 `unknown` 配合运行时守卫，最后才允许保留极少数有充分理由的边界类型。
- 禁止用“兜底 / fallback / 回退到系统环境”代替真正修复；如需临时兜底，必须明确标注为临时措施，并继续修复根因后方可交付。
- 单个代码文件不应超过 1100 行；超过 1100 行时必须进行拆分，且拆分后的模块放置位置与命名应符合现有项目结构与习惯。
- 如果用户提出“拆分代码”并指定了行数上限 `N`，则拆分后所有相关文件（包括原文件与新拆出的文件）都必须 `<= N` 行；若用户未指定，则默认执行 `<= 1100` 行规则。
- “拆分”必须为真拆分：禁止把主体逻辑整体挪到一个新文件后，仅在原文件保留单行转发/导入；原文件必须保留清晰且有实际价值的职责边界与实现。
- 拆分完成后必须执行行数校验并在交付时明确给出每个相关文件的实际行数，确保可核验。

## Testing Guidelines
- Rust module tests live in `rust_package/__test__/` and follow `*.spec.mjs` naming.
- There is no root JS test runner yet; add new suites near the code they cover and document how to run them.
- 代码修改完成后必须运行 `npx vue-tsc --noEmit`；若存在错误，必须先修复再交付。

## Debug Logging
- 涉及运行时排查、交互链路排查、状态机排查时，默认把调试日志写入 `log.txt` 可落盘链路，不要依赖浏览器控制台临时输出。
- Renderer 侧调试信息应通过现有 console bridge / `outputLog` / 主进程 `log` 体系进入 `log.txt`，确保我复现一次后，Codex 可以自行读取日志继续排查。
- 禁止把“请把控制台日志复制给我”当成默认方案；除非日志链路本身损坏，否则应优先由 Codex 自己读取 `log.txt`。

## Commit & Pull Request Guidelines
- Recent commits use Conventional Commit prefixes with optional scopes: `feat(ui): ...`, `fix(player): ...`, `refactor(...)`, `docs(...)`.
- 提交信息必须使用中文（保留 Conventional Commit 结构）。
- PRs should include a clear summary, testing notes, and screenshots for UI changes; link related issues and call out packaging or native-module impacts.

## Release Rules
- 如果我说“发布预发布版本”，默认执行：更新 `package.json` 版本号为 `X.Y.Z-rc.<当前时间>`（时间格式 `YYYYMMDDHHmm`），提交，并**先 push main**，再打同名 tag 并 push tag 触发发布流程。
- 如果当前版本是正式版（不含 `-rc`）且我要求预发布版本，自动把版本号 **补丁位 +1**（`Z+1`，逢 10 进 1，例如 `1.1.9 -> 1.2.0`），再加 `-rc.<当前时间>` 并发布。
- 如果我说“发布正式版”，就把 `-rc.` 以及后面的时间后缀去掉，仅保留 `X.Y.Z`，提交，并**先 push main**，再打同名 tag 并 push tag 触发发布流程。
- 发布顺序固定：提交 → push main → 打 tag → push tag。

## Documentation Updates
- Do not modify `README.md` or `readme/README_CN.md` without explicit maintainer approval.

## Configuration & Security Tips
- Copy `env.example` to `.env` for local config; never commit secrets.
- If updating `vendor/` binaries, ensure `electron-builder.yml` packaging paths stay in sync.
