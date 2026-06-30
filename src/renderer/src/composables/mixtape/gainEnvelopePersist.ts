import { GAIN_ENVELOPE_PERSIST_DEBOUNCE_MS } from '@renderer/composables/mixtape/gainEnvelopeEditorConstants'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment
} from '@renderer/composables/mixtape/types'

/**
 * Gain envelope / volume-mute 的防抖 IPC 持久化。
 * 从 useGainEnvelopeEditor 抽出：状态（待持久化队列 + 计时器）由本模块自持，
 * 不依赖编辑器闭包，对外仅暴露 schedule/flush 四个方法。
 */
export const createGainEnvelopePersistModule = () => {
  const pendingMixEnvelopePersist = new Map<
    string,
    {
      param: MixtapeEnvelopeParamId
      trackId: string
      gainEnvelope: Array<{ sec: number; gain: number }>
    }
  >()
  const pendingVolumeMutePersist = new Map<string, Array<{ startSec: number; endSec: number }>>()
  let mixEnvelopePersistTimer: ReturnType<typeof setTimeout> | null = null
  let volumeMutePersistTimer: ReturnType<typeof setTimeout> | null = null

  const clearMixEnvelopePersistTimer = () => {
    if (!mixEnvelopePersistTimer) return
    clearTimeout(mixEnvelopePersistTimer)
    mixEnvelopePersistTimer = null
  }

  const flushPendingMixEnvelopePersist = async () => {
    clearMixEnvelopePersistTimer()
    if (!pendingMixEnvelopePersist.size || !window?.electron?.ipcRenderer?.invoke) return
    const grouped = new Map<
      MixtapeEnvelopeParamId,
      Array<{ itemId: string; gainEnvelope: Array<{ sec: number; gain: number }> }>
    >()
    for (const item of pendingMixEnvelopePersist.values()) {
      if (!grouped.has(item.param)) grouped.set(item.param, [])
      const list = grouped.get(item.param)
      if (!list) continue
      list.push({
        itemId: item.trackId,
        gainEnvelope: item.gainEnvelope
      })
    }
    pendingMixEnvelopePersist.clear()
    for (const [param, entries] of grouped.entries()) {
      const normalizedEntries = entries.filter(
        (item) =>
          item.itemId.trim().length > 0 &&
          Array.isArray(item.gainEnvelope) &&
          item.gainEnvelope.length >= 2
      )
      if (!normalizedEntries.length) continue
      try {
        await window.electron.ipcRenderer.invoke('mixtape:update-mix-envelope', {
          param,
          entries: normalizedEntries
        })
      } catch (error) {
        console.error('[mixtape] manual mix envelope persist failed', {
          param,
          count: normalizedEntries.length,
          error
        })
      }
    }
  }

  const scheduleMixEnvelopePersist = (
    param: MixtapeEnvelopeParamId,
    trackId: string,
    points: MixtapeGainPoint[]
  ) => {
    const safeTrackId = String(trackId || '').trim()
    if (!safeTrackId || !Array.isArray(points) || points.length < 2) return
    pendingMixEnvelopePersist.set(`${param}:${safeTrackId}`, {
      param,
      trackId: safeTrackId,
      gainEnvelope: points.map((point) => ({
        sec: Number(point.sec),
        gain: Number(point.gain)
      }))
    })
    clearMixEnvelopePersistTimer()
    mixEnvelopePersistTimer = setTimeout(() => {
      mixEnvelopePersistTimer = null
      void flushPendingMixEnvelopePersist()
    }, GAIN_ENVELOPE_PERSIST_DEBOUNCE_MS)
  }

  const clearVolumeMutePersistTimer = () => {
    if (!volumeMutePersistTimer) return
    clearTimeout(volumeMutePersistTimer)
    volumeMutePersistTimer = null
  }

  const flushPendingVolumeMutePersist = async () => {
    clearVolumeMutePersistTimer()
    if (!pendingVolumeMutePersist.size || !window?.electron?.ipcRenderer?.invoke) return
    const entries = Array.from(pendingVolumeMutePersist.entries()).map(([trackId, segments]) => ({
      itemId: trackId,
      segments
    }))
    pendingVolumeMutePersist.clear()
    if (!entries.length) return
    try {
      await window.electron.ipcRenderer.invoke('mixtape:update-volume-mute-segments', {
        entries
      })
    } catch (error) {
      console.error('[mixtape] volume mute segments persist failed', {
        count: entries.length,
        error
      })
    }
  }

  const scheduleVolumeMuteSegmentsPersist = (trackId: string, segments: MixtapeMuteSegment[]) => {
    const safeTrackId = String(trackId || '').trim()
    if (!safeTrackId) return
    pendingVolumeMutePersist.set(
      safeTrackId,
      segments.map((segment) => ({
        startSec: Number(segment.startSec),
        endSec: Number(segment.endSec)
      }))
    )
    clearVolumeMutePersistTimer()
    volumeMutePersistTimer = setTimeout(() => {
      volumeMutePersistTimer = null
      void flushPendingVolumeMutePersist()
    }, GAIN_ENVELOPE_PERSIST_DEBOUNCE_MS)
  }

  return {
    scheduleMixEnvelopePersist,
    flushPendingMixEnvelopePersist,
    scheduleVolumeMuteSegmentsPersist,
    flushPendingVolumeMutePersist
  }
}
