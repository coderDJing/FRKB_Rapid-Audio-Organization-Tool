type SongCueTimeBasisInput = {
  sec?: unknown
  isLoop?: unknown
  loopEndSec?: unknown
  source?: unknown
}

export type SongCueTimelineDefinition = {
  sec: number
  isLoop?: boolean
  loopEndSec?: number
}

const CUE_LOOP_EPSILON_SEC = 0.0001

const normalizeCueSource = (source: unknown) =>
  String(source || '')
    .trim()
    .toLowerCase()

const resolveTimeBasisOffsetSec = (timeBasisOffsetMs: unknown) => {
  const offsetMs = Number(timeBasisOffsetMs)
  return Number.isFinite(offsetMs) && offsetMs > 0 ? offsetMs / 1000 : 0
}

export const isRekordboxAudioCueSource = (source: unknown) =>
  normalizeCueSource(source) === 'rekordbox'

export const resolveSongCueTimelineSec = (
  seconds: unknown,
  cue: { source?: unknown } | null | undefined,
  timeBasisOffsetMs: unknown
) => {
  const numeric = Number(seconds)
  if (!Number.isFinite(numeric) || numeric < 0) return null
  const offsetSec = isRekordboxAudioCueSource(cue?.source)
    ? resolveTimeBasisOffsetSec(timeBasisOffsetMs)
    : 0
  return Math.max(0, numeric + offsetSec)
}

export const resolveSongCueTimelineDefinition = (
  cue: SongCueTimeBasisInput | null | undefined,
  timeBasisOffsetMs: unknown
): SongCueTimelineDefinition | null => {
  const sec = resolveSongCueTimelineSec(cue?.sec, cue, timeBasisOffsetMs)
  if (sec === null) return null

  const loopEndSec = resolveSongCueTimelineSec(cue?.loopEndSec, cue, timeBasisOffsetMs)
  const isLoop =
    Boolean(cue?.isLoop) && loopEndSec !== null && loopEndSec > sec + CUE_LOOP_EPSILON_SEC

  return {
    sec,
    isLoop,
    loopEndSec: isLoop ? loopEndSec : undefined
  }
}
