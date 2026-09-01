import { ref } from 'vue'
import {
  applyHorizontalBrowseCanvasPresentationOffset,
  setHorizontalBrowseLiveCanvasGeometry,
  setHorizontalBrowseWaveformTileContainerGeometry,
  setHorizontalBrowseWaveformTileGeometry
} from '@renderer/composables/horizontalBrowse/horizontalBrowseCanvasGeometry'
import {
  resolveHorizontalBrowseCanvasTranslateX,
  resolveHorizontalBrowseRenderedCanvasViewportStartSec
} from '@renderer/composables/horizontalBrowse/horizontalBrowseRenderedCanvasViewport'
import { isHorizontalBrowseWaveformTileRenderingEnabled } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformTileFlag'
import { HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT } from '@renderer/composables/horizontalBrowse/horizontalBrowseWaveformTileLayout'

const normalizeBufferIndex = (value: unknown, fallback: number) => {
  const numeric = Math.floor(Number(value))
  return numeric === 0 || numeric === 1 ? numeric : fallback
}

export const createHorizontalBrowseLiveCanvasBuffers = () => {
  const waveformSurfaceRef = ref<HTMLDivElement | null>(null)
  const overlaySurfaceRef = ref<HTMLDivElement | null>(null)
  const waveformCanvasRef = ref<HTMLCanvasElement | null>(null)
  const waveformCanvasBackRef = ref<HTMLCanvasElement | null>(null)
  const gridCanvasRef = ref<HTMLCanvasElement | null>(null)
  const overlayCanvasRef = ref<HTMLCanvasElement | null>(null)
  const overlayCanvasBackRef = ref<HTMLCanvasElement | null>(null)
  // 分块路径：每 buffer 一个块容器 + 固定数量的块 canvas。
  // 块池必须按 buffer 分开（stable 路径渲染到非活动 buffer 再翻转，两个 buffer 的块内容不共享）。
  const waveformTileContainerRefs = [
    ref<HTMLDivElement | null>(null),
    ref<HTMLDivElement | null>(null)
  ]
  const waveformTileCanvasRefs = [
    ref<Array<HTMLCanvasElement | null>>([]),
    ref<Array<HTMLCanvasElement | null>>([])
  ]
  let activeIndex = 0
  let presentationTargetIndex: number | null = null

  const tileRenderingEnabled = () => isHorizontalBrowseWaveformTileRenderingEnabled()
  const resolveTileContainer = (index: number) =>
    waveformTileContainerRefs[normalizeBufferIndex(index, activeIndex)]?.value ?? null
  const resolveTileCanvases = (index: number) =>
    waveformTileCanvasRefs[normalizeBufferIndex(index, activeIndex)]?.value ?? []
  /** 波形侧的位移 / 几何目标：分块路径下是块容器，旧路径下是单张超宽 canvas。 */
  const resolveWaveformSurfaceTarget = (index: number): HTMLElement | null =>
    tileRenderingEnabled() ? resolveTileContainer(index) : resolveWaveformCanvas(index)

  const waveformCanvases = () => [waveformCanvasRef.value, waveformCanvasBackRef.value]
  const overlayCanvases = () => [overlayCanvasRef.value, overlayCanvasBackRef.value]
  const resolveWaveformCanvas = (index = activeIndex) =>
    waveformCanvases()[normalizeBufferIndex(index, activeIndex)] ?? null
  const resolveOverlayCanvas = (index = activeIndex) =>
    overlayCanvases()[normalizeBufferIndex(index, activeIndex)] ?? null
  const activeWaveformCanvas = () => resolveWaveformCanvas(activeIndex)
  const activeOverlayCanvas = () => resolveOverlayCanvas(activeIndex)
  // presentation 目标：分块路径返回块容器，旧路径返回单张 canvas。二者的 left / width /
  // transform 语义一致，故 presentation controller 无需区分。
  const presentationWaveformCanvas = (): HTMLElement | null =>
    resolveWaveformSurfaceTarget(presentationTargetIndex ?? activeIndex)
  const presentationOverlayCanvas = () =>
    presentationTargetIndex === null
      ? activeOverlayCanvas()
      : resolveOverlayCanvas(presentationTargetIndex)
  const inactiveIndex = () => (activeIndex === 0 ? 1 : 0)

  const syncVisibility = () => {
    // 分块路径下，可见面切换发生在块容器层（整个块集合一起翻转），块本身不参与 opacity。
    waveformTileContainerRefs.forEach((containerRef, index) => {
      const container = containerRef.value
      if (!container) return
      container.style.opacity = index === activeIndex ? '1' : '0'
      container.style.zIndex = index === activeIndex ? '2' : '1'
    })
    waveformCanvases().forEach((canvas, index) => {
      if (!canvas) return
      canvas.style.opacity = index === activeIndex ? '1' : '0'
      canvas.style.zIndex = index === activeIndex ? '2' : '1'
    })
    overlayCanvases().forEach((canvas, index) => {
      if (!canvas) return
      canvas.style.opacity = index === activeIndex ? '1' : '0'
      canvas.style.zIndex = index === activeIndex ? '2' : '1'
    })
  }

  const activate = (index: number) => {
    activeIndex = normalizeBufferIndex(index, activeIndex)
    syncVisibility()
  }

  const setGeometry = (left: number, width: number, height: number, overlayHeight: number) => {
    syncVisibility()
    // 块容器几何与旧单张 canvas 完全一致，overlay 两侧路径共用（overlay 不分块）。
    if (tileRenderingEnabled()) {
      waveformTileContainerRefs.forEach((containerRef) => {
        setHorizontalBrowseWaveformTileContainerGeometry(containerRef.value, left, width, height)
      })
    }
    setHorizontalBrowseLiveCanvasGeometry(
      tileRenderingEnabled() ? null : waveformCanvasRef.value,
      gridCanvasRef.value,
      overlayCanvasRef.value,
      left,
      width,
      height,
      overlayHeight
    )
    setHorizontalBrowseLiveCanvasGeometry(
      tileRenderingEnabled() ? null : waveformCanvasBackRef.value,
      null,
      overlayCanvasBackRef.value,
      left,
      width,
      height,
      overlayHeight
    )
  }

  /** 按渲染计划摆放块的容器内位置。块位图尺寸由 worker 侧设置，这里只管 CSS 布局。 */
  const applyTileLayout = (
    bufferIndex: number,
    tiles: Array<{ slotIndex: number; leftCssPx: number; widthCssPx: number }>,
    heightCssPx: number
  ) => {
    const tileCanvases = resolveTileCanvases(bufferIndex)
    const usedSlots = new Set<number>()
    for (const tile of tiles) {
      const canvas = tileCanvases[tile.slotIndex] ?? null
      if (!canvas) continue
      usedSlots.add(tile.slotIndex)
      setHorizontalBrowseWaveformTileGeometry(canvas, tile.leftCssPx, tile.widthCssPx, heightCssPx)
      canvas.style.visibility = 'visible'
    }
    // 本轮用不到的块藏起来：它们仍持有上一代内容，露出来就是错位画面。
    tileCanvases.forEach((canvas, slotIndex) => {
      if (!canvas || usedSlots.has(slotIndex)) return
      canvas.style.visibility = 'hidden'
    })
  }

  const applyPresentationOffset = (offsetCssPx: number, applyOverlayOffset: boolean) => {
    applyHorizontalBrowseCanvasPresentationOffset(
      presentationWaveformCanvas(),
      presentationOverlayCanvas(),
      offsetCssPx,
      applyOverlayOffset
    )
  }

  const withPresentationTarget = <T>(index: number, callback: () => T) => {
    presentationTargetIndex = normalizeBufferIndex(index, activeIndex)
    try {
      return callback()
    } finally {
      presentationTargetIndex = null
    }
  }

  const resolveActiveTranslateX = () =>
    resolveHorizontalBrowseCanvasTranslateX(resolveWaveformSurfaceTarget(activeIndex))

  const resolveActiveViewportStartSec = (
    rangeStartSec: number | null,
    rangeDurationSec: number | null
  ) =>
    resolveHorizontalBrowseRenderedCanvasViewportStartSec({
      canvas: resolveWaveformSurfaceTarget(activeIndex),
      rangeStartSec,
      rangeDurationSec
    })

  /** 供 worker attach 用：两个 buffer 的块 canvas 展平成 [buffer0 全部块, buffer1 全部块]。 */
  const tileCanvases = () => [resolveTileCanvases(0), resolveTileCanvases(1)]

  return {
    waveformSurfaceRef,
    waveformCanvasRef,
    waveformCanvasBackRef,
    gridCanvasRef,
    overlaySurfaceRef,
    overlayCanvasRef,
    overlayCanvasBackRef,
    waveformTileContainerRefs,
    waveformTileCanvasRefs,
    tileSlotCount: HORIZONTAL_BROWSE_WAVEFORM_TILE_SLOT_COUNT,
    tileCanvases,
    applyTileLayout,
    activeIndex: () => activeIndex,
    inactiveIndex,
    activate,
    syncVisibility,
    setGeometry,
    waveformCanvases,
    overlayCanvases,
    activeWaveformCanvas,
    activeOverlayCanvas,
    presentationWaveformCanvas,
    presentationOverlayCanvas,
    applyPresentationOffset,
    withPresentationTarget,
    resolveActiveTranslateX,
    resolveActiveViewportStartSec
  }
}
