import { ref } from 'vue'
import {
  applyHorizontalBrowseCanvasPresentationOffset,
  setHorizontalBrowseLiveCanvasGeometry
} from '@renderer/components/horizontalBrowseCanvasGeometry'
import {
  resolveHorizontalBrowseCanvasTranslateX,
  resolveHorizontalBrowseRenderedCanvasViewportStartSec
} from '@renderer/components/horizontalBrowseRenderedCanvasViewport'

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
  let activeIndex = 0
  let presentationTargetIndex: number | null = null

  const waveformCanvases = () => [waveformCanvasRef.value, waveformCanvasBackRef.value]
  const overlayCanvases = () => [overlayCanvasRef.value, overlayCanvasBackRef.value]
  const resolveWaveformCanvas = (index = activeIndex) =>
    waveformCanvases()[normalizeBufferIndex(index, activeIndex)] ?? null
  const resolveOverlayCanvas = (index = activeIndex) =>
    overlayCanvases()[normalizeBufferIndex(index, activeIndex)] ?? null
  const activeWaveformCanvas = () => resolveWaveformCanvas(activeIndex)
  const activeOverlayCanvas = () => resolveOverlayCanvas(activeIndex)
  const presentationWaveformCanvas = () =>
    presentationTargetIndex === null
      ? activeWaveformCanvas()
      : resolveWaveformCanvas(presentationTargetIndex)
  const presentationOverlayCanvas = () =>
    presentationTargetIndex === null
      ? activeOverlayCanvas()
      : resolveOverlayCanvas(presentationTargetIndex)
  const inactiveIndex = () => (activeIndex === 0 ? 1 : 0)

  const syncVisibility = () => {
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
    setHorizontalBrowseLiveCanvasGeometry(
      waveformCanvasRef.value,
      gridCanvasRef.value,
      overlayCanvasRef.value,
      left,
      width,
      height,
      overlayHeight
    )
    setHorizontalBrowseLiveCanvasGeometry(
      waveformCanvasBackRef.value,
      null,
      overlayCanvasBackRef.value,
      left,
      width,
      height,
      overlayHeight
    )
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
    resolveHorizontalBrowseCanvasTranslateX(activeWaveformCanvas())

  const resolveActiveViewportStartSec = (
    rangeStartSec: number | null,
    rangeDurationSec: number | null
  ) =>
    resolveHorizontalBrowseRenderedCanvasViewportStartSec({
      canvas: activeWaveformCanvas(),
      rangeStartSec,
      rangeDurationSec
    })

  return {
    waveformSurfaceRef,
    waveformCanvasRef,
    waveformCanvasBackRef,
    gridCanvasRef,
    overlaySurfaceRef,
    overlayCanvasRef,
    overlayCanvasBackRef,
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
