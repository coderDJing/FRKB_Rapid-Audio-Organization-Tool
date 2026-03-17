const BPM_POINT_SEC_EPSILON = 0.0001

export type TrackVisibleGridLine = {
  sec: number
  sourceSec: number
  level: 'bar' | 'beat4' | 'beat'
}

export const normalizeTrackVisibleGridOverrides = (value: unknown) => {
  if (!Array.isArray(value) || !value.length) return [] as TrackVisibleGridLine[]
  return value
    .map((item) => ({
      sec: Number((item as any)?.sec),
      sourceSec: Number((item as any)?.sourceSec),
      level: (item as any)?.level
    }))
    .filter(
      (line): line is TrackVisibleGridLine =>
        Number.isFinite(line.sec) &&
        line.sec >= 0 &&
        Number.isFinite(line.sourceSec) &&
        line.sourceSec >= 0 &&
        (line.level === 'bar' || line.level === 'beat4' || line.level === 'beat')
    )
    .map((line) => ({
      sec: Number(line.sec.toFixed(4)),
      sourceSec: Number(line.sourceSec.toFixed(4)),
      level: line.level
    }))
    .sort((left, right) => left.sec - right.sec)
}

export const applyTrackVisibleGridOverrides = (params: {
  lines: TrackVisibleGridLine[]
  overrideLines?: TrackVisibleGridLine[]
  overrideRange?: {
    startSec: number
    endSec: number
  }
  visibility?: {
    showBar: boolean
    showBeat4: boolean
    showBeat: boolean
  }
}) => {
  const overrideLines = normalizeTrackVisibleGridOverrides(params.overrideLines)
  if (!overrideLines.length) return params.lines
  const filteredOverrideLines = overrideLines.filter((line) => {
    if (line.level === 'bar') return params.visibility?.showBar !== false
    if (line.level === 'beat4') return params.visibility?.showBeat4 === true
    return params.visibility?.showBeat === true
  })
  if (!filteredOverrideLines.length) return params.lines
  const overrideStartSec = Number.isFinite(Number(params.overrideRange?.startSec))
    ? Number(params.overrideRange?.startSec)
    : filteredOverrideLines[0]!.sec
  const overrideEndSec = Number.isFinite(Number(params.overrideRange?.endSec))
    ? Number(params.overrideRange?.endSec)
    : filteredOverrideLines[filteredOverrideLines.length - 1]!.sec
  return [
    ...params.lines.filter(
      (line) =>
        line.sec < overrideStartSec - BPM_POINT_SEC_EPSILON ||
        line.sec > overrideEndSec + BPM_POINT_SEC_EPSILON
    ),
    ...filteredOverrideLines
  ].sort((left, right) => left.sec - right.sec)
}
