import type {
  MixtapeMuteSegment,
  MixtapeTrackLoopSegment,
  SerializedVisibleGridLine
} from '@renderer/composables/mixtape/types'

const LOOP_SEC_EPSILON = 0.0001

export type MixtapeTrackLoopSectionKind = 'head' | 'loop-source' | 'loop-repeat' | 'tail'

export type MixtapeTrackLoopSection = {
  key: string
  loopKey: string | null
  kind: MixtapeTrackLoopSectionKind
  displayStartSec: number
  displayEndSec: number
  baseStartSec: number
  baseEndSec: number
  repeatIndex: number
}

const roundSec = (value: number) => Number(Math.max(0, Number(value) || 0).toFixed(4))
const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const normalizeSingleLoopSegment = (
  value: unknown,
  baseDurationSec?: number
): MixtapeTrackLoopSegment | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as {
    startSec?: unknown
    endSec?: unknown
    repeatCount?: unknown
  }
  const rawStartSec = Number(record.startSec)
  const rawEndSec = Number(record.endSec)
  const rawRepeatCount = Number(record.repeatCount)
  if (
    !Number.isFinite(rawStartSec) ||
    !Number.isFinite(rawEndSec) ||
    !Number.isFinite(rawRepeatCount)
  ) {
    return undefined
  }
  const repeatCount = Math.max(0, Math.floor(rawRepeatCount))
  if (repeatCount <= 0) return undefined
  const safeBaseDuration =
    typeof baseDurationSec === 'number' && Number.isFinite(baseDurationSec) && baseDurationSec > 0
      ? Math.max(0, Number(baseDurationSec))
      : Number.POSITIVE_INFINITY
  const startSec = roundSec(clampNumber(rawStartSec, 0, safeBaseDuration))
  const endSec = roundSec(clampNumber(rawEndSec, 0, safeBaseDuration))
  if (endSec - startSec <= LOOP_SEC_EPSILON) return undefined
  return {
    startSec,
    endSec,
    repeatCount
  }
}

export const buildMixtapeTrackLoopSegmentKey = (segment: { startSec: number; endSec: number }) =>
  `${Math.round(segment.startSec * 1000)}:${Math.round(segment.endSec * 1000)}`

export const normalizeMixtapeTrackLoopSegments = (
  value: unknown,
  baseDurationSec?: number
): MixtapeTrackLoopSegment[] => {
  const rawItems = Array.isArray(value) ? value : value ? [value] : []
  const normalized = rawItems
    .map((item) => normalizeSingleLoopSegment(item, baseDurationSec))
    .filter((item): item is MixtapeTrackLoopSegment => !!item)
    .sort((left, right) => {
      if (Math.abs(left.startSec - right.startSec) > LOOP_SEC_EPSILON) {
        return left.startSec - right.startSec
      }
      if (Math.abs(left.endSec - right.endSec) > LOOP_SEC_EPSILON) {
        return left.endSec - right.endSec
      }
      return left.repeatCount - right.repeatCount
    })

  const result: MixtapeTrackLoopSegment[] = []
  let lastEndSec = -1
  for (const segment of normalized) {
    if (segment.startSec < lastEndSec - LOOP_SEC_EPSILON) continue
    result.push(segment)
    lastEndSec = segment.endSec
  }
  return result
}

export const normalizeMixtapeTrackLoopSegment = (
  value: unknown,
  baseDurationSec?: number
): MixtapeTrackLoopSegment | undefined =>
  normalizeMixtapeTrackLoopSegments(value, baseDurationSec)[0]

export const buildMixtapeTrackLoopSignature = (value: unknown) => {
  const loops = normalizeMixtapeTrackLoopSegments(value)
  if (!loops.length) return 'none'
  return loops
    .map((loop) => {
      const key = buildMixtapeTrackLoopSegmentKey(loop)
      return `${key}:${Math.max(1, Math.floor(loop.repeatCount))}`
    })
    .join('|')
}

export const resolveMixtapeTrackLoopLength = (value: MixtapeTrackLoopSegment | undefined) => {
  if (!value) return 0
  return Math.max(0, Number((value.endSec - value.startSec).toFixed(4)) || 0)
}

export const resolveMixtapeTrackLoopExtraDuration = (value: unknown) => {
  const loops = normalizeMixtapeTrackLoopSegments(value)
  return loops.reduce((sum, loop) => {
    const loopLength = resolveMixtapeTrackLoopLength(loop)
    if (loopLength <= LOOP_SEC_EPSILON) return sum
    return Number((sum + loopLength * Math.max(0, Math.floor(loop.repeatCount))).toFixed(4))
  }, 0)
}

export const resolveMixtapeTrackTimelineDuration = (baseDurationSec: number, value: unknown) => {
  const safeBaseDuration = Math.max(0, Number(baseDurationSec) || 0)
  const extraDuration = resolveMixtapeTrackLoopExtraDuration(value)
  return Number((safeBaseDuration + extraDuration).toFixed(4))
}

export const buildMixtapeTrackLoopSections = (
  baseDurationSec: number,
  value: unknown
): MixtapeTrackLoopSection[] => {
  const safeBaseDuration = Math.max(0, Number(baseDurationSec) || 0)
  const loops = normalizeMixtapeTrackLoopSegments(value, safeBaseDuration)
  if (!loops.length) {
    return [
      {
        key: 'full',
        loopKey: null,
        kind: 'head',
        displayStartSec: 0,
        displayEndSec: safeBaseDuration,
        baseStartSec: 0,
        baseEndSec: safeBaseDuration,
        repeatIndex: 0
      }
    ]
  }

  const sections: MixtapeTrackLoopSection[] = []
  let baseCursorSec = 0
  let displayCursorSec = 0

  loops.forEach((loop, loopIndex) => {
    const loopKey = buildMixtapeTrackLoopSegmentKey(loop)
    if (loop.startSec > baseCursorSec + LOOP_SEC_EPSILON) {
      const plainLength = loop.startSec - baseCursorSec
      sections.push({
        key: loopIndex === 0 ? 'head' : `tail-gap-${loopIndex}`,
        loopKey: null,
        kind: loopIndex === 0 ? 'head' : 'tail',
        displayStartSec: roundSec(displayCursorSec),
        displayEndSec: roundSec(displayCursorSec + plainLength),
        baseStartSec: roundSec(baseCursorSec),
        baseEndSec: roundSec(loop.startSec),
        repeatIndex: 0
      })
      displayCursorSec += plainLength
    }

    const loopLength = resolveMixtapeTrackLoopLength(loop)
    sections.push({
      key: `${loopKey}:source`,
      loopKey,
      kind: 'loop-source',
      displayStartSec: roundSec(displayCursorSec),
      displayEndSec: roundSec(displayCursorSec + loopLength),
      baseStartSec: loop.startSec,
      baseEndSec: loop.endSec,
      repeatIndex: 0
    })
    displayCursorSec += loopLength

    for (let repeatIndex = 1; repeatIndex <= loop.repeatCount; repeatIndex += 1) {
      sections.push({
        key: `${loopKey}:repeat:${repeatIndex}`,
        loopKey,
        kind: 'loop-repeat',
        displayStartSec: roundSec(displayCursorSec),
        displayEndSec: roundSec(displayCursorSec + loopLength),
        baseStartSec: loop.startSec,
        baseEndSec: loop.endSec,
        repeatIndex
      })
      displayCursorSec += loopLength
    }

    baseCursorSec = loop.endSec
  })

  if (baseCursorSec < safeBaseDuration - LOOP_SEC_EPSILON) {
    sections.push({
      key: 'tail',
      loopKey: null,
      kind: 'tail',
      displayStartSec: roundSec(displayCursorSec),
      displayEndSec: roundSec(displayCursorSec + (safeBaseDuration - baseCursorSec)),
      baseStartSec: roundSec(baseCursorSec),
      baseEndSec: roundSec(safeBaseDuration),
      repeatIndex: 0
    })
  }

  return sections
}

const mapDisplayLocalToBaseLocalFromSections = (
  localSec: number,
  baseDurationSec: number,
  sections: MixtapeTrackLoopSection[]
) => {
  const safeBaseDuration = Math.max(0, Number(baseDurationSec) || 0)
  const safeLocalSec = clampNumber(
    Number(localSec) || 0,
    0,
    resolveMixtapeTrackTimelineDuration(
      safeBaseDuration,
      sections
        .filter((section) => section.loopKey && section.kind === 'loop-source')
        .map((section) => ({
          startSec: section.baseStartSec,
          endSec: section.baseEndSec,
          repeatCount: sections.filter(
            (candidate) => candidate.loopKey === section.loopKey && candidate.kind === 'loop-repeat'
          ).length
        }))
    )
  )
  const matchedSection = sections.find(
    (section) =>
      safeLocalSec >= section.displayStartSec - LOOP_SEC_EPSILON &&
      safeLocalSec <= section.displayEndSec + LOOP_SEC_EPSILON
  )
  if (!matchedSection) return roundSec(clampNumber(safeLocalSec, 0, safeBaseDuration))
  const deltaSec = clampNumber(
    safeLocalSec - matchedSection.displayStartSec,
    0,
    matchedSection.baseEndSec - matchedSection.baseStartSec
  )
  return roundSec(clampNumber(matchedSection.baseStartSec + deltaSec, 0, safeBaseDuration))
}

export const mapLoopedTrackLocalToBaseLocal = (
  localSec: number,
  baseDurationSec: number,
  value: unknown
) => {
  const sections = buildMixtapeTrackLoopSections(baseDurationSec, value)
  return mapDisplayLocalToBaseLocalFromSections(localSec, baseDurationSec, sections)
}

export const mapBaseTrackLocalToFirstLoopedLocal = (
  baseLocalSec: number,
  baseDurationSec: number,
  value: unknown
) => {
  const safeBaseDuration = Math.max(0, Number(baseDurationSec) || 0)
  const safeBaseLocalSec = clampNumber(Number(baseLocalSec) || 0, 0, safeBaseDuration)
  const sections = buildMixtapeTrackLoopSections(safeBaseDuration, value)
  for (const section of sections) {
    if (
      safeBaseLocalSec >= section.baseStartSec - LOOP_SEC_EPSILON &&
      safeBaseLocalSec <= section.baseEndSec + LOOP_SEC_EPSILON
    ) {
      const deltaSec = clampNumber(
        safeBaseLocalSec - section.baseStartSec,
        0,
        section.baseEndSec - section.baseStartSec
      )
      return roundSec(section.displayStartSec + deltaSec)
    }
  }
  return roundSec(safeBaseLocalSec)
}

export const resolveMixtapeTrackLoopTileSections = (params: {
  localStartSec: number
  localEndSec: number
  baseDurationSec: number
  loopSegment?: MixtapeTrackLoopSegment
  loopSegments?: MixtapeTrackLoopSegment[]
}) => {
  const localStartSec = Math.max(0, Number(params.localStartSec) || 0)
  const localEndSec = Math.max(localStartSec, Number(params.localEndSec) || 0)
  const loopValue =
    Array.isArray(params.loopSegments) && params.loopSegments.length
      ? params.loopSegments
      : params.loopSegment
  const sections = buildMixtapeTrackLoopSections(params.baseDurationSec, loopValue)
  return sections
    .map((section) => {
      const overlapStartSec = Math.max(localStartSec, section.displayStartSec)
      const overlapEndSec = Math.min(localEndSec, section.displayEndSec)
      if (overlapEndSec - overlapStartSec <= LOOP_SEC_EPSILON) return null
      const sectionOffsetSec = overlapStartSec - section.displayStartSec
      return {
        ...section,
        displayStartSec: roundSec(overlapStartSec),
        displayEndSec: roundSec(overlapEndSec),
        baseStartSec: roundSec(section.baseStartSec + sectionOffsetSec),
        baseEndSec: roundSec(
          section.baseStartSec + sectionOffsetSec + (overlapEndSec - overlapStartSec)
        )
      }
    })
    .filter((section): section is MixtapeTrackLoopSection => !!section)
}

export const expandVisibleGridLinesByTrackLoop = (
  baseLines: SerializedVisibleGridLine[],
  baseDurationSec: number,
  value: unknown
) => {
  const sections = buildMixtapeTrackLoopSections(baseDurationSec, value)
  if (!Array.isArray(baseLines) || !baseLines.length) return []
  const expanded: SerializedVisibleGridLine[] = []
  for (const line of baseLines) {
    const lineSec = Number(line?.sec)
    if (!Number.isFinite(lineSec)) continue
    for (const section of sections) {
      if (
        lineSec < section.baseStartSec - LOOP_SEC_EPSILON ||
        lineSec > section.baseEndSec + LOOP_SEC_EPSILON
      ) {
        continue
      }
      expanded.push({
        sec: roundSec(section.displayStartSec + (lineSec - section.baseStartSec)),
        sourceSec: Number(line.sourceSec) || 0,
        level: line.level
      })
    }
  }
  expanded.sort((left, right) => left.sec - right.sec)
  return expanded.filter((line, index) => {
    const previous = expanded[index - 1]
    if (!previous) return true
    return (
      Math.abs(previous.sec - line.sec) > LOOP_SEC_EPSILON ||
      previous.level !== line.level ||
      Math.abs(previous.sourceSec - line.sourceSec) > LOOP_SEC_EPSILON
    )
  })
}

export const expandMuteSegmentsByTrackLoop = (
  baseSegments: MixtapeMuteSegment[] | undefined,
  baseDurationSec: number,
  value: unknown
) => {
  const segments = Array.isArray(baseSegments) ? baseSegments : []
  const sections = buildMixtapeTrackLoopSections(baseDurationSec, value)
  if (!segments.length) return []
  const expanded: MixtapeMuteSegment[] = []
  for (const segment of segments) {
    const startSec = Number(segment?.startSec)
    const endSec = Number(segment?.endSec)
    if (
      !Number.isFinite(startSec) ||
      !Number.isFinite(endSec) ||
      endSec - startSec <= LOOP_SEC_EPSILON
    ) {
      continue
    }
    for (const section of sections) {
      const overlapStartSec = Math.max(section.baseStartSec, startSec)
      const overlapEndSec = Math.min(section.baseEndSec, endSec)
      if (overlapEndSec - overlapStartSec <= LOOP_SEC_EPSILON) continue
      expanded.push({
        startSec: roundSec(section.displayStartSec + (overlapStartSec - section.baseStartSec)),
        endSec: roundSec(section.displayStartSec + (overlapEndSec - section.baseStartSec))
      })
    }
  }
  expanded.sort((left, right) => left.startSec - right.startSec)
  return expanded.filter((segment, index) => {
    const previous = expanded[index - 1]
    if (!previous) return true
    return (
      Math.abs(previous.startSec - segment.startSec) > LOOP_SEC_EPSILON ||
      Math.abs(previous.endSec - segment.endSec) > LOOP_SEC_EPSILON
    )
  })
}
