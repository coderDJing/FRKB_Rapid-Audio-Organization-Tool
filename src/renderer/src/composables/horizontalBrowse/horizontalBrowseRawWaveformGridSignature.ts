import {
  PREVIEW_DOWNBEAT_BEAT_INTERVAL,
  normalizeBeatOffset,
  normalizePreviewBpm
} from '@renderer/components/MixtapeBeatAlignDialog.constants'

type HorizontalBrowseGridSignatureInput = {
  bpm?: unknown
  firstBeatMs?: unknown
  downbeatBeatOffset?: unknown
  timeBasisOffsetMs?: unknown
  beatGridMapSignature?: unknown
}

const normalizeGridSignatureBpm = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return normalizePreviewBpm(numeric)
}

const normalizeGridSignatureFirstBeatMs = (value: unknown) => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Number(numeric.toFixed(3))
}

const normalizeGridSignatureDownbeatBeatOffset = (value: unknown) =>
  normalizeBeatOffset(Number(value) || 0, PREVIEW_DOWNBEAT_BEAT_INTERVAL)

export const buildHorizontalBrowseRawWaveformGridSignature = (
  input: HorizontalBrowseGridSignatureInput
) =>
  [
    normalizeGridSignatureBpm(input.bpm).toFixed(6),
    normalizeGridSignatureFirstBeatMs(input.firstBeatMs).toFixed(3),
    normalizeGridSignatureDownbeatBeatOffset(input.downbeatBeatOffset),
    normalizeGridSignatureFirstBeatMs(input.timeBasisOffsetMs).toFixed(3),
    typeof input.beatGridMapSignature === 'string' ? input.beatGridMapSignature : ''
  ].join('|')
