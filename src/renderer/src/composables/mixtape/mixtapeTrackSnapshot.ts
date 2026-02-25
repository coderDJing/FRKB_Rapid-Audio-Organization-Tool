import {
  normalizeGainEnvelopePoints,
  normalizeMixEnvelopePoints
} from '@renderer/composables/mixtape/gainEnvelope'
import { normalizeVolumeMuteSegments } from '@renderer/composables/mixtape/volumeMuteSegments'
import type { MixtapeRawItem, MixtapeTrack } from '@renderer/composables/mixtape/types'

const parseSnapshotInfo = (raw: MixtapeRawItem): Record<string, any> | null => {
  if (!raw?.infoJson) return null
  try {
    return JSON.parse(String(raw.infoJson))
  } catch {
    return null
  }
}

export const normalizeMixtapeFilePath = (value: unknown) => {
  if (typeof value !== 'string') return ''
  return value.trim()
}

export const normalizeBarBeatOffset = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  const rounded = Math.round(numeric)
  return ((rounded % 32) + 32) % 32
}

export const normalizeFirstBeatMs = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return 0
  return numeric
}

export const normalizeBpm = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Number(numeric.toFixed(2))
}

export const normalizeUniquePaths = (values: unknown[]) => {
  if (!Array.isArray(values)) return [] as string[]
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === 'string')
        .map((value) => String(value).trim())
        .filter(Boolean)
    )
  )
}

export const parseSnapshot = (
  raw: MixtapeRawItem,
  index: number,
  unknownTrackLabel: string
): MixtapeTrack => {
  const info = parseSnapshotInfo(raw)
  const filePath =
    normalizeMixtapeFilePath(raw?.filePath) || normalizeMixtapeFilePath(info?.filePath)
  const fileName = filePath.split(/[/\\]/).pop() || filePath || unknownTrackLabel
  const parsedBpm =
    typeof info?.bpm === 'number' && Number.isFinite(info.bpm) && info.bpm > 0
      ? info.bpm
      : undefined
  const parsedOriginalBpmCandidate = Number(info?.originalBpm)
  const parsedOriginalBpm =
    Number.isFinite(parsedOriginalBpmCandidate) && parsedOriginalBpmCandidate > 0
      ? parsedOriginalBpmCandidate
      : parsedBpm
  const parsedMasterTempo = info?.masterTempo !== false
  const hasFirstBeatField = !!info && Object.prototype.hasOwnProperty.call(info, 'firstBeatMs')
  const parsedFirstBeatMsValue = Number(info?.firstBeatMs)
  const parsedFirstBeatMs =
    hasFirstBeatField && Number.isFinite(parsedFirstBeatMsValue) && parsedFirstBeatMsValue >= 0
      ? parsedFirstBeatMsValue
      : undefined
  const parsedKey = typeof info?.key === 'string' ? info.key.trim() : ''
  const parsedOriginalKeyRaw = typeof info?.originalKey === 'string' ? info.originalKey.trim() : ''
  const parsedOriginalKey = parsedOriginalKeyRaw || parsedKey || undefined
  const parsedBarBeatOffset = normalizeBarBeatOffset(info?.barBeatOffset)
  const parsedGainEnvelope = normalizeGainEnvelopePoints(info?.gainEnvelope)
  const parsedHighEnvelope = normalizeMixEnvelopePoints('high', info?.highEnvelope)
  const parsedMidEnvelope = normalizeMixEnvelopePoints('mid', info?.midEnvelope)
  const parsedLowEnvelope = normalizeMixEnvelopePoints('low', info?.lowEnvelope)
  const parsedVolumeEnvelope = normalizeMixEnvelopePoints('volume', info?.volumeEnvelope)
  const parsedVolumeMuteSegments = normalizeVolumeMuteSegments(
    info?.volumeMuteSegments,
    Number(info?.durationSec)
  )
  const parsedStartSecRaw = Number(info?.startSec)
  const parsedStartSec =
    Number.isFinite(parsedStartSecRaw) && parsedStartSecRaw >= 0
      ? Number(parsedStartSecRaw.toFixed(4))
      : undefined
  return {
    id: String(raw?.id || `${filePath}-${index}`),
    mixOrder: Number(raw?.mixOrder) || index + 1,
    title: String(info?.title || fileName || unknownTrackLabel),
    artist: String(info?.artist || ''),
    duration: String(info?.duration || ''),
    filePath,
    originPath: String(raw?.originPathSnapshot || ''),
    originPlaylistUuid: raw?.originPlaylistUuid ? String(raw.originPlaylistUuid) : null,
    key: parsedKey || undefined,
    originalKey: parsedOriginalKey,
    bpm: parsedBpm,
    gridBaseBpm: parsedBpm,
    originalBpm: parsedOriginalBpm,
    masterTempo: parsedMasterTempo,
    startSec: parsedStartSec,
    gainEnvelope: parsedGainEnvelope.length ? parsedGainEnvelope : undefined,
    highEnvelope: parsedHighEnvelope.length ? parsedHighEnvelope : undefined,
    midEnvelope: parsedMidEnvelope.length ? parsedMidEnvelope : undefined,
    lowEnvelope: parsedLowEnvelope.length ? parsedLowEnvelope : undefined,
    volumeEnvelope: parsedVolumeEnvelope.length ? parsedVolumeEnvelope : undefined,
    volumeMuteSegments: parsedVolumeMuteSegments.length ? parsedVolumeMuteSegments : undefined,
    firstBeatMs: parsedFirstBeatMs,
    barBeatOffset: parsedBarBeatOffset
  }
}
