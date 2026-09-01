// stable canvas 位图的物理像素宽上限。
// 权衡：越大 → overscan 越大、拖动/滚动越不容易漏出空波形；越小 → promote 时合成面积越小、
// 松手卡顿越轻（实测空档与位图面积正相关：11823px→~105ms，8000px→~100ms，4096px→~66ms）。
// 4096 会让 overscan 小到拖动大波形时漏出空波形（真机确认），故不可用。已恢复为原始值 15360——
// 那是唯一经长期使用验证过滚动/拖动正常的值；8000 亦属未验证的缩水值，同样有漏空波形风险。
// 松手卡顿改由分块/瓦片渲染等方向根治，而非牺牲 overscan。
// 见 drafts/intermittent-bugs/horizontal-browse-live-tempo-release-jitter.md。
const STABLE_MAX_RENDER_SCALED_WIDTH = 15360

export const resolvePixelSnappedCssSize = (value: number, pixelRatio: number) => {
  const safePixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 1
  return Math.max(1, Math.ceil(numeric * safePixelRatio) / safePixelRatio)
}

export const resolveHorizontalBrowseStableOverscanCssPx = (width: number, pixelRatio: number) => {
  const safeWidth = Math.max(1, Number(width) || 1)
  const safePixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1
  const maxRenderWidth = Math.max(safeWidth, STABLE_MAX_RENDER_SCALED_WIDTH / safePixelRatio)
  const maxOverscan = Math.max(0, (maxRenderWidth - safeWidth) * 0.5)
  return Math.min(Math.max(256, safeWidth * 3), maxOverscan)
}

// 关于非对称 overscan（设计文档提出「前向多、后向少」）：
// 当前实现由**优先级调度**承担这件事——前向屏幕外块先补、后向块最后补，几何仍保持左右对称。
// 把几何本身做成非对称会让可见区不再居中于渲染范围，牵动 presentation offset 与播放头对齐的
// 一整套换算（含 tempo 预览过渡期的旧帧 handoff），收益仅是少画一两块屏幕外块，不值这个风险。
// 分块后「必须等的面积」只取决于可见区块数、与 overscan 无关，故保留大 overscan 已无性能代价。

export const setHorizontalBrowseCanvasGeometry = (
  canvas: HTMLCanvasElement | null,
  left: number,
  top: number,
  width: number,
  height: number
) => {
  if (!canvas) return
  Object.assign(canvas.style, {
    left: `${left}px`,
    top: `${top}px`,
    right: 'auto',
    bottom: 'auto',
    width: `${width}px`,
    height: `${height}px`
  })
}

// 分块路径：块容器的 left / top / width / height 与旧的单张超宽 canvas 完全一致，
// 因此 presentation offset、rendered viewport 反解、`.tempo-scaler` 挂载点都无需改动。
// 每块只在容器内部有静态 left / width，统一位移仍挂在容器上（每块独立位移会在边界产生亚像素错位）。
export const setHorizontalBrowseWaveformTileContainerGeometry = (
  container: HTMLElement | null,
  left: number,
  width: number,
  height: number
) => {
  if (!container) return
  Object.assign(container.style, {
    left: `${left}px`,
    top: '0px',
    right: 'auto',
    bottom: 'auto',
    width: `${width}px`,
    height: `${height}px`
  })
}

export const setHorizontalBrowseWaveformTileGeometry = (
  canvas: HTMLCanvasElement | null,
  left: number,
  width: number,
  height: number
) => {
  if (!canvas) return
  Object.assign(canvas.style, {
    position: 'absolute',
    left: `${left}px`,
    top: '0px',
    right: 'auto',
    bottom: 'auto',
    width: `${width}px`,
    height: `${height}px`
  })
}

export const setHorizontalBrowseLiveCanvasGeometry = (
  waveformCanvas: HTMLCanvasElement | null,
  gridCanvas: HTMLCanvasElement | null,
  overlayCanvas: HTMLCanvasElement | null,
  left: number,
  width: number,
  height: number,
  overlayHeight: number
) => {
  setHorizontalBrowseCanvasGeometry(waveformCanvas, left, 0, width, height)
  setHorizontalBrowseCanvasGeometry(gridCanvas, left, 0, width, height)
  setHorizontalBrowseCanvasGeometry(overlayCanvas, left, 0, width, overlayHeight)
}

// 波形侧可以是单张超宽 canvas（旧路径），也可以是块容器 div（分块路径）——两者的 left / width /
// transform 语义完全一致，故这里只要求 HTMLElement。
export const applyHorizontalBrowseCanvasPresentationOffset = (
  waveformCanvas: HTMLElement | null,
  overlayCanvas: HTMLElement | null,
  offsetCssPx: number,
  applyOverlayOffset: boolean
) => {
  if (!waveformCanvas) return
  const clearTransform = (canvas: HTMLElement | null) => canvas?.style.removeProperty('transform')
  const offset = Number(offsetCssPx) || 0
  if (Math.abs(offset) <= 0.001) {
    clearTransform(waveformCanvas)
    clearTransform(overlayCanvas)
    return
  }
  const transform = `translate3d(${offset}px, 0, 0)`
  waveformCanvas.style.transform = transform
  if (applyOverlayOffset) {
    overlayCanvas?.style.setProperty('transform', transform)
  } else {
    clearTransform(overlayCanvas)
  }
}
