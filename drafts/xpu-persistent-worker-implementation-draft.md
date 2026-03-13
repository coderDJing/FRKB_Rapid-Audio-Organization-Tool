# XPU 常驻 Worker 实施草案

日期：`2026-03-13`

## 目标

在不改变 `htdemucs` 分离质量的前提下，为自动混音 stem 分离引入：

- 按需懒启动
- 自动混音会话内常驻
- 空闲回收
- 失败回退旧路径
- 双 `XPU` 热 worker 池

## 不变项

- 模型：`htdemucs`
- profile：`quality`
- 参数：`shifts=1`、`overlap=0.25`
- 输出文件结构与路径
- 现有 `waveform_inference` 主链

## 变化项

- 不再每首歌都重新拉起 Python
- 不再每首歌都重新加载 `demucs` 与 `torch.xpu` 模型
- 在常驻 worker 内将模型常驻到 `xpu`

## 触发时机

- `App` 启动：不启动 worker
- 打开自动混音窗口：不立即启动 worker
- 第一次真正进入 stem 分离执行：启动 worker
- 自动混音会话内：复用 worker
- 窗口关闭或空闲超时：回收 worker
- idle timeout 分层：
  - `slot 1 = 120s`
  - `slot 2 = 180s`

## 第一版约束

- 只支持 `xpu`
- 只支持 `2` 个热 worker
- 单个 worker 内仍然串行
- 全部 worker 忙时直接回退旧路径
- 任一异常直接回退旧路径

## Node 侧

新增模块建议：

- `src/main/services/mixtapeStemPersistentXpuWorker.ts`

职责：

- 管理 `2` 个 Python 子进程生命周期
- 负责 `warmup / infer / shutdown`
- 管理 stdout JSON line 协议
- 透传 stderr 给现有进度解析
- 实现 idle timeout
- 实现窗口关闭后的回收

## Python 侧

新增脚本建议：

- `vendor/demucs/bootstrap/mixtape_demucs_worker.py`

职责：

- 启动后读取 stdin JSON line
- 初始化时加载 Demucs 模型
- 将模型常驻到 `xpu`
- 接收 `infer` 请求并写 stem
- stdout 返回结果 JSON

## 消息协议

请求：

- `warmup`
- `infer`
- `shutdown`

响应：

- `ready`
- `result`
- `error`

## 回退策略

以下任一情况回退旧路径：

- worker 启动失败
- warmup 失败
- infer 失败
- worker 忙
- worker 崩溃
- 超时

## 验证

- `vue-tsc --noEmit`
- 新旧路径数值对比
- 自动混音窗口关闭后 worker 回收
- 空闲回收
