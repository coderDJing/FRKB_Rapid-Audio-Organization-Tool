import {
  createTransportBufferSource,
  createTransportKeyLockSource,
  createTransportSequencedBufferSource,
  createTransportSequencedKeyLockSource,
  createTransportSequencedSoundTouchSource,
  createTransportSoundTouchPreviewSource,
  type TransportPlayableSource
} from '@renderer/composables/mixtape/timelineTransportPlayableSource'
import type {
  TransportEntry,
  TransportStemAudioRef,
  TransportStemId
} from '@renderer/composables/mixtape/timelineTransportAudioData'

export type TrackStemGraphNode = {
  stemId: TransportStemId
  source: TransportPlayableSource
  stemGain: GainNode
}

export type TrackGraphNode = {
  trackId: string
  entry: TransportEntry
  source: TransportPlayableSource
  stemNodes: TrackStemGraphNode[]
  stemBus: GainNode | null
  eqHigh: BiquadFilterNode | null
  eqMid: BiquadFilterNode | null
  eqLow: BiquadFilterNode | null
  volume: GainNode
  gain: GainNode
}

export type TransportPlaybackSourceMode =
  | 'buffer'
  | 'soundtouch'
  | 'sequenced-soundtouch'
  | 'sequenced-buffer'
  | 'sequenced-keylock'

type StartTransportTrackGraphNodeParams = {
  entry: TransportEntry
  offsetTimelineSec: number
  offsetPlanSec: number
  offsetSourceSec: number
  whenSec: number
  transportGraphNodes: TrackGraphNode[]
  isStemMixMode: () => boolean
  resolveStemIdsForMode: () => TransportStemId[]
  ensureTransportAudioContext: (sampleRate?: number) => AudioContext
  resolveTransportOutputNode: (ctx: AudioContext) => AudioNode
  resolvePlaybackSourceMode: (entry: TransportEntry) => TransportPlaybackSourceMode
  resolveEntryEnvelopeValue: (
    entry: TransportEntry,
    param: 'volume' | 'gain' | TransportStemId,
    timelineOffsetSec: number
  ) => number
  resolveEntryEqDbValue: (
    entry: TransportEntry,
    param: 'high' | 'mid' | 'low',
    timelineOffsetSec: number
  ) => number
}

export const startTransportTrackGraphNode = (params: StartTransportTrackGraphNodeParams) => {
  const {
    entry,
    offsetTimelineSec,
    offsetPlanSec,
    offsetSourceSec,
    whenSec,
    transportGraphNodes,
    isStemMixMode,
    resolveStemIdsForMode,
    ensureTransportAudioContext,
    resolveTransportOutputNode,
    resolvePlaybackSourceMode,
    resolveEntryEnvelopeValue,
    resolveEntryEqDbValue
  } = params

  const resolveSourceStartOffset = (source: TransportPlayableSource, bufferDuration: number) => {
    const baseOffsetSec = source.startOffsetKind === 'plan' ? offsetPlanSec : offsetSourceSec
    const offsetDuration =
      source.startOffsetKind === 'plan'
        ? Math.max(0, Number(entry.playbackSequence?.totalPlanSec) || 0)
        : Math.max(0, bufferDuration)
    return Math.max(0, Math.min(baseOffsetSec, Math.max(0, offsetDuration - 0.02)))
  }

  const createPlaybackSource = (
    ctx: AudioContext,
    buffer: AudioBuffer,
    mode: TransportPlaybackSourceMode
  ) => {
    if (mode === 'sequenced-keylock' && entry.playbackSequence) {
      return createTransportSequencedKeyLockSource(ctx, buffer, entry.playbackSequence)
    }
    if (mode === 'sequenced-soundtouch' && entry.playbackSequence) {
      return createTransportSequencedSoundTouchSource(ctx, buffer, entry.playbackSequence)
    }
    if (mode === 'sequenced-buffer' && entry.playbackSequence) {
      return createTransportSequencedBufferSource(ctx, buffer, entry.playbackSequence)
    }
    if (mode === 'soundtouch') {
      return createTransportSoundTouchPreviewSource(ctx, buffer)
    }
    if (mode === 'sequenced-keylock') {
      return createTransportKeyLockSource(ctx, buffer)
    }
    return createTransportBufferSource(ctx, buffer)
  }

  if (isStemMixMode()) {
    const stemIds = resolveStemIdsForMode()
    const stemAudios = stemIds
      .map((stemId) => entry.stemAudioById?.[stemId])
      .filter((item): item is TransportStemAudioRef => !!item && !!item.audioBuffer)
    if (!stemAudios.length) return
    try {
      const sampleRate = Number(stemAudios[0]?.audioBuffer?.sampleRate || 0) || undefined
      const ctx = ensureTransportAudioContext(sampleRate)
      if (ctx.state === 'suspended') {
        void ctx.resume()
      }

      const stemBus = ctx.createGain()
      const volume = ctx.createGain()
      const gain = ctx.createGain()
      const outputNode = resolveTransportOutputNode(ctx)
      volume.gain.value = resolveEntryEnvelopeValue(entry, 'volume', offsetTimelineSec)
      gain.gain.value = resolveEntryEnvelopeValue(entry, 'gain', offsetTimelineSec)
      stemBus.gain.value = 1
      stemBus.connect(volume)
      volume.connect(gain)
      gain.connect(outputNode)

      const stemNodes: TrackStemGraphNode[] = []
      for (const stemAudio of stemAudios) {
        const source = createPlaybackSource(
          ctx,
          stemAudio.audioBuffer as AudioBuffer,
          resolvePlaybackSourceMode(entry)
        )
        source.playbackRate.value = entry.tempoRatio
        const stemGain = ctx.createGain()
        stemGain.gain.value = resolveEntryEnvelopeValue(entry, stemAudio.stemId, offsetTimelineSec)
        source.connect(stemGain)
        stemGain.connect(stemBus)
        stemNodes.push({
          stemId: stemAudio.stemId,
          source,
          stemGain
        })
      }
      const primaryStemNode = stemNodes[0]
      if (!primaryStemNode) {
        try {
          stemBus.disconnect()
        } catch {}
        try {
          volume.disconnect()
        } catch {}
        try {
          gain.disconnect()
        } catch {}
        return
      }

      const safeWhen = Number.isFinite(whenSec)
        ? Math.max(ctx.currentTime, whenSec)
        : ctx.currentTime
      const remainingTimelineSec = Math.max(0.02, Number(entry.duration) - offsetTimelineSec)
      for (const stemNode of stemNodes) {
        const stemDuration = Number(stemNode.source.buffer?.duration || 0)
        const safeOffset = resolveSourceStartOffset(stemNode.source, stemDuration)
        try {
          stemNode.source.playbackRate.setTargetAtTime(entry.tempoRatio, safeWhen, 0.0001)
        } catch {}
        stemNode.source.start(safeWhen, safeOffset)
        stemNode.source.stop(safeWhen + remainingTimelineSec + 0.02)
      }

      const graphNode: TrackGraphNode = {
        trackId: entry.trackId,
        entry,
        source: primaryStemNode.source,
        stemNodes,
        stemBus,
        eqHigh: null,
        eqMid: null,
        eqLow: null,
        volume,
        gain
      }
      transportGraphNodes.push(graphNode)

      let cleaned = false
      const cleanupNode = () => {
        if (cleaned) return
        cleaned = true
        const idx = transportGraphNodes.indexOf(graphNode)
        if (idx >= 0) transportGraphNodes.splice(idx, 1)
        for (const stemNode of stemNodes) {
          try {
            stemNode.source.disconnect()
          } catch {}
          try {
            stemNode.stemGain.disconnect()
          } catch {}
        }
        try {
          stemBus.disconnect()
        } catch {}
        try {
          volume.disconnect()
        } catch {}
        try {
          gain.disconnect()
        } catch {}
      }
      primaryStemNode.source.onended = cleanupNode
    } catch (error) {
      console.error('[mixtape-transport] 播放启动失败:', entry.filePath, error)
    }
    return
  }

  const audioBuffer = entry.audioRef?.audioBuffer
  if (!audioBuffer) return
  try {
    const ctx = ensureTransportAudioContext(audioBuffer.sampleRate)
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }

    const source = createPlaybackSource(ctx, audioBuffer, resolvePlaybackSourceMode(entry))
    source.playbackRate.value = entry.tempoRatio

    const eqLow = ctx.createBiquadFilter()
    eqLow.type = 'lowshelf'
    eqLow.frequency.value = 220

    const eqMid = ctx.createBiquadFilter()
    eqMid.type = 'peaking'
    eqMid.frequency.value = 1000
    eqMid.Q.value = 0.9

    const eqHigh = ctx.createBiquadFilter()
    eqHigh.type = 'highshelf'
    eqHigh.frequency.value = 3200

    const volume = ctx.createGain()
    const gain = ctx.createGain()
    const outputNode = resolveTransportOutputNode(ctx)
    eqHigh.gain.value = resolveEntryEqDbValue(entry, 'high', offsetTimelineSec)
    eqMid.gain.value = resolveEntryEqDbValue(entry, 'mid', offsetTimelineSec)
    eqLow.gain.value = resolveEntryEqDbValue(entry, 'low', offsetTimelineSec)
    volume.gain.value = resolveEntryEnvelopeValue(entry, 'volume', offsetTimelineSec)
    gain.gain.value = resolveEntryEnvelopeValue(entry, 'gain', offsetTimelineSec)

    source.connect(eqLow)
    eqLow.connect(eqMid)
    eqMid.connect(eqHigh)
    eqHigh.connect(volume)
    volume.connect(gain)
    gain.connect(outputNode)

    const safeWhen = Number.isFinite(whenSec) ? Math.max(ctx.currentTime, whenSec) : ctx.currentTime
    const safeOffset = resolveSourceStartOffset(source, audioBuffer.duration)
    try {
      source.playbackRate.setTargetAtTime(entry.tempoRatio, safeWhen, 0.0001)
    } catch {}
    source.start(safeWhen, safeOffset)
    source.stop(safeWhen + Math.max(0.02, Number(entry.duration) - offsetTimelineSec) + 0.02)

    const graphNode: TrackGraphNode = {
      trackId: entry.trackId,
      entry,
      source,
      stemNodes: [],
      stemBus: null,
      eqHigh,
      eqMid,
      eqLow,
      volume,
      gain
    }
    transportGraphNodes.push(graphNode)

    let cleaned = false
    const cleanupNode = () => {
      if (cleaned) return
      cleaned = true
      const idx = transportGraphNodes.indexOf(graphNode)
      if (idx >= 0) transportGraphNodes.splice(idx, 1)
      try {
        source.disconnect()
      } catch {}
      try {
        eqLow.disconnect()
      } catch {}
      try {
        eqMid.disconnect()
      } catch {}
      try {
        eqHigh.disconnect()
      } catch {}
      try {
        volume.disconnect()
      } catch {}
      try {
        gain.disconnect()
      } catch {}
    }
    source.onended = cleanupNode
  } catch (error) {
    console.error('[mixtape-transport] 播放启动失败:', entry.filePath, error)
  }
}
