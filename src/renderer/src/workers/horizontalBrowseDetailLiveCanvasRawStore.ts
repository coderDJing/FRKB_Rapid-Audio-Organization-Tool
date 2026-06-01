import type { RawWaveformData } from '@renderer/composables/mixtape/types'
import type {
  HorizontalBrowseDetailLiveCanvasRawMeta,
  HorizontalBrowseDetailLiveCanvasRenderRequest,
  HorizontalBrowseDetailLiveCanvasWorkerIncoming
} from './horizontalBrowseDetailLiveCanvas.types'

type RawChunkPayload = Extract<
  HorizontalBrowseDetailLiveCanvasWorkerIncoming,
  { type: 'applyRawChunk' }
>['payload']

const createEmptyRawData = (meta: HorizontalBrowseDetailLiveCanvasRawMeta): RawWaveformData => {
  const frames = Math.max(0, Math.floor(Number(meta.frames) || 0))
  return {
    duration: Math.max(0, Number(meta.duration) || 0),
    sampleRate: Math.max(0, Number(meta.sampleRate) || 0),
    rate: Math.max(0, Number(meta.rate) || 0),
    frames,
    startSec: Math.max(0, Number(meta.startSec) || 0),
    loadedFrames: Math.max(0, Math.floor(Number(meta.loadedFrames) || 0)),
    minLeft: new Float32Array(frames),
    maxLeft: new Float32Array(frames),
    minRight: new Float32Array(frames),
    maxRight: new Float32Array(frames)
  }
}

const hasSameRawMeta = (current: RawWaveformData, meta: HorizontalBrowseDetailLiveCanvasRawMeta) =>
  current.sampleRate === meta.sampleRate &&
  current.rate === meta.rate &&
  Math.abs((current.startSec ?? 0) - meta.startSec) <= 0.0001 &&
  Math.abs(current.duration - meta.duration) <= 0.0001

const growRawArray = (source: Float32Array, frames: number) => {
  const target = new Float32Array(frames)
  target.set(source.subarray(0, Math.min(source.length, frames)))
  return target
}

export const createHorizontalBrowseDetailLiveCanvasRawStore = (
  invalidateFrameState: () => void
) => {
  let liveRawData: RawWaveformData | null = null
  let retainedRawData: RawWaveformData | null = null
  let liveRawRevision = 0
  let retainedRawRevision = 0
  const bumpLiveRawRevision = () => {
    liveRawRevision += 1
  }

  const ensureCapacity = (meta: HorizontalBrowseDetailLiveCanvasRawMeta, retainCurrent = false) => {
    const frames = Math.max(0, Math.floor(Number(meta.frames) || 0))
    if (!frames) return

    if (!liveRawData || !hasSameRawMeta(liveRawData, meta)) {
      if (retainCurrent && liveRawData) {
        retainedRawData = liveRawData
        retainedRawRevision = liveRawRevision
      }
      liveRawData = createEmptyRawData({ ...meta, frames })
      bumpLiveRawRevision()
      invalidateFrameState()
      return
    }

    if (liveRawData.frames >= frames) {
      if (typeof meta.loadedFrames === 'number') {
        const nextLoadedFrames = Math.max(
          Number(liveRawData.loadedFrames) || 0,
          Math.floor(meta.loadedFrames)
        )
        if (nextLoadedFrames !== liveRawData.loadedFrames) {
          liveRawData.loadedFrames = nextLoadedFrames
          bumpLiveRawRevision()
        }
      }
      return
    }

    liveRawData.duration = Math.max(liveRawData.duration, meta.duration)
    liveRawData.sampleRate = meta.sampleRate
    liveRawData.rate = meta.rate
    liveRawData.frames = frames
    liveRawData.startSec = meta.startSec
    liveRawData.minLeft = growRawArray(liveRawData.minLeft, frames)
    liveRawData.maxLeft = growRawArray(liveRawData.maxLeft, frames)
    liveRawData.minRight = growRawArray(liveRawData.minRight, frames)
    liveRawData.maxRight = growRawArray(liveRawData.maxRight, frames)
    liveRawData.meanLeft = liveRawData.meanLeft
      ? growRawArray(liveRawData.meanLeft, frames)
      : undefined
    liveRawData.meanRight = liveRawData.meanRight
      ? growRawArray(liveRawData.meanRight, frames)
      : undefined
    liveRawData.rmsLeft = liveRawData.rmsLeft
      ? growRawArray(liveRawData.rmsLeft, frames)
      : undefined
    liveRawData.rmsRight = liveRawData.rmsRight
      ? growRawArray(liveRawData.rmsRight, frames)
      : undefined
    bumpLiveRawRevision()
    invalidateFrameState()
  }

  const replace = (rawData: RawWaveformData | null) => {
    liveRawData = rawData
      ? {
          duration: Math.max(0, Number(rawData.duration) || 0),
          sampleRate: Math.max(0, Number(rawData.sampleRate) || 0),
          rate: Math.max(0, Number(rawData.rate) || 0),
          frames: Math.max(0, Number(rawData.frames) || 0),
          startSec: Math.max(0, Number(rawData.startSec) || 0),
          loadedFrames: Math.max(0, Number(rawData.loadedFrames ?? rawData.frames) || 0),
          minLeft: rawData.minLeft,
          maxLeft: rawData.maxLeft,
          minRight: rawData.minRight,
          maxRight: rawData.maxRight,
          meanLeft: rawData.meanLeft,
          meanRight: rawData.meanRight,
          rmsLeft: rawData.rmsLeft,
          rmsRight: rawData.rmsRight
        }
      : null
    retainedRawData = null
    retainedRawRevision = 0
    bumpLiveRawRevision()
    invalidateFrameState()
  }

  const updateMeta = (meta: Partial<HorizontalBrowseDetailLiveCanvasRawMeta>) => {
    if (!liveRawData) return
    let changed = false
    if (typeof meta.duration === 'number' && meta.duration > 0) {
      changed = changed || liveRawData.duration !== meta.duration
      liveRawData.duration = meta.duration
    }
    if (typeof meta.startSec === 'number') {
      changed = changed || Math.abs((liveRawData.startSec ?? 0) - meta.startSec) > 0.0001
      liveRawData.startSec = Math.max(0, meta.startSec)
    }
    if (typeof meta.frames === 'number' && meta.frames > 0) {
      const nextFrames = Math.min(Math.floor(meta.frames), liveRawData.minLeft.length)
      changed = changed || liveRawData.frames !== nextFrames
      liveRawData.frames = nextFrames
    }
    if (typeof meta.loadedFrames === 'number') {
      const nextLoadedFrames = Math.min(
        Math.floor(meta.loadedFrames),
        liveRawData.frames,
        liveRawData.minLeft.length
      )
      changed = changed || liveRawData.loadedFrames !== nextLoadedFrames
      liveRawData.loadedFrames = nextLoadedFrames
    }
    if (changed) {
      bumpLiveRawRevision()
    }
  }

  const applyChunk = (payload: RawChunkPayload) => {
    ensureCapacity(
      {
        duration: payload.duration,
        sampleRate: payload.sampleRate,
        rate: payload.rate,
        frames: payload.frames,
        startSec: payload.startSec,
        loadedFrames: payload.loadedFrames
      },
      true
    )
    if (!liveRawData) return

    const startFrame = Math.max(0, Math.floor(Number(payload.startFrame) || 0))
    const chunkFrames = Math.max(0, Math.floor(Number(payload.chunkFrames) || 0))
    const copyFrames = Math.min(
      chunkFrames,
      payload.minLeft.length,
      payload.maxLeft.length,
      payload.minRight.length,
      payload.maxRight.length,
      Math.max(0, liveRawData.minLeft.length - startFrame)
    )
    if (!copyFrames) return

    liveRawData.minLeft.set(payload.minLeft.subarray(0, copyFrames), startFrame)
    liveRawData.maxLeft.set(payload.maxLeft.subarray(0, copyFrames), startFrame)
    liveRawData.minRight.set(payload.minRight.subarray(0, copyFrames), startFrame)
    liveRawData.maxRight.set(payload.maxRight.subarray(0, copyFrames), startFrame)
    if (
      payload.meanLeft &&
      payload.meanRight &&
      payload.meanLeft.length >= copyFrames &&
      payload.meanRight.length >= copyFrames
    ) {
      if (!liveRawData.meanLeft || liveRawData.meanLeft.length < liveRawData.frames) {
        liveRawData.meanLeft = new Float32Array(liveRawData.frames)
      }
      if (!liveRawData.meanRight || liveRawData.meanRight.length < liveRawData.frames) {
        liveRawData.meanRight = new Float32Array(liveRawData.frames)
      }
      liveRawData.meanLeft.set(payload.meanLeft.subarray(0, copyFrames), startFrame)
      liveRawData.meanRight.set(payload.meanRight.subarray(0, copyFrames), startFrame)
    } else {
      liveRawData.meanLeft = undefined
      liveRawData.meanRight = undefined
    }
    if (
      payload.rmsLeft &&
      payload.rmsRight &&
      payload.rmsLeft.length >= copyFrames &&
      payload.rmsRight.length >= copyFrames
    ) {
      if (!liveRawData.rmsLeft || liveRawData.rmsLeft.length < liveRawData.frames) {
        liveRawData.rmsLeft = new Float32Array(liveRawData.frames)
      }
      if (!liveRawData.rmsRight || liveRawData.rmsRight.length < liveRawData.frames) {
        liveRawData.rmsRight = new Float32Array(liveRawData.frames)
      }
      liveRawData.rmsLeft.set(payload.rmsLeft.subarray(0, copyFrames), startFrame)
      liveRawData.rmsRight.set(payload.rmsRight.subarray(0, copyFrames), startFrame)
    } else {
      liveRawData.rmsLeft = undefined
      liveRawData.rmsRight = undefined
    }
    liveRawData.loadedFrames = Math.max(
      Number(liveRawData.loadedFrames) || 0,
      Math.min(liveRawData.frames, startFrame + copyFrames, Math.floor(payload.loadedFrames || 0))
    )
    bumpLiveRawRevision()
  }

  const resolveForRender = (rawSlot: HorizontalBrowseDetailLiveCanvasRenderRequest['rawSlot']) => {
    if (rawSlot === 'live') return liveRawData
    if (rawSlot === 'retained') return retainedRawData
    return null
  }

  const resolveRevisionForRender = (rawData: RawWaveformData | null) => {
    if (rawData && rawData === liveRawData) return liveRawRevision
    if (rawData && rawData === retainedRawData) return retainedRawRevision
    return 0
  }

  const promoteLiveToRetainedIfSame = (rawData: RawWaveformData | null) => {
    if (!rawData || rawData !== liveRawData) return
    retainedRawData = liveRawData
    retainedRawRevision = liveRawRevision
  }

  const clear = () => {
    liveRawData = null
    retainedRawData = null
    liveRawRevision = 0
    retainedRawRevision = 0
  }

  return {
    applyChunk,
    clear,
    ensureCapacity,
    promoteLiveToRetainedIfSame,
    replace,
    resolveForRender,
    resolveRevisionForRender,
    updateMeta
  }
}
