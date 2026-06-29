import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type { MixxxWaveformData } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import type {
  HorizontalBrowseDirection,
  HorizontalBrowseWaveformLayout,
  HorizontalBrowseWaveformRenderStyle
} from '@renderer/components/horizontalBrowseRawWaveformCanvasTypes'
import type { HorizontalBrowseDetailLiveCanvasWorkerOutgoing } from '@renderer/workers/horizontalBrowseDetailLiveCanvas.types'

type LiveCanvasRenderedPayload = Extract<
  HorizontalBrowseDetailLiveCanvasWorkerOutgoing,
  { type: 'rendered' }
>['payload']

type WaveformLoadDiagnosticBase = {
  direction: HorizontalBrowseDirection
  filePath: string
  waveformLayout: HorizontalBrowseWaveformLayout
  waveformRenderStyle: HorizontalBrowseWaveformRenderStyle
  playing: boolean
  dragging: boolean
  displayReady: boolean
  placeholderVisible: boolean
  preserveSurfaceUntilNextReady: boolean
  currentSec: number | undefined
  previewStartSec: number
  previewBpm: number
  rawData: RawWaveformData | null
  mixxxData: MixxxWaveformData | null
}

type WaveformLoadDiagnosticPayload = Record<
  string,
  string | number | boolean | null | undefined | Record<string, unknown>
>

const WAVEFORM_LOAD_DIAGNOSTIC_REPEAT_SUPPRESS_MS = 1500

const normalizeDiagnosticNumber = (value: unknown, fractionDigits = 3) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Number(numeric.toFixed(fractionDigits))
}

const summarizeRawData = (rawData: RawWaveformData | null) => {
  if (!rawData) return { present: false }
  return {
    present: true,
    startSec: normalizeDiagnosticNumber(rawData.startSec),
    durationSec: normalizeDiagnosticNumber(rawData.duration),
    sampleRate: normalizeDiagnosticNumber(rawData.sampleRate, 0),
    rate: normalizeDiagnosticNumber(rawData.rate, 0),
    frames: normalizeDiagnosticNumber(rawData.frames, 0),
    loadedFrames: normalizeDiagnosticNumber(rawData.loadedFrames ?? rawData.frames, 0),
    minLeftLength: rawData.minLeft.length,
    maxLeftLength: rawData.maxLeft.length,
    minRightLength: rawData.minRight.length,
    maxRightLength: rawData.maxRight.length,
    hasRgb:
      !!rawData.compactColorRed?.length ||
      !!rawData.compactColorGreen?.length ||
      !!rawData.compactColorBlue?.length
  }
}

const resolveMixxxFrameCount = (mixxxData: MixxxWaveformData | null) => {
  if (!mixxxData) return null
  const low = mixxxData.bands?.low
  const mid = mixxxData.bands?.mid
  const high = mixxxData.bands?.high
  const all = mixxxData.bands?.all
  if (!low || !mid || !high || !all) return 0
  return Math.min(
    low.left.length,
    low.right.length,
    mid.left.length,
    mid.right.length,
    high.left.length,
    high.right.length,
    all.left.length,
    all.right.length
  )
}

const summarizeMixxxData = (mixxxData: MixxxWaveformData | null) => ({
  present: !!mixxxData,
  durationSec: normalizeDiagnosticNumber(mixxxData?.duration),
  sampleRate: normalizeDiagnosticNumber(mixxxData?.sampleRate, 0),
  step: normalizeDiagnosticNumber(mixxxData?.step, 0),
  frameCount: resolveMixxxFrameCount(mixxxData)
})

export const createHorizontalBrowseWaveformLoadDiagnostics = (
  resolveBase: () => WaveformLoadDiagnosticBase
) => {
  let lastSignature = ''
  let lastEmittedAtMs = 0
  let awaitingReadyAfterIssue = false

  const buildBasePayload = () => {
    const base = resolveBase()
    return {
      direction: base.direction,
      filePath: base.filePath,
      waveformLayout: base.waveformLayout,
      waveformRenderStyle: base.waveformRenderStyle,
      playing: base.playing,
      dragging: base.dragging,
      displayReady: base.displayReady,
      placeholderVisible: base.placeholderVisible,
      preserveSurfaceUntilNextReady: base.preserveSurfaceUntilNextReady,
      currentSec: normalizeDiagnosticNumber(base.currentSec),
      previewStartSec: normalizeDiagnosticNumber(base.previewStartSec),
      previewBpm: normalizeDiagnosticNumber(base.previewBpm),
      rawData: summarizeRawData(base.rawData),
      mixxxData: summarizeMixxxData(base.mixxxData)
    }
  }

  const emit = (
    event: string,
    reason: string,
    payload: WaveformLoadDiagnosticPayload = {},
    force = false
  ) => {
    try {
      const basePayload = buildBasePayload()
      const signature = JSON.stringify({
        event,
        reason,
        direction: basePayload.direction,
        filePath: basePayload.filePath,
        displayReady: basePayload.displayReady,
        placeholderVisible: basePayload.placeholderVisible,
        rawData: basePayload.rawData,
        mixxxData: basePayload.mixxxData,
        notReadyReason: payload.notReadyReason
      })
      const nowMs = performance.now()
      if (
        !force &&
        signature === lastSignature &&
        nowMs - lastEmittedAtMs < WAVEFORM_LOAD_DIAGNOSTIC_REPEAT_SUPPRESS_MS
      ) {
        return
      }
      lastSignature = signature
      lastEmittedAtMs = nowMs
      window.electron.ipcRenderer.send('outputLog', {
        level: 'warn',
        source: 'renderer',
        scope: 'horizontal-browse-waveform-load',
        message: `[HB-WAVEFORM-LOAD] ${event} ${JSON.stringify({
          event,
          reason,
          ...basePayload,
          ...payload
        })}`
      })
    } catch {}
  }

  return {
    emitMount: (attached: boolean) =>
      emit('worker-mount', attached ? 'attached' : 'attach-failed', { attached }, true),
    emitDrawSkipped: (reason: string, payload: WaveformLoadDiagnosticPayload = {}) => {
      awaitingReadyAfterIssue = true
      emit('draw-skipped', reason, payload)
    },
    emitDrawBlocked: (reason: string, payload: WaveformLoadDiagnosticPayload = {}) => {
      awaitingReadyAfterIssue = true
      emit('draw-blocked', reason, payload)
    },
    emitRawReplace: (rawData: RawWaveformData | null) =>
      emit('raw-replace', rawData ? 'raw-present' : 'raw-null', {
        replacementRawData: summarizeRawData(rawData)
      }),
    emitWorkerRendered: (payload: LiveCanvasRenderedPayload) => {
      if (payload.ready) {
        if (!awaitingReadyAfterIssue) return
        awaitingReadyAfterIssue = false
        emit(
          'worker-rendered',
          'ready',
          {
            renderToken: payload.renderToken,
            rangeStartSec: normalizeDiagnosticNumber(payload.rangeStartSec),
            rangeDurationSec: normalizeDiagnosticNumber(payload.rangeDurationSec),
            renderViewportOnly: payload.renderViewportOnly === true,
            renderTargetIndex: payload.renderTargetIndex,
            stableWaveformSource: payload.stableWaveformSource === true
          },
          true
        )
        return
      }
      awaitingReadyAfterIssue = true
      emit('worker-rendered', 'not-ready', {
        renderToken: payload.renderToken,
        rangeStartSec: normalizeDiagnosticNumber(payload.rangeStartSec),
        rangeDurationSec: normalizeDiagnosticNumber(payload.rangeDurationSec),
        renderViewportOnly: payload.renderViewportOnly === true,
        renderTargetIndex: payload.renderTargetIndex,
        stableWaveformSource: payload.stableWaveformSource === true,
        notReadyReason: payload.notReadyReason
      })
    }
  }
}
