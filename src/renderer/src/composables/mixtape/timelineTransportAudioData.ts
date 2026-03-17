import type { Ref } from 'vue'
import { canPlayHtmlAudio, toPreviewUrl } from '@renderer/pages/modules/songPlayer/webAudioPlayer'
import {
  normalizeBeatOffset as normalizeBeatOffsetByMixxx,
  resolveBeatSecByBpm,
  resolveGridAnchorSec
} from '@renderer/composables/mixtape/mixxxSyncModel'
import { MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM } from '@renderer/composables/mixtape/gainEnvelope'
import {
  buildTrackRuntimeTempoSnapshot,
  serializeTrackRuntimeTempoSnapshot
} from '@renderer/composables/mixtape/trackRuntimeTempoSnapshot'
import { normalizeVolumeMuteSegments } from '@renderer/composables/mixtape/volumeMuteSegments'
import type {
  MixtapeEnvelopeParamId,
  MixtapeGainPoint,
  MixtapeMuteSegment,
  SerializedTrackTempoSnapshot,
  MixtapeTrack
} from '@renderer/composables/mixtape/types'

type MixtapeStemStatusValue = 'pending' | 'running' | 'ready' | 'failed'

type TimelineSequentialLayoutEntry = {
  track: MixtapeTrack
  startSec: number
  startX: number
}

type TimelineTransportAudioDataCtx = {
  tracks: Ref<MixtapeTrack[]>
  playheadSec: Ref<number>
  normalizedRenderZoom: Ref<number>
  timelineLayout: Ref<{ totalWidth: number }>
  resolveRenderPxPerSec: (zoom: number) => number
  buildSequentialLayoutForZoom: (zoom: number) => {
    layout: TimelineSequentialLayoutEntry[]
  }
  resolveTimelineSecByX: (x: number, pxPerSec: number) => number
  resolveTrackSourceDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackTempoRatio: (track: MixtapeTrack, targetBpm?: number) => number
  resolveTrackFirstBeatSeconds: (track: MixtapeTrack, bpm?: number) => number
  resolveTrackDurationSeconds: (track: MixtapeTrack) => number
  resolveTrackStartSec: (track: MixtapeTrack) => number
  resolveTrackMixEnvelope: (
    track: MixtapeTrack,
    duration: number,
    param: MixtapeEnvelopeParamId
  ) => MixtapeGainPoint[]
  resolveMixEnvelopeParams: () => MixtapeEnvelopeParamId[]
  resolveStemIdsForMode: () => TransportStemId[]
  resolveTrackStemFilePath: (track: MixtapeTrack, stemId: TransportStemId) => string
  isStemMixMode: () => boolean
  normalizeMixtapeStemStatus: (value: unknown) => MixtapeStemStatusValue
  ensureTransportAudioContext: (sampleRate?: number) => AudioContext
  transportPreloading: Ref<boolean>
  transportPreloadDone: Ref<number>
  transportPreloadTotal: Ref<number>
  transportPreloadFailed: Ref<number>
}

export type TransportStemId = 'vocal' | 'inst' | 'bass' | 'drums'

export type TransportAudioRef = {
  filePath: string
  decodeMode: 'browser' | 'ipc'
  audioBuffer: AudioBuffer | null
}

export type TransportStemAudioRef = {
  stemId: TransportStemId
  filePath: string
  decodeMode: 'browser' | 'ipc'
  audioBuffer: AudioBuffer | null
}

type PreloadAudioRef = TransportAudioRef | TransportStemAudioRef

export type TransportEntry = {
  trackId: string
  filePath: string
  startSec: number
  bpm: number
  originalBpm: number
  tempoSnapshot: SerializedTrackTempoSnapshot
  beatSec: number
  firstBeatSec: number
  barBeatOffset: number
  masterTempo: boolean
  syncAnchorSec: number
  sourceDuration: number
  duration: number
  tempoRatio: number
  mixEnvelopes: Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[]>>
  mixEnvelopeSources: Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[] | undefined>>
  volumeMuteSegments: MixtapeMuteSegment[]
  volumeMuteSegmentsSource?: MixtapeMuteSegment[]
  audioRef?: TransportAudioRef
  stemAudioById?: Partial<Record<TransportStemId, TransportStemAudioRef>>
}

const TRANSPORT_PRELOAD_PRIORITY_TRACK_LIMIT = 3

const normalizePcmData = (pcmData: unknown): Float32Array => {
  if (!pcmData) return new Float32Array(0)
  if (pcmData instanceof Float32Array) return pcmData
  if (pcmData instanceof ArrayBuffer) return new Float32Array(pcmData)
  if (ArrayBuffer.isView(pcmData)) {
    const view = pcmData as ArrayBufferView
    return new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4))
  }
  return new Float32Array(0)
}

const fillAudioBufferFromInterleavedPcm = (
  buffer: AudioBuffer,
  pcmData: Float32Array,
  channels: number,
  frameCount: number
) => {
  if (channels <= 1) {
    buffer.getChannelData(0).set(pcmData.subarray(0, frameCount))
    return
  }

  if (channels === 2) {
    const left = buffer.getChannelData(0)
    const right = buffer.getChannelData(1)
    let readIndex = 0
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      left[frameIndex] = pcmData[readIndex]
      right[frameIndex] = pcmData[readIndex + 1]
      readIndex += 2
    }
    return
  }

  for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
    const channelData = buffer.getChannelData(channelIndex)
    let readIndex = channelIndex
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      channelData[frameIndex] = pcmData[readIndex]
      readIndex += channels
    }
  }
}

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const normalizeBeatOffset = (value: unknown, interval: number) => {
  return normalizeBeatOffsetByMixxx(value, interval)
}

export const createTimelineTransportAudioDataModule = (ctx: TimelineTransportAudioDataCtx) => {
  const transportDecodedBufferCache = new Map<string, AudioBuffer>()
  const transportDecodeInflight = new Map<string, Promise<AudioBuffer>>()
  let transportPreloadVersion = 0
  let transportPreloadTimer: ReturnType<typeof setTimeout> | null = null

  const resolveTrackDurationByBpm = (track: MixtapeTrack, targetBpm: number) => {
    const sourceDuration = ctx.resolveTrackSourceDurationSeconds(track)
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) return 0
    const tempoRatio = ctx.resolveTrackTempoRatio(track, targetBpm)
    if (!Number.isFinite(tempoRatio) || tempoRatio <= 0) return sourceDuration
    return sourceDuration / Math.max(0.01, tempoRatio)
  }

  const remapVolumeMuteSegmentsForBpm = (track: MixtapeTrack, targetBpm: number) => {
    const sourceDuration = ctx.resolveTrackDurationSeconds(track)
    const targetDuration = resolveTrackDurationByBpm(track, targetBpm)
    const sourceSegments = normalizeVolumeMuteSegments(track.volumeMuteSegments, sourceDuration)
    if (!sourceSegments.length) return [] as MixtapeMuteSegment[]
    const sourceBpm = Number(track.bpm)
    const sourceBeatSec = resolveBeatSecByBpm(sourceBpm)
    const targetBeatSec = resolveBeatSecByBpm(targetBpm)
    if (
      !Number.isFinite(sourceBeatSec) ||
      !sourceBeatSec ||
      !Number.isFinite(targetBeatSec) ||
      !targetBeatSec ||
      !targetDuration
    ) {
      return normalizeVolumeMuteSegments(sourceSegments, targetDuration || sourceDuration)
    }
    const sourceFirstBeatSec = ctx.resolveTrackFirstBeatSeconds(track, sourceBpm)
    const targetFirstBeatSec = ctx.resolveTrackFirstBeatSeconds(track, targetBpm)
    const beatSnapEpsilon = 0.0005
    const remapped = sourceSegments
      .map((segment) => {
        const startBeatRaw = (segment.startSec - sourceFirstBeatSec) / sourceBeatSec
        const endBeatRaw = (segment.endSec - sourceFirstBeatSec) / sourceBeatSec
        const startBeatNearest = Math.round(startBeatRaw)
        const endBeatNearest = Math.round(endBeatRaw)
        const startBeat =
          Math.abs(startBeatRaw - startBeatNearest) <= beatSnapEpsilon
            ? startBeatNearest
            : startBeatRaw
        const endBeat =
          Math.abs(endBeatRaw - endBeatNearest) <= beatSnapEpsilon ? endBeatNearest : endBeatRaw
        const remappedStart = clampNumber(
          targetFirstBeatSec + startBeat * targetBeatSec,
          0,
          targetDuration
        )
        const remappedEnd = clampNumber(
          targetFirstBeatSec + endBeat * targetBeatSec,
          0,
          targetDuration
        )
        if (remappedEnd - remappedStart <= 0.0001) return null
        return {
          startSec: Number(remappedStart.toFixed(4)),
          endSec: Number(remappedEnd.toFixed(4))
        }
      })
      .filter((segment): segment is MixtapeMuteSegment => segment !== null)
    return normalizeVolumeMuteSegments(remapped, targetDuration)
  }

  const readTransportBufferCache = (filePath: string): AudioBuffer | null => {
    const key = String(filePath || '').trim()
    if (!key) return null
    const cached = transportDecodedBufferCache.get(key) || null
    if (!cached) return null
    transportDecodedBufferCache.delete(key)
    transportDecodedBufferCache.set(key, cached)
    return cached
  }

  const writeTransportBufferCache = (filePath: string, buffer: AudioBuffer) => {
    const key = String(filePath || '').trim()
    if (!key || !buffer) return
    if (transportDecodedBufferCache.has(key)) {
      transportDecodedBufferCache.delete(key)
    }
    transportDecodedBufferCache.set(key, buffer)
  }

  const clearTransportPreloadTimer = () => {
    if (!transportPreloadTimer) return
    clearTimeout(transportPreloadTimer)
    transportPreloadTimer = null
  }

  const resetTransportPreloadProgress = () => {
    ctx.transportPreloadTotal.value = 0
    ctx.transportPreloadDone.value = 0
    ctx.transportPreloadFailed.value = 0
  }

  const resolveTransportPreloadConcurrencyCap = () => {
    const logicalCpuCount =
      typeof navigator !== 'undefined' ? Math.max(1, Number(navigator.hardwareConcurrency) || 1) : 4
    return logicalCpuCount >= 16
      ? 8
      : logicalCpuCount >= 12
        ? 6
        : logicalCpuCount >= 8
          ? 5
          : logicalCpuCount >= 4
            ? 4
            : 3
  }

  const cancelTransportPreload = () => {
    transportPreloadVersion += 1
    ctx.transportPreloading.value = false
    clearTransportPreloadTimer()
  }

  const buildTransportEntries = () => {
    const pxPerSec = Math.max(0.0001, ctx.resolveRenderPxPerSec(ctx.normalizedRenderZoom.value))
    const snapshot = ctx.buildSequentialLayoutForZoom(ctx.normalizedRenderZoom.value)
    const startSecById = new Map<string, number>()
    for (const item of snapshot.layout) {
      const layoutStartSec = Number(item.startSec)
      startSecById.set(
        item.track.id,
        Number.isFinite(layoutStartSec) && layoutStartSec >= 0
          ? layoutStartSec
          : ctx.resolveTimelineSecByX(item.startX, pxPerSec)
      )
    }
    let missingDurationCount = 0
    let stemNotReadyCount = 0
    let missingStemAssetCount = 0
    const useStemMode = ctx.isStemMixMode()
    const entries = ctx.tracks.value
      .map((track: MixtapeTrack) => {
        if (useStemMode && ctx.normalizeMixtapeStemStatus((track as any)?.stemStatus) !== 'ready') {
          stemNotReadyCount += 1
          return null
        }
        const filePath = String(track.filePath || '').trim()
        if (!filePath) return null
        const sourceDuration = ctx.resolveTrackSourceDurationSeconds(track)
        if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
          missingDurationCount += 1
          return null
        }
        const bpm = Number(track.bpm)
        const originalBpm = Number(track.originalBpm) || bpm
        const runtimeTempoSnapshot = buildTrackRuntimeTempoSnapshot({
          track,
          sourceDurationSec: sourceDuration
        })
        const tempoSnapshot = serializeTrackRuntimeTempoSnapshot(runtimeTempoSnapshot)
        const beatSec = resolveBeatSecByBpm(bpm)
        const tempoRatio =
          sourceDuration > 0 ? sourceDuration / Math.max(0.01, runtimeTempoSnapshot.durationSec) : 1
        const duration = tempoSnapshot.durationSec
        const firstBeatSec = runtimeTempoSnapshot.timeMap.mapSourceToLocal(
          runtimeTempoSnapshot.firstBeatSourceSec
        )
        const barBeatOffset = normalizeBeatOffset(track.barBeatOffset, 32)
        const masterTempo = track.masterTempo !== false
        const startSec = startSecById.get(track.id) ?? ctx.resolveTrackStartSec(track)
        const firstBarLine =
          runtimeTempoSnapshot.timeMap
            .buildVisibleGridLines(Number.POSITIVE_INFINITY)
            .find((line) => line.level === 'bar') || null
        const syncAnchorSec =
          typeof firstBarLine?.sec === 'number'
            ? Number((startSec + firstBarLine.sec).toFixed(4))
            : resolveGridAnchorSec({
                startSec,
                firstBeatSec,
                beatSec,
                barBeatOffset
              })
        const activeParams = ctx.resolveMixEnvelopeParams()
        const mixEnvelopes = activeParams.reduce(
          (acc, param) => {
            acc[param] = ctx.resolveTrackMixEnvelope(track, duration, param)
            return acc
          },
          {} as Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[]>>
        )
        const mixEnvelopeSources = activeParams.reduce(
          (acc, param) => {
            const envelopeField = MIXTAPE_ENVELOPE_TRACK_FIELD_BY_PARAM[param]
            acc[param] = (track as any)?.[envelopeField] as MixtapeGainPoint[] | undefined
            return acc
          },
          {} as Partial<Record<MixtapeEnvelopeParamId, MixtapeGainPoint[] | undefined>>
        )
        const volumeMuteSegmentsSource = track.volumeMuteSegments
        const volumeMuteSegments = normalizeVolumeMuteSegments(volumeMuteSegmentsSource, duration)
        const decodeMode: 'browser' | 'ipc' = canPlayHtmlAudio(filePath) ? 'browser' : 'ipc'
        if (!useStemMode) {
          return {
            trackId: track.id,
            filePath,
            startSec,
            bpm,
            originalBpm,
            tempoSnapshot,
            beatSec,
            firstBeatSec,
            barBeatOffset,
            masterTempo,
            syncAnchorSec,
            sourceDuration,
            duration,
            tempoRatio: Math.max(0.25, Math.min(4, tempoRatio)),
            mixEnvelopes,
            mixEnvelopeSources,
            volumeMuteSegments,
            volumeMuteSegmentsSource,
            audioRef: {
              filePath,
              decodeMode,
              audioBuffer: null
            }
          } as TransportEntry
        }
        const stemIds = ctx.resolveStemIdsForMode()
        const stemAudioById: Partial<Record<TransportStemId, TransportStemAudioRef>> = {}
        for (const stemId of stemIds) {
          const stemFilePath = ctx.resolveTrackStemFilePath(track, stemId)
          if (!stemFilePath) {
            missingStemAssetCount += 1
            return null
          }
          stemAudioById[stemId] = {
            stemId,
            filePath: stemFilePath,
            decodeMode: canPlayHtmlAudio(stemFilePath) ? 'browser' : 'ipc',
            audioBuffer: null
          }
        }
        return {
          trackId: track.id,
          filePath,
          startSec,
          bpm,
          originalBpm,
          tempoSnapshot,
          beatSec,
          firstBeatSec,
          barBeatOffset,
          masterTempo,
          syncAnchorSec,
          sourceDuration,
          duration,
          tempoRatio: Math.max(0.25, Math.min(4, tempoRatio)),
          mixEnvelopes,
          mixEnvelopeSources,
          volumeMuteSegments,
          volumeMuteSegmentsSource,
          audioRef: undefined,
          stemAudioById
        } as TransportEntry
      })
      .filter(Boolean) as TransportEntry[]
    entries.sort((a, b) => a.startSec - b.startSec)
    return {
      entries,
      decodeFailedCount: 0,
      missingDurationCount,
      stemNotReadyCount,
      missingStemAssetCount
    }
  }

  const decodeBrowser = async (filePath: string): Promise<AudioBuffer> => {
    const url = toPreviewUrl(filePath)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`fetch 失败: ${response.status}`)
    const arrayBuffer = await response.arrayBuffer()
    if (!arrayBuffer.byteLength) throw new Error('fetch 返回空数据')
    const audioCtx = ctx.ensureTransportAudioContext()
    return await audioCtx.decodeAudioData(arrayBuffer)
  }

  const decodeIpc = async (filePath: string): Promise<AudioBuffer> => {
    const result = await window.electron.ipcRenderer.invoke(
      'mixtape:decode-for-transport',
      filePath
    )
    const pcmData = normalizePcmData(result?.pcmData)
    const sampleRate = Number(result?.sampleRate) || 44100
    const channels = Math.max(1, Number(result?.channels) || 1)
    const totalFrames = Number(result?.totalFrames) || 0
    const frameCount =
      totalFrames > 0
        ? Math.min(totalFrames, Math.floor(pcmData.length / channels))
        : Math.floor(pcmData.length / channels)
    if (frameCount <= 0 || !pcmData.length) throw new Error('解码结果为空')
    const audioCtx = ctx.ensureTransportAudioContext(sampleRate)
    const buffer = audioCtx.createBuffer(channels, frameCount, sampleRate)
    fillAudioBufferFromInterleavedPcm(buffer, pcmData, channels, frameCount)
    return buffer
  }

  const ensureDecodedAudio = async (audioRef: PreloadAudioRef): Promise<void> => {
    const cached = readTransportBufferCache(audioRef.filePath)
    if (cached) {
      audioRef.audioBuffer = cached
      return
    }
    const filePath = audioRef.filePath
    let inflight = transportDecodeInflight.get(filePath)
    if (!inflight) {
      inflight = (async () => {
        const buffer =
          audioRef.decodeMode === 'browser'
            ? await decodeBrowser(filePath).catch(async (error) => {
                console.warn('[mixtape-transport] 浏览器解码失败，回退 IPC 解码:', filePath, error)
                return await decodeIpc(filePath)
              })
            : await decodeIpc(filePath)
        writeTransportBufferCache(filePath, buffer)
        return buffer
      })().finally(() => {
        transportDecodeInflight.delete(filePath)
      })
      transportDecodeInflight.set(filePath, inflight)
    }
    audioRef.audioBuffer = await inflight
  }

  const ensureDecodedStemAudio = async (stemAudio: TransportStemAudioRef): Promise<void> => {
    await ensureDecodedAudio(stemAudio)
  }

  const ensureDecodedAudioRef = async (audioRef: TransportAudioRef): Promise<void> => {
    await ensureDecodedAudio(audioRef)
  }

  const ensureDecodedTransportEntry = async (entry: TransportEntry): Promise<void> => {
    if (ctx.isStemMixMode()) {
      const stemIds = ctx.resolveStemIdsForMode()
      await Promise.all(
        stemIds.map(async (stemId) => {
          const stemAudio = entry.stemAudioById?.[stemId]
          if (!stemAudio) return
          await ensureDecodedStemAudio(stemAudio)
        })
      )
      return
    }
    if (!entry.audioRef) return
    await ensureDecodedAudioRef(entry.audioRef)
  }

  const decodeAllTransportEntries = async (entries: TransportEntry[]): Promise<number> => {
    if (!entries.length) return 0
    let failCount = 0
    if (ctx.isStemMixMode()) {
      const stemAudioByPath = new Map<string, TransportStemAudioRef>()
      for (const entry of entries) {
        for (const stemId of ctx.resolveStemIdsForMode()) {
          const stemAudio = entry.stemAudioById?.[stemId]
          if (!stemAudio) continue
          const filePath = String(stemAudio.filePath || '').trim()
          if (!filePath || stemAudioByPath.has(filePath)) continue
          stemAudioByPath.set(filePath, stemAudio)
        }
      }
      const stemAudios = Array.from(stemAudioByPath.values())
      await Promise.all(
        stemAudios.map(async (stemAudio) => {
          try {
            await ensureDecodedStemAudio(stemAudio)
          } catch (error) {
            console.error(
              `[mixtape-transport] 解码失败 (${stemAudio.decodeMode}):`,
              stemAudio.filePath,
              error
            )
            failCount += 1
          }
        })
      )
      return failCount
    }
    const audioRefByPath = new Map<string, TransportAudioRef>()
    for (const entry of entries) {
      const audioRef = entry.audioRef
      const filePath = String(audioRef?.filePath || '').trim()
      if (!audioRef || !filePath || audioRefByPath.has(filePath)) continue
      audioRefByPath.set(filePath, audioRef)
    }
    await Promise.all(
      Array.from(audioRefByPath.values()).map(async (audioRef) => {
        try {
          await ensureDecodedAudioRef(audioRef)
        } catch (error) {
          console.error(
            `[mixtape-transport] 解码失败 (${audioRef.decodeMode}):`,
            audioRef.filePath,
            error
          )
          failCount += 1
        }
      })
    )
    return failCount
  }

  const collectUniqueTransportAudios = (entries: TransportEntry[]): PreloadAudioRef[] => {
    const uniqueAudioRefs = new Map<string, PreloadAudioRef>()
    if (ctx.isStemMixMode()) {
      for (const entry of entries) {
        for (const stemId of ctx.resolveStemIdsForMode()) {
          const stemAudio = entry.stemAudioById?.[stemId]
          const stemPath = String(stemAudio?.filePath || '').trim()
          if (!stemAudio || !stemPath || uniqueAudioRefs.has(stemPath)) continue
          uniqueAudioRefs.set(stemPath, stemAudio)
        }
      }
      return Array.from(uniqueAudioRefs.values())
    }

    for (const entry of entries) {
      const audioRef = entry.audioRef
      const filePath = String(audioRef?.filePath || '').trim()
      if (!audioRef || !filePath || uniqueAudioRefs.has(filePath)) continue
      uniqueAudioRefs.set(filePath, audioRef)
    }
    return Array.from(uniqueAudioRefs.values())
  }

  const collectPriorityPreloadPaths = (entries: TransportEntry[]): Set<string> => {
    const selectedEntries: TransportEntry[] = []
    const selectedTrackIds = new Set<string>()
    const focusSec = Math.max(0, Number(ctx.playheadSec.value) || 0)
    const priorityTrackLimit = ctx.isStemMixMode() ? 2 : TRANSPORT_PRELOAD_PRIORITY_TRACK_LIMIT
    const overlapping: TransportEntry[] = []
    const upcoming: TransportEntry[] = []
    const previous: TransportEntry[] = []

    for (const entry of entries) {
      const startSec = Math.max(0, Number(entry.startSec) || 0)
      const endSec = startSec + Math.max(0, Number(entry.duration) || 0)
      if (focusSec >= startSec && focusSec < endSec) {
        overlapping.push(entry)
        continue
      }
      if (startSec >= focusSec) {
        upcoming.push(entry)
        continue
      }
      previous.push(entry)
    }

    overlapping.sort((a, b) => a.startSec - b.startSec)
    upcoming.sort((a, b) => a.startSec - b.startSec)
    previous.sort((a, b) => b.startSec - a.startSec)

    const appendEntries = (candidates: TransportEntry[]) => {
      for (const entry of candidates) {
        if (selectedEntries.length >= priorityTrackLimit) return
        if (selectedTrackIds.has(entry.trackId)) continue
        selectedTrackIds.add(entry.trackId)
        selectedEntries.push(entry)
      }
    }

    appendEntries(overlapping)
    appendEntries(upcoming)
    appendEntries(previous)
    if (!selectedEntries.length) {
      appendEntries([...entries].sort((a, b) => a.startSec - b.startSec))
    }

    const priorityPaths = new Set<string>()
    for (const entry of selectedEntries) {
      if (ctx.isStemMixMode()) {
        for (const stemId of ctx.resolveStemIdsForMode()) {
          const stemPath = String(entry.stemAudioById?.[stemId]?.filePath || '').trim()
          if (stemPath) {
            priorityPaths.add(stemPath)
          }
        }
        continue
      }
      const filePath = String(entry.audioRef?.filePath || '').trim()
      if (filePath) {
        priorityPaths.add(filePath)
      }
    }
    return priorityPaths
  }

  const runTransportPreloadBatch = async (
    audioRefs: PreloadAudioRef[],
    version: number,
    trackVisibleProgress: boolean
  ) => {
    if (!audioRefs.length) return
    let cursor = 0
    const workerCount = Math.max(
      1,
      Math.min(resolveTransportPreloadConcurrencyCap(), audioRefs.length)
    )
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (version !== transportPreloadVersion) return
        const index = cursor
        cursor += 1
        if (index >= audioRefs.length) return
        const audioRef = audioRefs[index]
        try {
          await ensureDecodedAudio(audioRef)
        } catch (error) {
          console.error('[mixtape-transport] 预解码失败:', audioRef.filePath, error)
          if (trackVisibleProgress && version === transportPreloadVersion) {
            ctx.transportPreloadFailed.value += 1
          }
        } finally {
          if (trackVisibleProgress && version === transportPreloadVersion) {
            ctx.transportPreloadDone.value += 1
          }
        }
      }
    })
    await Promise.all(workers)
  }

  const preloadTransportBuffers = async () => {
    if (ctx.isStemMixMode() && !isStemAutoPreloadReady()) {
      ctx.transportPreloading.value = false
      resetTransportPreloadProgress()
      return
    }
    const version = ++transportPreloadVersion
    const plan = buildTransportEntries()
    const uniqueAudios = collectUniqueTransportAudios(plan.entries)
    const keepPaths = new Set(uniqueAudios.map((item) => item.filePath))
    for (const key of Array.from(transportDecodedBufferCache.keys())) {
      if (!keepPaths.has(key)) {
        transportDecodedBufferCache.delete(key)
      }
    }
    if (!uniqueAudios.length) {
      ctx.transportPreloading.value = false
      resetTransportPreloadProgress()
      return
    }
    const priorityPaths = collectPriorityPreloadPaths(plan.entries)
    let visibleDone = 0
    const priorityPending: PreloadAudioRef[] = []
    const backgroundPending: PreloadAudioRef[] = []
    for (const audioRef of uniqueAudios) {
      const cached = readTransportBufferCache(audioRef.filePath)
      if (cached) {
        audioRef.audioBuffer = cached
        if (priorityPaths.has(audioRef.filePath)) {
          visibleDone += 1
        }
        continue
      }
      if (priorityPaths.has(audioRef.filePath)) {
        priorityPending.push(audioRef)
      } else {
        backgroundPending.push(audioRef)
      }
    }
    ctx.transportPreloadTotal.value = visibleDone + priorityPending.length
    ctx.transportPreloadDone.value = visibleDone
    ctx.transportPreloadFailed.value = 0
    if (!priorityPending.length) {
      ctx.transportPreloading.value = false
      resetTransportPreloadProgress()
      if (backgroundPending.length) {
        await runTransportPreloadBatch(backgroundPending, version, false)
      }
      return
    }
    ctx.transportPreloading.value = true
    await runTransportPreloadBatch(priorityPending, version, true)
    if (version !== transportPreloadVersion) return
    ctx.transportPreloading.value = false
    resetTransportPreloadProgress()
    if (!backgroundPending.length) return
    await runTransportPreloadBatch(backgroundPending, version, false)
  }

  const scheduleTransportPreload = () => {
    if (ctx.isStemMixMode() && !isStemAutoPreloadReady()) {
      cancelTransportPreload()
      resetTransportPreloadProgress()
      return
    }
    clearTransportPreloadTimer()
    transportPreloadTimer = setTimeout(() => {
      transportPreloadTimer = null
      void preloadTransportBuffers()
    }, 80)
  }

  const isStemAutoPreloadReady = () => {
    if (!ctx.isStemMixMode()) return false
    if (!ctx.tracks.value.length) return false
    for (const track of ctx.tracks.value) {
      const stemStatus = ctx.normalizeMixtapeStemStatus((track as any)?.stemStatus)
      if (stemStatus !== 'ready') return false
    }
    return true
  }

  const cleanupTransportAudioData = () => {
    cancelTransportPreload()
    transportDecodeInflight.clear()
    transportDecodedBufferCache.clear()
  }

  return {
    buildTransportEntries,
    remapVolumeMuteSegmentsForBpm,
    readTransportBufferCache,
    ensureDecodedStemAudio,
    ensureDecodedTransportEntry,
    decodeAllTransportEntries,
    scheduleTransportPreload,
    cancelTransportPreload,
    cleanupTransportAudioData
  }
}
